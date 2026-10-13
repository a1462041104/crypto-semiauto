const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const publicDir = path.join(__dirname, 'public');

// Ensure public dir exists
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Binance API Base URLs with resilient fallback
const BINANCE_BASE_URLS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://data-api.binance.vision'
];

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.url.startsWith('/api/')) {
    res.header('Content-Type', 'application/json; charset=utf-8');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());
app.use(express.static(publicDir));

// In-Memory Cache with TTL
const cache = new Map();
const CACHE_TTL_MS = 1500;

function getCached(key, customTtl) {
  const cached = cache.get(key);
  const ttl = customTtl !== undefined ? customTtl : CACHE_TTL_MS;
  if (cached && (Date.now() - cached.timestamp < ttl)) {
    return cached.data;
  }
  return null;
}

function setCached(key, data) {
  cache.set(key, { timestamp: Date.now(), data });
}

function normalizeSymbol(symbol) {
  let sym = (symbol || '').toUpperCase().trim();
  if (!sym.endsWith('USDT') && !sym.endsWith('BUSD') && !sym.endsWith('USDC') && !sym.endsWith('BTC')) {
    sym += 'USDT';
  }
  return sym;
}

// Resilient Binance Fetcher
async function fetchWithFallback(pathAndQuery) {
  let lastError = null;
  for (const baseUrl of BINANCE_BASE_URLS) {
    try {
      const url = `${baseUrl}${pathAndQuery}`;
      const controller = new (global.AbortController || require('abort-controller'))();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        return await res.json();
      }
      lastError = new Error(`Status ${res.status}: ${await res.text()}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('All Binance endpoints failed');
}

async function fetchBinancePrice(symbol) {
  const normalized = normalizeSymbol(symbol);
  const cacheKey = `price:${normalized}`;
  const cached = getCached(cacheKey, 800);
  if (cached) return cached;

  const data = await fetchWithFallback(`/api/v3/ticker/price?symbol=${normalized}`);
  const parsed = {
    symbol: data.symbol,
    price: parseFloat(data.price)
  };
  setCached(cacheKey, parsed);
  return parsed;
}

// Aggregates strictly aligned 5m candles into 10m candles
function aggregateKlinesTo10m(klines5m) {
  if (!Array.isArray(klines5m) || !klines5m.length) return [];
  const aggregated = [];
  let i = 0;
  while (i < klines5m.length) {
    const d = new Date(klines5m[i].openTime);
    if (d.getMinutes() % 10 === 0) break;
    i++;
  }
  for (; i < klines5m.length; i++) {
    const k0 = klines5m[i];
    const k1 = klines5m[i + 1];
    if (k1 && (k1.openTime === k0.openTime + 5 * 60 * 1000)) {
      aggregated.push({
        openTime: k0.openTime,
        open: k0.open,
        high: Math.max(k0.high, k1.high),
        low: Math.min(k0.low, k1.low),
        close: k1.close,
        volume: Number((k0.volume + k1.volume).toFixed(4)),
        closeTime: k1.closeTime
      });
      i++;
    } else {
      aggregated.push({
        openTime: k0.openTime,
        open: k0.open,
        high: k0.high,
        low: k0.low,
        close: k0.close,
        volume: Number(k0.volume.toFixed(4)),
        closeTime: k0.openTime + 10 * 60 * 1000 - 1
      });
    }
  }
  return aggregated;
}

async function fetchBinanceKlines(symbol, interval = '1m', limit = 150) {
  const normalized = normalizeSymbol(symbol);

  if (interval === '10m') {
    const raw5m = await fetchBinanceKlines(symbol, '5m', Math.min(limit * 2 + 10, 1000));
    const aggregated = aggregateKlinesTo10m(raw5m);
    return aggregated.slice(-limit);
  }

  const cacheKey = `uiklines:${normalized}:${interval}:${limit}`;
  const cached = getCached(cacheKey, 2500);
  if (cached) return cached;

  let rawKlines;
  try {
    rawKlines = await fetchWithFallback(`/api/v3/uiKlines?symbol=${normalized}&interval=${interval}&limit=${limit}`);
  } catch (err) {
    rawKlines = await fetchWithFallback(`/api/v3/klines?symbol=${normalized}&interval=${interval}&limit=${limit}`);
  }

  const formatted = rawKlines.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7] || 0),
    trades: k[8] || 0,
    takerBuyVolume: parseFloat(k[9] || 0)
  }));

  setCached(cacheKey, formatted);
  return formatted;
}

// ==========================================
// TECHNICAL INDICATORS & QUANT MATHEMATICS
// ==========================================

function roundTo(val, decimals = 2) {
  if (isNaN(val) || val === null || val === undefined) return 0;
  return Number(val.toFixed(decimals));
}

// Strict Beijing Time (UTC+8) Formatter
function formatBeijingTime(timestamp, includeDate = false) {
  if (!timestamp) return '';
  const ms = timestamp < 1e11 ? timestamp * 1000 : Number(timestamp);
  if (isNaN(ms)) return '';
  const bj = new Date(ms + 8 * 3600 * 1000);
  const ho = String(bj.getUTCHours()).padStart(2, '0');
  const mi = String(bj.getUTCMinutes()).padStart(2, '0');
  const se = String(bj.getUTCSeconds()).padStart(2, '0');
  if (includeDate) {
    const mo = String(bj.getUTCMonth() + 1).padStart(2, '0');
    const da = String(bj.getUTCDate()).padStart(2, '0');
    return `${mo}-${da} ${ho}:${mi}:${se}`;
  }
  return `${ho}:${mi}:${se}`;
}

// ==========================================
// QUANT INDICATOR LIBRARY (v2 分析核心)
// ==========================================

function clampNum(val, min, max) {
  if (isNaN(val) || val === null || val === undefined) return min;
  return Math.max(min, Math.min(max, val));
}

// EMA 序列 (标准递推, 种子为首值)
function emaSeries(values, period) {
  if (!values || !values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

// Wilder RSI (返回当前值与上一值, 用于动量方向判断)
function calcRSIWilder(closes, period = 14) {
  if (!closes || closes.length <= period) return { current: 50, prev: 50 };
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsiOf = (ag, al) => (al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  let prev = rsiOf(avgGain, avgLoss);
  let current = prev;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
    prev = current;
    current = rsiOf(avgGain, avgLoss);
  }
  return { current, prev };
}

// Wilder ATR
function calcATR(klines, period = 14) {
  const n = klines.length;
  if (n < period + 2) return { atr: 0, trs: [] };
  const trs = [];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return { atr, trs };
}

// 由 TR 序列推导 Wilder ATR 历史序列 (用于波动率扩张倍数)
function atrSeriesFromTRs(trs, period = 14) {
  if (!trs || trs.length < period) return [];
  const out = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out.push(atr);
  }
  return out;
}

// 分位排名: 当前值在历史序列中的百分位 (0-100)
function percentileRank(series, value) {
  if (!series || !series.length || value == null) return 50;
  let below = 0;
  for (const v of series) if (v < value) below++;
  return (below / series.length) * 100;
}

// KC - Keltner Channels (走势判断用: EMA20中轨 + TR的EMA(10)平滑 + 倍数1.0)
// 参数: EMA周期20 / ATR周期10(EMA平滑) / ATR倍数1
function calculateKC(klines, emaPeriod = 20, atrPeriod = 10, multiplier = 1.0) {
  const n = klines.length;
  if (n < Math.max(emaPeriod, atrPeriod)) {
    const lastClose = klines[n - 1] ? klines[n - 1].close : 0;
    return { middle: lastClose, upper: lastClose * 1.01, lower: lastClose * 0.99, atr: lastClose * 0.01 };
  }

  // 中轨: EMA20 (标准递推, 150根数据后与前端 calcEMA 差异可忽略)
  const closes = klines.map(k => k.close);
  const emaArr = emaSeries(closes, emaPeriod);
  const ema = emaArr[n - 1];

  // ATR: TR 序列的 EMA(atrPeriod) 平滑 (与前端 calcKC 的 calcEMA(trs, period) 一致)
  const trs = [klines[0].high - klines[0].low];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    ));
  }
  const atrArr = emaSeries(trs, atrPeriod);
  const atr = atrArr[atrArr.length - 1];

  return {
    middle: ema,
    upper: ema + multiplier * atr,
    lower: ema - multiplier * atr,
    atr
  };
}

// Wilder ADX + DI (趋势强度与方向)
function calcADX(klines, period = 14) {
  const n = klines.length;
  if (n < period * 2 + 2) return { adx: 0, plusDI: 0, minusDI: 0 };
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < n; i++) {
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    ));
  }
  let tr = 0, pDM = 0, mDM = 0;
  for (let i = 0; i < period; i++) { tr += trs[i]; pDM += plusDMs[i]; mDM += minusDMs[i]; }
  let plusDI = tr > 0 ? (100 * pDM / tr) : 0;
  let minusDI = tr > 0 ? (100 * mDM / tr) : 0;
  const dxs = [(plusDI + minusDI) > 0 ? (100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI)) : 0];
  for (let i = period; i < trs.length; i++) {
    tr = tr - tr / period + trs[i];
    pDM = pDM - pDM / period + plusDMs[i];
    mDM = mDM - mDM / period + minusDMs[i];
    plusDI = tr > 0 ? (100 * pDM / tr) : 0;
    minusDI = tr > 0 ? (100 * mDM / tr) : 0;
    dxs.push((plusDI + minusDI) > 0 ? (100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI)) : 0);
  }
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }
  return { adx, plusDI, minusDI };
}

// MACD (12, 26, 9) 柱方向
function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!closes || closes.length < slow + signalPeriod + 2) {
    return { hist: 0, prevHist: 0, macd: 0, signal: 0 };
  }
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = emaSeries(macdLine, signalPeriod);
  const lastIdx = macdLine.length - 1;
  return {
    hist: macdLine[lastIdx] - signalLine[lastIdx],
    prevHist: macdLine[lastIdx - 1] - signalLine[lastIdx - 1],
    macd: macdLine[lastIdx],
    signal: signalLine[lastIdx]
  };
}

// Bollinger Bands (20, 2)
function calcBollinger(klines, period = 20, mult = 2) {
  const sub = klines.slice(-period);
  if (sub.length < period) return null;
  const mid = sub.reduce((s, k) => s + k.close, 0) / period;
  const variance = sub.reduce((s, k) => s + (k.close - mid) * (k.close - mid), 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mid + mult * sd, middle: mid, lower: mid - mult * sd, bandwidth: mid > 0 ? (4 * sd) / mid : 0 };
}

// 量价分析: 量比 + 主动买入占比 (taker buy 失衡)
// volRatioAdj: 按“当前K线已进行时间比例”归一化的量比 (K线刚开启时原值会极低, 必须归一化)
function calcVolumeProfile(klines, period = 20, nowMs = Date.now()) {
  const n = klines.length;
  if (n < period + 2) return { volRatio: 1, volRatioAdj: 1, takerBuyRatio: 0.5, avgVol: 0, curVol: 0, elapsedFrac: 1 };
  const sub = klines.slice(-period - 1, -1);
  const avgVol = sub.reduce((s, k) => s + k.volume, 0) / period;
  const last = klines[n - 1];
  const volRatio = avgVol > 0 ? last.volume / avgVol : 1;
  const intervalMs = n >= 2 && klines[n - 2].openTime ? (last.openTime - klines[n - 2].openTime) : 60000;
  const elapsedFrac = intervalMs > 0 ? clampNum((nowMs - last.openTime) / intervalMs, 0.05, 1) : 1;
  const paceVol = avgVol * elapsedFrac;
  const volRatioAdj = paceVol > 0 ? last.volume / paceVol : volRatio;
  const takerBuyRatio = last.volume > 0 ? clampNum(last.takerBuyVolume / last.volume, 0, 1) : 0.5;
  return { volRatio, volRatioAdj, takerBuyRatio, avgVol, curVol: last.volume, elapsedFrac };
}

// 市场结构识别 (半窗对比法, 对单边趋势/震荡都稳健):
//   后半窗高低点 > 前半窗 -> HH-HL (多头结构)
//   后半窗高低点 < 前半窗 -> LH-LL (空头结构)
//   否则 -> mixed
// lastSwingHigh/Low 取近10根极值, 作为“突破前高/破位前低”的参照位
function calcSwingStructure(klines, lookback = 48) {
  const sub = klines.slice(-lookback);
  if (sub.length < 12) return null;
  const half = Math.floor(sub.length / 2);
  const first = sub.slice(0, half);
  const second = sub.slice(half);
  const maxHigh = arr => arr.reduce((m, c) => Math.max(m, c.high), -Infinity);
  const minLow = arr => arr.reduce((m, c) => Math.min(m, c.low), Infinity);

  const fh = maxHigh(first), fl = minLow(first);
  const sh = maxHigh(second), sl = minLow(second);

  let pattern = 'mixed';
  if (sh > fh && sl > fl) pattern = 'HH-HL';
  else if (sh < fh && sl < fl) pattern = 'LH-LL';

  const recent = sub.slice(-10);
  return {
    pattern,
    higherHigh: sh > fh,
    higherLow: sl > fl,
    lastSwingHigh: maxHigh(recent),
    lastSwingLow: minLow(recent),
    recentHigh: maxHigh(sub),
    recentLow: minLow(sub)
  };
}

// ==========================================
// SEMI-AUTO STRATEGY ENGINE & SIGNAL SYSTEM
// ==========================================

// Config persistence file
const SEMIAUTO_CONFIG_FILE = path.join(__dirname, 'semiauto_config.json');
const SEMIAUTO_SIGNALS_FILE = path.join(__dirname, 'semiauto_live_signals.json');

let semiautoConfig = {
  direction: 'BULL', // 'BULL' | 'BEAR' | 'RANGE'
  updatedAt: Date.now()
};

function loadSemiautoConfig() {
  try {
    if (fs.existsSync(SEMIAUTO_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEMIAUTO_CONFIG_FILE, 'utf8'));
      if (data && data.direction) {
        semiautoConfig = {
          direction: data.direction,
          updatedAt: data.updatedAt || Date.now()
        };
      }
    }
  } catch (e) {}
}

function saveSemiautoConfig() {
  try {
    fs.writeFile(SEMIAUTO_CONFIG_FILE, JSON.stringify(semiautoConfig, null, 2), 'utf8', () => {});
  } catch (e) {}
}

loadSemiautoConfig();

// In-Memory Live Signals Storage (NEVER retroactively backfilled from history)
// Structured as: { [symbol]: { '3m': [...], '5m': [...], '10m': [...] } }
let signalRegistry = {
  BTCUSDT: { '3m': [], '5m': [], '10m': [] },
  ETHUSDT: { '3m': [], '5m': [], '10m': [] }
};

function loadLiveSignals() {
  try {
    if (fs.existsSync(SEMIAUTO_SIGNALS_FILE)) {
      const raw = fs.readFileSync(SEMIAUTO_SIGNALS_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        ['BTCUSDT', 'ETHUSDT'].forEach(sym => {
          if (data[sym]) {
            ['3m', '5m', '10m'].forEach(tf => {
              if (Array.isArray(data[sym][tf])) {
                signalRegistry[sym][tf] = data[sym][tf];
              }
            });
          }
        });
      }
    }
  } catch (e) {}
}

function saveLiveSignals() {
  try {
    pruneSignalRegistry();
    fs.writeFile(SEMIAUTO_SIGNALS_FILE, JSON.stringify(signalRegistry, null, 2), 'utf8', (err) => {
      if (err) console.error('[SIGNALS SAVE ERROR]', err);
    });
  } catch (e) {
    console.error('[SIGNALS SAVE ERROR]', e);
  }
}

loadLiveSignals();

const TIMEFRAME_CONFIGS = {
  '3m': { candleInterval: '3m', durationMs: 3 * 60 * 1000, cooldownMs: 180 * 1000 },
  '5m': { candleInterval: '5m', durationMs: 5 * 60 * 1000, cooldownMs: 300 * 1000 },
  '10m': { candleInterval: '10m', durationMs: 10 * 60 * 1000, cooldownMs: 600 * 1000 }
};

// ==========================================
// MARKET DATA STORE & ANALYSIS STATE (v2)
// ==========================================
const ANALYSIS_TFS = ['1m', '3m', '5m', '15m', '1h'];
const FAST_REFRESH_TFS = ['1m', '3m', '5m'];   // 每 3s 刷新 (入场周期 + 1m 确认周期)
const SLOW_REFRESH_TFS = ['15m', '1h'];        // 每 15s 刷新 (大周期方向)

// klineStore[symbol][tf] = { klines, updatedAt }
const klineStore = { BTCUSDT: {}, ETHUSDT: {} };

// marketViews[symbol] = { tfs: {tf: metrics}, systemBias, higherBias, updatedAt }
const marketViews = { BTCUSDT: null, ETHUSDT: null };

// 入场确认状态机: entryState[symbol][tf] = { phase:'ARMED', zone, side, armedAt, refLow, refHigh }
const entryState = {
  BTCUSDT: { '3m': null, '5m': null, '10m': null },
  ETHUSDT: { '3m': null, '5m': null, '10m': null }
};

// 策略表现记忆 (仅用于自适应冷却; 已删除默认连亏暂停)
function emptyPerfMap() {
  return {
    '3m': { lastResult: null },
    '5m': { lastResult: null },
    '10m': { lastResult: null }
  };
}
const perfMemory = { BTCUSDT: emptyPerfMap(), ETHUSDT: emptyPerfMap() };

// 结算完整性: 超过该时限仍未结算的信号判为作废 (不计入胜率, 修复停机后按现价乱结算的问题)
const STALE_SETTLE_MS = 90 * 1000;
// 单币种跨周期并发挂单上限
const MAX_PENDING_PER_SYMBOL = 6;
// 波动率熔断: ATR 相对近90根中位数扩张超过该倍数时暂停开仓 (防巨波动后追单)
const VOL_BREAKER_ATR_RATIO = 2.2;
// ARMED 布防有效期: 超时未确认则放弃
const ARM_TIMEOUT_MS = 75 * 1000;
// 信号记录裁剪上限 (每币种每周期)
const SIGNAL_MAX_PER_TF = 500;

function pruneSignalRegistry() {
  for (const sym of Object.keys(signalRegistry)) {
    for (const tf of Object.keys(signalRegistry[sym])) {
      const list = signalRegistry[sym][tf];
      if (Array.isArray(list) && list.length > SIGNAL_MAX_PER_TF) {
        signalRegistry[sym][tf] = list.slice(-SIGNAL_MAX_PER_TF);
      }
    }
  }
}

let saveSignalsTimer = null;
function scheduleSaveSignals() {
  if (saveSignalsTimer) return;
  saveSignalsTimer = setTimeout(() => {
    saveSignalsTimer = null;
    saveLiveSignals();
  }, 2000);
}

// ==========================================
// 多周期指标计算与客观趋势评估
// ==========================================

// 单周期指标集合
function computeTfMetrics(klines) {
  if (!klines || klines.length < 30) return null;
  const closes = klines.map(k => k.close);
  const n = klines.length;
  const last = klines[n - 1];

  const ema9s = emaSeries(closes, 9);
  const ema21s = emaSeries(closes, 21);
  const ema50s = emaSeries(closes, 50);
  const ema9 = ema9s[n - 1], ema21 = ema21s[n - 1], ema50 = ema50s[n - 1];
  const ema21Prev5 = ema21s[Math.max(0, n - 6)];

  const rsiObj = calcRSIWilder(closes, 14);
  const atrObj = calcATR(klines, 14);
  const atr = atrObj.atr > 0 ? atrObj.atr : last.close * 0.001;
  const lastTR = atrObj.trs.length ? atrObj.trs[atrObj.trs.length - 1] : atr;
  const atrPct = percentileRank(atrObj.trs.slice(-90), lastTR);
  // 波动率扩张倍数: 当前ATR / 近90根 Wilder ATR 的中位数
  // (趋势行情中 ATR 分位会恒高, 用中位数倍数才能识别“真正的波动率爆炸”)
  const atrHist = atrSeriesFromTRs(atrObj.trs, 14).slice(-90);
  const atrMedian = atrHist.length ? atrHist.slice().sort((a, b) => a - b)[Math.floor(atrHist.length / 2)] : atr;
  const atrRatio = atrMedian > 0 ? atr / atrMedian : 1;
  const adxObj = calcADX(klines, 14);
  const macdObj = calcMACD(closes, 12, 26, 9);
  const kc = calculateKC(klines, 20, 10, 1.0);
  const bb = calcBollinger(klines, 20, 2);
  const vol = calcVolumeProfile(klines, 20);
  const swing = calcSwingStructure(klines, 48);

  return {
    tf: null,
    open: last.open, close: last.close, openTime: last.openTime,
    ema9, ema21, ema50,
    ema21SlopeAtr: (ema21 - ema21Prev5) / atr,
    rsi: rsiObj.current, rsiPrev: rsiObj.prev,
    atr, atrPct, atrRatio,
    adx: adxObj.adx, plusDI: adxObj.plusDI, minusDI: adxObj.minusDI,
    macdHist: macdObj.hist, macdPrevHist: macdObj.prevHist,
    kc, bb, vol, swing,
    squeeze: !!(bb && kc && bb.upper < kc.upper && bb.lower > kc.lower)
  };
}

// 单周期客观趋势评分 [-60, +60] (正值偏多)
function tfTrendScore(m) {
  if (!m) return 0;
  let s = 0;
  s += m.close > m.ema9 ? 6 : -6;
  s += m.ema9 > m.ema21 ? 8 : -8;
  s += m.ema21 > m.ema50 ? 10 : -10;
  s += clampNum(m.ema21SlopeAtr * 6, -14, 14);
  const diSign = Math.sign(m.plusDI - m.minusDI);
  s += diSign * clampNum((m.adx - 18) * 0.9, -12, 12);
  if (m.swing) {
    if (m.swing.pattern === 'HH-HL') s += 8;
    else if (m.swing.pattern === 'LH-LL') s -= 8;
  }
  s += clampNum((m.rsi - 50) * 0.12, -5, 5);
  return clampNum(s, -60, 60);
}

// 汇总多周期市场视图: systemBias (全周期) + higherBias (15m/1h 大周期)
function computeMarketView(symbol) {
  const store = klineStore[symbol] || {};
  const tfs = {};
  for (const tf of ANALYSIS_TFS) {
    const entry = store[tf];
    if (entry && entry.klines && entry.klines.length >= 30) {
      const metrics = computeTfMetrics(entry.klines);
      if (metrics) { metrics.tf = tf; tfs[tf] = metrics; }
    }
  }
  const sc = (tf) => tfTrendScore(tfs[tf]);
  const systemBias = clampNum(
    0.45 * sc('1h') + 0.30 * sc('15m') + 0.15 * sc('5m') + 0.10 * sc('3m'), -100, 100);
  const higherBias = clampNum(0.6 * sc('1h') + 0.4 * sc('15m'), -100, 100);
  marketViews[symbol] = { tfs, systemBias, higherBias, updatedAt: Date.now() };
  return marketViews[symbol];
}

// 市场数据刷新: 拉取指定周期 K 线并入库
async function refreshKlinesFor(symbol, tf) {
  const limit = tf === '1m' ? 120 : (tf === '1h' ? 90 : 100);
  const klines = await fetchBinanceKlines(symbol, tf, limit);
  if (klines && klines.length) {
    klineStore[symbol][tf] = { klines, updatedAt: Date.now() };
    return true;
  }
  return false;
}

// ==========================================
// ENTRY ZONE DETECTION (高价值入场区域)
// 用户锁定 12h 方向后, 引擎只在“值得进场的位置”布防:
//   趋势回踩 / 突破确认 / 深度价值 / 极端反向(系统否决时的保护单)
// ==========================================
function detectEntryZones(tf, view, userDir, price) {
  const m = view.tfs[tf];
  if (!m || !m.kc || !m.swing) return [];
  const atr = m.atr;
  const zones = [];
  const higherBias = view.higherBias;

  if (userDir === 'BULL') {
    // A. 趋势回踩: EMA21 > EMA50 多头结构完好, 价格回踩 EMA21/KC中轨
    if (m.ema21 > m.ema50 && m.swing.pattern !== 'LH-LL') {
      zones.push({ kind: 'pullback', side: 'BUY', priority: 2,
        low: m.ema21 - 0.5 * atr, high: m.ema21 + 0.55 * atr,
        pattern: '【看多·趋势回踩】EMA21/KC中轨支撑企稳·多头结构完好' });
    }
    // B. 突破跟进/回踩: 前高区域放量突破或突破后回踩再上
    if (m.swing.lastSwingHigh) {
      zones.push({ kind: 'breakout', side: 'BUY', priority: 1,
        low: m.swing.lastSwingHigh - 0.35 * atr, high: m.swing.lastSwingHigh + 0.65 * atr,
        pattern: '【看多·突破确认】前高区域放量突破/回踩再上·量价共振' });
    }
    // C. 深度价值: EMA50 强支撑 + RSI 超卖 (大周期不强烈看空时才允许)
    if (higherBias > -20 && m.rsi < 42) {
      zones.push({ kind: 'deepvalue', side: 'BUY', priority: 3, threshold: 82,
        low: m.ema50 - 0.35 * atr, high: m.ema50 + 0.5 * atr,
        pattern: '【看多·深度价值】EMA50强支撑+RSI超卖·极端回调狙多' });
    }
    // D. 极端反向: 大周期强烈看空且 KC 外轨超买时的保护性做空
    if (higherBias <= -35 && m.rsi > 72 && price > m.kc.upper * 1.003) {
      zones.push({ kind: 'extreme', side: 'SELL', priority: 0, threshold: 88,
        low: m.kc.upper * 1.003, high: m.kc.upper * 1.02,
        pattern: '【看多·极端狙空】大周期强烈背离+KC外轨超买·保护性做空' });
    }
  } else if (userDir === 'BEAR') {
    // A. 趋势反弹受阻: EMA21 < EMA50 空头结构完好, 价格反弹至 EMA21/KC中轨
    if (m.ema21 < m.ema50 && m.swing.pattern !== 'HH-HL') {
      zones.push({ kind: 'pullback', side: 'SELL', priority: 2,
        low: m.ema21 - 0.55 * atr, high: m.ema21 + 0.5 * atr,
        pattern: '【看空·反弹受阻】EMA21/KC中轨承压·空头结构完好' });
    }
    // B. 破位跟进/反抽: 前低区域放量破位或破位后反抽再下
    if (m.swing.lastSwingLow) {
      zones.push({ kind: 'breakout', side: 'SELL', priority: 1,
        low: m.swing.lastSwingLow - 0.65 * atr, high: m.swing.lastSwingLow + 0.35 * atr,
        pattern: '【看空·破位确认】前低区域放量破位/反抽再下·量价共振' });
    }
    // C. 深度价值: EMA50 强阻力 + RSI 超买
    if (higherBias < 20 && m.rsi > 58) {
      zones.push({ kind: 'deepvalue', side: 'SELL', priority: 3, threshold: 82,
        low: m.ema50 - 0.5 * atr, high: m.ema50 + 0.35 * atr,
        pattern: '【看空·深度价值】EMA50强阻力+RSI超买·极端反弹狙空' });
    }
    // D. 极端反向: 大周期强烈看多且 KC 外轨超卖时的保护性做多
    if (higherBias >= 35 && m.rsi < 28 && price < m.kc.lower * 0.997) {
      zones.push({ kind: 'extreme', side: 'BUY', priority: 0, threshold: 88,
        low: m.kc.lower * 0.98, high: m.kc.lower * 0.997,
        pattern: '【看空·极端狙多】大周期强烈背离+KC外轨超卖·保护性做多' });
    }
  } else {
    // RANGE 震荡: 高抛低吸, 但要求系统无明显趋势
    const m15 = view.tfs['15m'];
    const trendTooStrong = Math.abs(view.systemBias) >= 25 || (m15 && m15.adx > 30);
    if (!trendTooStrong) {
      if (m.rsi < 38 && price <= m.kc.lower * 1.004 && price >= m.kc.lower * 0.995) {
        zones.push({ kind: 'range-low', side: 'BUY', priority: 1,
          low: m.kc.lower * 0.995, high: m.kc.lower * 1.004,
          pattern: '【震荡·下轨吸多】KC下轨+RSI超卖·支撑企稳反手多' });
      }
      if (m.rsi > 62 && price >= m.kc.upper * 0.996 && price <= m.kc.upper * 1.005) {
        zones.push({ kind: 'range-high', side: 'SELL', priority: 1,
          low: m.kc.upper * 0.996, high: m.kc.upper * 1.005,
          pattern: '【震荡·上轨抛空】KC上轨+RSI超买·阻力遇阻反手空' });
      }
    }
  }
  return zones.filter(z => price >= z.low && price <= z.high).sort((a, b) => a.priority - b.priority);
}

// ==========================================
// ARMED 确认机制: 进入区域后必须出现
//   更高低点/更低高点 + 1m动量同向 + 量能确认 + RSI不追极值
// 这是对旧系统“价格一碰阈值就开仓(追尖)”的最大修正
// ==========================================
function checkEntryConfirmation(tf, side, state, price, view) {
  const m = view.tfs[tf];
  if (!m) return { ok: false, reason: 'no-metrics' };
  const m1 = view.tfs['1m'];
  const atr = m.atr;

  // 1) 微观结构: 持仓期内已出现更高低点(多) / 更低高点(空)
  if (side === 'BUY') {
    if (!(price > state.refLow + 0.10 * atr)) return { ok: false, reason: 'wait-higher-low' };
  } else {
    if (!(price < state.refHigh - 0.10 * atr)) return { ok: false, reason: 'wait-lower-high' };
  }

  // 2) 1分钟动量方向一致 (形成中K线)
  if (m1) {
    if (side === 'BUY' && !(m1.close > m1.open)) return { ok: false, reason: 'wait-1m-bull' };
    if (side === 'SELL' && !(m1.close < m1.open)) return { ok: false, reason: 'wait-1m-bear' };
  }

  // 3) 量能确认 (按 K 线已进行时间归一化的量比)
  if (m.vol.volRatioAdj < 1.05) return { ok: false, reason: 'wait-volume' };

  // 4) 不追极值 (强趋势中 RSI 常态偏高, 硬闸门放在 78/22, 轻微超买由评分项惩罚)
  if (side === 'BUY' && m.rsi > 78) return { ok: false, reason: 'rsi-overbought' };
  if (side === 'SELL' && m.rsi < 22) return { ok: false, reason: 'rsi-oversold' };

  // 5) 反向动量狂奔时禁止接飞刀
  if (side === 'BUY' && m.macdHist < -1.6 * atr) return { ok: false, reason: 'macd-bear-impulse' };
  if (side === 'SELL' && m.macdHist > 1.6 * atr) return { ok: false, reason: 'macd-bull-impulse' };

  return { ok: true };
}

// ==========================================
// 0-100 入场质量评分: 低于阈值坚决不开仓
// ==========================================
function scoreEntrySetup(tf, side, zone, view, price) {
  const m = view.tfs[tf];
  const factors = [];
  const add = (label, got, max) => factors.push({ label, score: Math.round(got * 10) / 10, max });

  // 1. 大周期共振 (15m/1h 客观趋势是否支持该方向) 0-25
  const biasForSide = side === 'BUY' ? view.higherBias : -view.higherBias;
  add('大周期共振(15m/1h)', clampNum((biasForSide + 30) / 60, 0, 1) * 25, 25);

  // 2. 本周期趋势质量 (EMA排列+ADX+斜率) 0-20
  const tfScore = side === 'BUY' ? tfTrendScore(m) : -tfTrendScore(m);
  add('本周期趋势质量', clampNum((tfScore + 20) / 60, 0, 1) * 20, 20);

  // 3. 市场结构 (HH/HL 或 LH/LL) 0-15
  let struct = 3;
  if (m.swing) {
    if (side === 'BUY' && m.swing.pattern === 'HH-HL') struct = 15;
    else if (side === 'SELL' && m.swing.pattern === 'LH-LL') struct = 15;
    else if (m.swing.pattern === 'mixed') struct = 7;
  }
  if (zone.kind === 'breakout') {
    struct = Math.max(struct, side === 'BUY' ? (m.swing.higherHigh ? 14 : 8) : (m.swing.higherHigh === false ? 14 : 8));
  }
  add('市场结构', struct, 15);

  // 4. 量价确认 (归一化量比 + 主动买入占比) 0-15
  let volScore = clampNum((m.vol.volRatioAdj - 1.0) / 0.6, 0, 1) * 11;
  const tb = m.vol.takerBuyRatio;
  if (side === 'BUY' && tb > 0.53) volScore += clampNum((tb - 0.5) * 40, 0, 4);
  if (side === 'SELL' && tb < 0.47) volScore += clampNum((0.5 - tb) * 40, 0, 4);
  add('量价确认', Math.min(15, volScore), 15);

  // 5. 动量健康 (RSI 区间 + MACD 柱方向) 0-10
  let mom;
  if (side === 'BUY') mom = (m.rsi >= 45 && m.rsi <= 66) ? 10 : (m.rsi >= 38 && m.rsi <= 72 ? 6 : 2);
  else mom = (m.rsi <= 55 && m.rsi >= 34) ? 10 : (m.rsi <= 62 && m.rsi >= 28 ? 6 : 2);
  if ((side === 'BUY' && m.macdHist > m.macdPrevHist) || (side === 'SELL' && m.macdHist < m.macdPrevHist)) {
    mom = Math.min(10, mom + 2);
  }
  add('动量健康(RSI/MACD)', mom, 10);

  // 6. 入场位置价值 (距 EMA21 的 ATR 距离, 不追远) 0-10
  const distAtr = Math.abs(price - m.ema21) / m.atr;
  let loc = distAtr <= 0.8 ? 10 : (distAtr <= 1.4 ? 6 : 2);
  if (['deepvalue', 'range-low', 'range-high', 'extreme'].includes(zone.kind)) loc = Math.max(loc, 8);
  add('入场位置价值', loc, 10);

  // 7. 波动率环境 (ATR 扩张倍数处于可交易区间) 0-5
  add('波动率环境', (m.atrRatio >= 0.7 && m.atrRatio <= 1.8) ? 5 : 2, 5);

  const total = factors.reduce((s, f) => s + f.score, 0);
  return { score: Math.round(total), factors };
}

// 自适应冷却: 连败后拉长冷却, 胜单后适度加密
function adaptiveCooldownMs(baseMs, perf) {
  if (!perf) return baseMs;
  let mult = 1;
  if (perf.lastResult === 'LOSS') mult = 1.5;
  else if (perf.lastResult === 'WIN') mult = 0.85;
  return Math.max(60 * 1000, Math.min(900 * 1000, Math.round(baseMs * mult)));
}

// 更新策略表现记忆 (仅记录上单结果, 用于自适应冷却)
function updatePerfMemory(symbol, tf, result) {
  const perf = perfMemory[symbol] && perfMemory[symbol][tf];
  if (!perf) return;
  if (result === 'LOSS' || result === 'WIN') {
    perf.lastResult = result;
  }
}

// Real-time live tick processor (v2)
// 流程: 结算(完整性修复) -> 风控闸门 -> 区域布防 -> ARMED确认 -> 评分过滤 -> 开仓
async function processLiveTick(symbol, currentPrice) {
  const normSym = normalizeSymbol(symbol);
  if (!signalRegistry[normSym]) return;

  const now = Date.now();
  let registryChanged = false;
  const view = marketViews[normSym];
  const viewFresh = !!view && (now - view.updatedAt) < 12000;
  const userDir = semiautoConfig.direction || 'BULL';

  for (const tf of ['3m', '5m', '10m']) {
    const cfg = TIMEFRAME_CONFIGS[tf];
    if (!cfg) continue;
    const sigList = signalRegistry[normSym][tf] || [];

    // 1) 结算 (含完整性修复: 停机超时判废 / 平局判平)
    for (const sig of sigList) {
      if (sig.status !== '等') continue;
      if (now - sig.settleTime > STALE_SETTLE_MS) {
        sig.status = '废';
        sig.voidReason = `结算超时 ${Math.round((now - sig.settleTime) / 1000)}s (服务停机或行情中断, 不计入胜率)`;
        registryChanged = true;
        continue;
      }
      if (now >= sig.settleTime) {
        sig.settlePrice = roundTo(currentPrice, normSym.includes('ETH') ? 2 : 1);
        const isBuy = sig.typeKey === 'BUY' || sig.type === '做多';
        const isWin = isBuy ? (sig.settlePrice > sig.price) : (sig.settlePrice < sig.price);
        if (sig.settlePrice === sig.price) {
          sig.status = '平';
        } else {
          sig.status = isWin ? '吃' : '败';
          updatePerfMemory(normSym, tf, isWin ? 'WIN' : 'LOSS');
        }
        registryChanged = true;
      }
    }

    // 2) 风控闸门: 自适应冷却 / 并发挂单上限
    const perf = perfMemory[normSym][tf];

    const lastSig = sigList[sigList.length - 1];
    const dirSwitched = lastSig && (semiautoConfig.updatedAt > lastSig.triggerTime);
    if (lastSig && !dirSwitched && (now - lastSig.triggerTime) < adaptiveCooldownMs(cfg.cooldownMs, perf)) continue;

    const pendingAll = ['3m', '5m', '10m'].reduce(
      (s, t) => s + (signalRegistry[normSym][t] || []).filter(x => x.status === '等').length, 0);
    if (pendingAll >= MAX_PENDING_PER_SYMBOL) continue;

    // 3) 数据新鲜度 & 波动率熔断 (ATR 扩张倍数, 防止消息面爆炸后追单)
    if (!viewFresh) continue;
    const m3 = view.tfs['3m'];
    if (m3 && m3.atrRatio > VOL_BREAKER_ATR_RATIO) continue;

    // 4) 区域布防 + ARMED 确认状态机
    const zones = detectEntryZones(tf, view, userDir, currentPrice);
    const st = entryState[normSym][tf];

    if (zones.length > 0) {
      if (!st) {
        entryState[normSym][tf] = {
          phase: 'ARMED', zone: zones[0], side: zones[0].side,
          armedAt: now, refLow: currentPrice, refHigh: currentPrice
        };
      } else {
        st.refLow = Math.min(st.refLow, currentPrice);
        st.refHigh = Math.max(st.refHigh, currentPrice);

        if (now - st.armedAt > ARM_TIMEOUT_MS) {
          entryState[normSym][tf] = null; // 超时未确认, 放弃本次布防
        } else {
          const conf = checkEntryConfirmation(tf, st.side, st, currentPrice, view);
          if (conf.ok) {
            const zone = st.zone;
            let score = 0, factors = [];
            try {
              const scored = scoreEntrySetup(tf, st.side, zone, view, currentPrice);
              score = scored.score;
              factors = scored.factors;
            } catch (e) { score = 0; }

            const counter = (st.side === 'BUY' && view.higherBias <= -25) || (st.side === 'SELL' && view.higherBias >= 25);
            let threshold = zone.threshold || (userDir === 'RANGE' ? 68 : 70);
            if (counter) threshold = Math.max(threshold, 84);
            if (view.tfs[tf] && view.tfs[tf].squeeze && userDir !== 'RANGE') threshold += 4;

            if (score >= threshold) {
              const timeStr = formatBeijingTime(now);
              const isEth = normSym.includes('ETH');
              const liveSig = {
                id: `semiauto-${normSym}-${tf}-${now}`,
                symbol: normSym,
                coin: normSym.replace('USDT', ''),
                timeframe: tf,
                version: 'semiauto',
                type: st.side === 'BUY' ? '做多' : '做空',
                typeKey: st.side,
                wavePattern: zone.pattern,
                price: roundTo(currentPrice, isEth ? 2 : 1),
                time: timeStr,
                openTime: Math.floor(now / 60000) * 60000,
                triggerTime: now,
                settleTime: now + cfg.durationMs,
                settlePrice: null,
                status: '等',
                score,
                factors,
                regime: userDir,
                systemBias: roundTo(view.systemBias, 1),
                higherBias: roundTo(view.higherBias, 1),
                mtfScore: {
                  '1h': roundTo(tfTrendScore(view.tfs['1h']), 1),
                  '15m': roundTo(tfTrendScore(view.tfs['15m']), 1),
                  '5m': roundTo(tfTrendScore(view.tfs['5m']), 1),
                  '3m': roundTo(tfTrendScore(view.tfs['3m']), 1)
                },
                atrPct: view.tfs[tf] ? roundTo(view.tfs[tf].atrPct, 0) : null
              };
              signalRegistry[normSym][tf].push(liveSig);
              registryChanged = true;
              console.log(`[LIVE SEMIAUTO SIGNAL FIRED] ${timeStr} ${normSym} ${tf} ${liveSig.type} @ ${liveSig.price} 评分${score}(${threshold}) - ${zone.pattern}`);
            } else {
              console.log(`[SETUP REJECTED] ${formatBeijingTime(now)} ${normSym} ${tf} ${st.side} 评分${score} < 阈值${threshold} - ${zone.pattern}`);
            }
            entryState[normSym][tf] = null; // 无论成败, 本次布防结束
          }
        }
      }
    } else if (st) {
      const m = view.tfs[tf];
      if (m) {
        const away = currentPrice < st.zone.low - 0.6 * m.atr || currentPrice > st.zone.high + 0.6 * m.atr;
        if (away || now - st.armedAt > ARM_TIMEOUT_MS) entryState[normSym][tf] = null;
      } else {
        entryState[normSym][tf] = null;
      }
    }
  }

  if (registryChanged) {
    scheduleSaveSignals();
  }
}

// Background poller to refresh spot price and analyze live ticks
let isPolling = false;
async function highFreqTickerLoop() {
  if (isPolling) return;
  isPolling = true;

  try {
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      try {
        const tick = await fetchBinancePrice(sym);
        if (tick && tick.price) {
          await processLiveTick(sym, tick.price);
        }
      } catch (e) {}
    }
  } catch (err) {}
  finally {
    isPolling = false;
  }
}

// ---- 市场数据刷新循环 (v2) ----
// 快周期: 1m/3m/5m 每 3s 刷新 (入场周期 + 1m 确认K线)
async function fastRefreshLoop() {
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    for (const tf of FAST_REFRESH_TFS) {
      try { await refreshKlinesFor(sym, tf); } catch (e) {}
    }
    try { computeMarketView(sym); } catch (e) {}
  }
}

// 慢周期: 15m/1h 每 15s 刷新 (大周期方向, 降低 API 压力)
async function slowRefreshLoop() {
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    for (const tf of SLOW_REFRESH_TFS) {
      try { await refreshKlinesFor(sym, tf); } catch (e) {}
    }
    try { computeMarketView(sym); } catch (e) {}
  }
}

setInterval(highFreqTickerLoop, 1000);    // 1s 实时tick评估
setInterval(fastRefreshLoop, 3000);       // 3s 入场周期指标刷新
setInterval(slowRefreshLoop, 15000);      // 15s 大周期指标刷新
setTimeout(fastRefreshLoop, 300);
setTimeout(slowRefreshLoop, 800);

// ==========================================
// API ROUTES
// ==========================================

// 1. Semiauto 12-Hour Macro Direction Config
app.get('/api/semiauto/config', (req, res) => {
  res.json({
    direction: semiautoConfig.direction,
    macroDirection: semiautoConfig.direction,
    updatedAt: semiautoConfig.updatedAt
  });
});

app.post('/api/semiauto/config', (req, res) => {
  try {
    const { direction, macroDirection } = req.body || {};
    const targetDir = direction || macroDirection;
    if (['BULL', 'BEAR', 'RANGE'].includes(targetDir)) {
      semiautoConfig.direction = targetDir;
      semiautoConfig.updatedAt = Date.now();
      saveSemiautoConfig();

      // 方向切换: 清空旧方向的入场布防状态, 避免串味
      for (const sym of Object.keys(entryState)) {
        for (const tf of Object.keys(entryState[sym])) entryState[sym][tf] = null;
      }

      console.log(`[SEMIAUTO CONFIG UPDATED] 12h Direction switched to: ${targetDir}`);
      // Immediate tick analysis in new direction
      setTimeout(highFreqTickerLoop, 50);

      return res.json({
        success: true,
        direction: targetDir,
        macroDirection: targetDir,
        updatedAt: semiautoConfig.updatedAt
      });
    }
    res.status(400).json({ error: 'Invalid direction. Must be BULL, BEAR, or RANGE.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dedicated Real-time Signals API for Card 1 (Current Signal Cycle Entry Signals)
app.get('/api/signals/live', (req, res) => {
  try {
    const symbol = req.query.symbol ? normalizeSymbol(req.query.symbol) : null;
    const timeframe = req.query.timeframe || req.query.signalTf || null;
    let all = [];
    const syms = symbol ? [symbol] : ['BTCUSDT', 'ETHUSDT'];
    const tfs = (timeframe && timeframe !== 'ALL') ? [timeframe] : ['3m', '5m', '10m'];
    for (const sym of syms) {
      for (const tf of tfs) {
        const list = (signalRegistry[sym] && signalRegistry[sym][tf]) || [];
        all = all.concat(list);
      }
    }
    all.sort((a, b) => (b.triggerTime || b.openTime) - (a.triggerTime || a.openTime));
    const active = all.filter(s => s.status === '等');
    res.json({
      success: true,
      symbol: symbol || 'ALL',
      timeframe: timeframe || 'ALL',
      direction: semiautoConfig.direction,
      activeSignals: active,
      recentSignals: all.slice(0, 50),
      total: all.length,
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Klines with Live Signal Markers
app.get('/api/klines/:symbol/:interval', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const interval = req.params.interval || '1m';
    const signalTf = req.query.signalTf || '5m';
    const limit = Math.min(parseInt(req.query.limit) || 150, 1000);

    const klines = await fetchBinanceKlines(symbol, interval, limit);
    if (!klines || !klines.length) {
      return res.status(500).json({ error: 'Failed to fetch klines' });
    }

    // 1. Accurate candlestick matching for markers on ANY timeframe (1m, 3m, 5m, 10m, 15m)
    const targetSigs = (signalRegistry[symbol] && signalRegistry[symbol][signalTf]) || [];
    const markers = [];

    targetSigs.forEach(sig => {
      const sigT = sig.triggerTime || sig.openTime;
      let matchedCandle = null;

      if (klines && klines.length) {
        // Direct candle range lookup: c.openTime <= sigT < (nextC ? nextC.openTime : c.closeTime)
        for (let i = 0; i < klines.length; i++) {
          const c = klines[i];
          const nextC = klines[i + 1];
          if (nextC) {
            if (sigT >= c.openTime && sigT < nextC.openTime) {
              matchedCandle = c;
              break;
            }
          } else {
            if (sigT >= c.openTime) {
              matchedCandle = c;
              break;
            }
          }
        }
      }

      if (matchedCandle) {
        const isBuy = sig.typeKey === 'BUY' || sig.type === '做多';
        let color = isBuy ? '#22c55e' : '#ef4444';
        if (sig.status === '吃') color = '#10b981';
        else if (sig.status === '败') color = '#64748b';
        else if (sig.status === '平') color = '#38bdf8';
        else if (sig.status === '废') color = '#475569';
        else if (sig.status === '等') color = '#f59e0b';

        markers.push({
          time: Math.floor(matchedCandle.openTime / 1000),
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: color,
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          text: sig.status === '等' ? (isBuy ? '多' : '空') : sig.status,
          status: sig.status,
          type: sig.typeKey,
          isLive: sig.status === '等',
          score: sig.score,
          wavePattern: sig.wavePattern,
          openTime: sig.openTime,
          price: sig.price,
          settlePrice: sig.settlePrice
        });
      }
    });

    // 2. Current signal timeframe entry signals for Card 1 Live Signals list
    const currentTfSigs = (signalRegistry[symbol] && signalRegistry[symbol][signalTf]) || [];
    const recentSignals = currentTfSigs.slice().sort((a, b) => (b.triggerTime || b.openTime) - (a.triggerTime || a.openTime)).slice(0, 50);

    // 3. Current signal timeframe stats
    const settled = targetSigs.filter(s => s.status === '吃' || s.status === '败');
    const wins = settled.filter(s => s.status === '吃').length;
    const losses = settled.filter(s => s.status === '败').length;
    const total = settled.length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

    // 4. Backtest statistics matrix for symbol
    const backtestStats = {};
    let allW = 0, allL = 0;
    ['3m', '5m', '10m'].forEach(t => {
      const list = (signalRegistry[symbol] && signalRegistry[symbol][t]) || [];
      const sSettled = list.filter(s => s.status === '吃' || s.status === '败');
      const w = sSettled.filter(s => s.status === '吃').length;
      const l = sSettled.filter(s => s.status === '败').length;
      const tot = w + l;
      const rate = tot > 0 ? ((w / tot) * 100).toFixed(1) : '0.0';
      allW += w;
      allL += l;
      backtestStats[t] = { rate, wins: w, losses: l, total: tot };
    });
    const totSettled = allW + allL;
    backtestStats.overall = {
      rate: totSettled > 0 ? ((allW / totSettled) * 100).toFixed(1) : '0.0',
      wins: allW,
      losses: allL,
      total: totSettled
    };

    res.json({
      symbol,
      interval,
      signalTf,
      version: 'semiauto',
      klines,
      markers,
      stats: {
        todayTotal: targetSigs.length,
        winCount: wins,
        lossCount: losses,
        pendingCount: targetSigs.filter(s => s.status === '等').length,
        winRate
      },
      recentSignals,
      backtestStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Real-time Spot Price
app.get('/api/price/:symbol', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const priceData = await fetchBinancePrice(symbol);
    res.json(priceData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Multi-Timeframe Future Predictions
// 方向 = 用户锁定的大方向 与 系统客观多周期趋势(systemBias)的综合;
// 置信度由两者一致性强度推导, 不再使用虚构固定值
app.get('/api/signal/:symbol', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const predictions = {};
    const view = marketViews[symbol];
    const dir = semiautoConfig.direction || 'BULL';
    const reasons = [];

    if (view && Math.abs(view.higherBias) > 20 && dir !== 'RANGE') {
      const dirSign = dir === 'BULL' ? 1 : -1;
      if (Math.sign(view.higherBias) !== dirSign) {
        reasons.push(`⚠️ 系统客观大周期趋势${view.higherBias > 0 ? '偏多' : '偏空'}(${view.higherBias.toFixed(0)})与您锁定的${dir === 'BULL' ? '看多' : '看空'}方向不一致, 已自动提高开仓门槛, 请注意风险`);
      }
    }
    if (!view) {
      reasons.push('市场数据初始化中, 稍后将给出基于多周期共振的评估');
    }

    for (const tf of ['3m', '5m', '10m']) {
      const tfScore = view && view.tfs[tf] ? tfTrendScore(view.tfs[tf]) : 0;
      const sys = view ? view.systemBias : 0;

      let direction, confidence;
      if (dir === 'RANGE') {
        // 震荡模式: 方向由本周期客观趋势决定
        direction = tfScore >= 0 ? 'UP' : 'DOWN';
        confidence = 50 + Math.min(25, Math.abs(tfScore) * 0.35);
      } else {
        // 趋势模式: 引擎按用户锁定方向交易; 方向 = 用户方向, 置信度反映客观证据的支持度
        const dirSign = dir === 'BULL' ? 1 : -1;      // 用户预期价格的方向
        const evidence = sys + tfScore;               // 客观证据 (>0 偏多)
        const support = dirSign * evidence;           // >0 = 客观证据支持用户方向
        direction = dirSign > 0 ? 'UP' : 'DOWN';
        const agree = Math.sign(evidence) === dirSign || Math.abs(evidence) < 15;
        confidence = 52 + Math.min(28, Math.abs(support) * 0.32);
        if (!agree) confidence = Math.min(confidence, 58);
      }
      predictions[tf] = {
        direction,
        confidence: Math.round(Math.max(50, Math.min(85, confidence)))
      };
    }

    const dirName = semiautoConfig.direction === 'BULL' ? '看多' : (semiautoConfig.direction === 'BEAR' ? '看空' : '震荡');
    res.json({
      symbol,
      version: 'semiauto',
      direction: semiautoConfig.direction,
      macroDirection: semiautoConfig.direction,
      predictions,
      systemBias: view ? roundTo(view.systemBias, 1) : null,
      higherBias: view ? roundTo(view.higherBias, 1) : null,
      reasons,
      alignment: {
        description: `12h大方向锁定: ${dirName} · 1m/3m/5m/15m/1h 多周期趋势共振 + ARMED确认 + 质量评分过滤`
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Notifications List
app.get('/api/notifications', (req, res) => {
  try {
    const { coin, timeframe } = req.query;
    let all = [];

    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      for (const tf of ['3m', '5m', '10m']) {
        const list = (signalRegistry[sym] && signalRegistry[sym][tf]) || [];
        all = all.concat(list);
      }
    }

    if (coin && coin !== 'ALL') {
      const c = coin.toUpperCase();
      all = all.filter(s => s.coin === c || s.symbol.startsWith(c));
    }
    if (timeframe && timeframe !== 'ALL') {
      all = all.filter(s => s.timeframe === timeframe);
    }

    // Sort descending by triggerTime
    all.sort((a, b) => (b.triggerTime || b.openTime) - (a.triggerTime || a.openTime));

    res.json({
      notifications: all,
      total: all.length,
      version: 'semiauto'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Clear All Recorded Signals API
app.post('/api/signals/clear', (req, res) => {
  try {
    signalRegistry = {
      BTCUSDT: { '3m': [], '5m': [], '10m': [] },
      ETHUSDT: { '3m': [], '5m': [], '10m': [] }
    };
    saveLiveSignals();
    console.log('[SIGNALS CLEARED] All live recorded signals cleared.');
    res.json({ success: true, message: 'All live signals cleared successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Backtest Statistics Matrix (增强: 期望值/盈亏比/最大回撤/连胜连亏/置信区间)
// 收益模型与模拟下单一致: 胜 +0.8, 败 -1.0, 平局 0, 作废不计入
const PAYOUT_WIN = 0.8;
const PAYOUT_LOSS = 1.0;

function enhancedStats(list) {
  const settled = list.filter(s => s.status === '吃' || s.status === '败');
  const wins = settled.filter(s => s.status === '吃').length;
  const losses = settled.filter(s => s.status === '败').length;
  const ties = list.filter(s => s.status === '平').length;
  const voids = list.filter(s => s.status === '废').length;
  const total = wins + losses;
  const rate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

  const winPnl = wins * PAYOUT_WIN;
  const lossPnl = losses * PAYOUT_LOSS;
  const expectancy = total > 0 ? (winPnl - lossPnl) / total : 0;
  const profitFactor = lossPnl > 0 ? winPnl / lossPnl : (wins > 0 ? 99 : 0);

  // 资金曲线与回撤 (按信号发生顺序, 固定单位注码)
  let equity = 0, peak = 0, maxDD = 0;
  let curLossStreak = 0, maxLossStreak = 0, curWinStreak = 0, maxWinStreak = 0;
  for (const s of list) {
    if (s.status === '吃') {
      equity += PAYOUT_WIN;
      curLossStreak = 0; curWinStreak++; maxWinStreak = Math.max(maxWinStreak, curWinStreak);
    } else if (s.status === '败') {
      equity -= PAYOUT_LOSS;
      curWinStreak = 0; curLossStreak++; maxLossStreak = Math.max(maxLossStreak, curLossStreak);
    } else {
      continue;
    }
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  // 胜率 95% 置信区间半宽 (百分点)
  const p = total > 0 ? wins / total : 0;
  const ci = total > 0 ? 1.96 * Math.sqrt(Math.max(p * (1 - p), 0.0001) / total) * 100 : 0;

  return {
    wins, losses, total, rate,
    ties, voids,
    expectancy: Number(expectancy.toFixed(3)),
    profitFactor: Number(profitFactor.toFixed(2)),
    maxDrawdown: Number(maxDD.toFixed(2)),
    maxLossStreak,
    maxWinStreak,
    ci95: Number(ci.toFixed(1)),
    breakevenRate: Number((1 / (1 + PAYOUT_WIN) * 100).toFixed(1))
  };
}

app.get('/api/backtest-stats', (req, res) => {
  try {
    const calcStats = (sym) => {
      const resObj = {};
      const allLists = [];
      for (const tf of ['3m', '5m', '10m']) {
        const list = (signalRegistry[sym] && signalRegistry[sym][tf]) || [];
        allLists.push(list);
        resObj[tf] = enhancedStats(list);
      }
      resObj.overall = enhancedStats([].concat(...allLists));
      return resObj;
    };

    const btcStats = calcStats('BTCUSDT');
    const ethStats = calcStats('ETHUSDT');
    const grand = enhancedStats([].concat(
      signalRegistry.BTCUSDT['3m'], signalRegistry.BTCUSDT['5m'], signalRegistry.BTCUSDT['10m'],
      signalRegistry.ETHUSDT['3m'], signalRegistry.ETHUSDT['5m'], signalRegistry.ETHUSDT['10m']
    ));

    res.json({
      semiauto: {
        BTC: btcStats,
        ETH: ethStats,
        total: grand
      },
      grandTotal: grand,
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason && reason.message ? reason.message : reason);
});

// 8. Engine Diagnostics (透明化引擎状态: 为什么开仓/不开仓)
app.get('/api/engine-status', (req, res) => {
  try {
    const symbol = req.query.symbol ? normalizeSymbol(req.query.symbol) : 'BTCUSDT';
    const view = marketViews[symbol];
    const summarize = (m) => m ? {
      close: roundTo(m.close, 2),
      ema9: roundTo(m.ema9, 2), ema21: roundTo(m.ema21, 2), ema50: roundTo(m.ema50, 2),
      rsi: roundTo(m.rsi, 1),
      adx: roundTo(m.adx, 1), plusDI: roundTo(m.plusDI, 1), minusDI: roundTo(m.minusDI, 1),
      atr: roundTo(m.atr, 2), atrRatio: roundTo(m.atrRatio, 2), atrPct: roundTo(m.atrPct, 0),
      volRatioAdj: roundTo(m.vol.volRatioAdj, 2),
      kcUpper: m.kc ? roundTo(m.kc.upper, 2) : null,
      kcMiddle: m.kc ? roundTo(m.kc.middle, 2) : null,
      kcLower: m.kc ? roundTo(m.kc.lower, 2) : null,
      kcPct: m.kc ? roundTo((m.close - m.kc.lower) / ((m.kc.upper - m.kc.lower) || 1), 2) : null,
      swing: m.swing.pattern, squeeze: m.squeeze,
      trendScore: roundTo(tfTrendScore(m), 1)
    } : null;

    const armed = {};
    for (const tf of ['3m', '5m', '10m']) {
      const st = entryState[symbol][tf];
      armed[tf] = st ? {
        side: st.side, kind: st.zone.kind,
        zoneLow: roundTo(st.zone.low, 2), zoneHigh: roundTo(st.zone.high, 2),
        armedSec: Math.round((Date.now() - st.armedAt) / 1000)
      } : null;
    }

    res.json({
      symbol,
      direction: semiautoConfig.direction,
      systemBias: view ? roundTo(view.systemBias, 1) : null,
      higherBias: view ? roundTo(view.higherBias, 1) : null,
      dataAgeMs: view ? Date.now() - view.updatedAt : null,
      volBreaker: !!(view && view.tfs['3m'] && view.tfs['3m'].atrRatio > VOL_BREAKER_ATR_RATIO),
      tfs: view ? Object.fromEntries(Object.entries(view.tfs).map(([tf, m]) => [tf, summarize(m)])) : {},
      armed,
      perf: perfMemory[symbol],
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Crypto Semi-Auto Dashboard running at http://localhost:${PORT}`);
});
