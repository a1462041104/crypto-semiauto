// 引擎逻辑离线测试: 用合成 K 线数据验证指标计算、区域识别、确认机制、评分与统计
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
const startMark = '// QUANT INDICATOR LIBRARY';
const endMark = '// ==========================================\n// API ROUTES';
const statsMark = '// 7. Backtest Statistics Matrix';
const statsEnd = "app.get('/api/backtest-stats'";

const engineCode = src.slice(src.indexOf(startMark), src.indexOf(endMark));
const statsCode = src.slice(src.indexOf(statsMark), src.indexOf(statsEnd));

const ctx = {
  console, Date, Math, Number, JSON, Object, Array, String, Boolean, isNaN, parseInt, parseFloat, Error,
  __dirname: __dirname,
  path: { join: (...a) => a.join('/') },
  fs: { existsSync: () => false, readFileSync: () => '{}', writeFile: () => {}, writeFileSync: () => {} },
  setInterval: () => {}, setTimeout: () => {}, clearInterval: () => {},
  fetch: () => Promise.reject(new Error('offline-test')),
  signalRegistry: { BTCUSDT: { '3m': [], '5m': [], '10m': [] }, ETHUSDT: { '3m': [], '5m': [], '10m': [] } },
  semiautoConfig: { direction: 'BULL', updatedAt: Date.now() - 100000 },
  normalizeSymbol: (s) => String(s || '').toUpperCase(),
  roundTo: (v, d) => Number(Number(v).toFixed(d)),
  formatBeijingTime: () => '00:00:00',
  fetchBinanceKlines: async () => [],
  fetchBinancePrice: async () => ({ price: 0 }),
};
vm.createContext(ctx);
vm.runInContext(engineCode, ctx);
vm.runInContext(statsCode, ctx);
const api = vm.runInContext(`({
  computeTfMetrics, tfTrendScore, computeMarketView, detectEntryZones,
  checkEntryConfirmation, scoreEntrySetup, enhancedStats,
  calcADX, calcRSIWilder, calcATR, calcMACD, calcBollinger, calcVolumeProfile,
  calcSwingStructure, emaSeries, klineStore, marketViews, signalRegistry, entryState, perfMemory, semiautoConfig,
  processLiveTick
})`, ctx);

// ---- 合成 K 线生成器 ----
function mkKlines(n, startPrice, driftPerBar, volPct, intervalMs, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const klines = [];
  let price = startPrice;
  const now = Date.now();
  const startOpen = Math.floor(now / intervalMs) * intervalMs - (n - 1) * intervalMs;
  for (let i = 0; i < n; i++) {
    const open = price;
    const drift = open * driftPerBar * (0.6 + rnd() * 0.8);
    const noise = open * volPct * (rnd() - 0.5) * 2;
    const close = open + drift + noise;
    const high = Math.max(open, close) + open * volPct * rnd() * 0.6;
    const low = Math.min(open, close) - open * volPct * rnd() * 0.6;
    const volume = 100 + rnd() * 40;
    klines.push({
      openTime: startOpen + i * intervalMs,
      open, high, low, close,
      volume,
      quoteVolume: volume * close,
      takerBuyVolume: volume * (0.45 + rnd() * 0.15),
      closeTime: startOpen + i * intervalMs + intervalMs - 1
    });
    price = close;
  }
  return klines;
}

// 确定性锯齿 (严格 HH/HL) K 线
function mkZigzagUp(n, startPrice, step, intervalMs) {
  const klines = [];
  const now = Date.now();
  const startOpen = Math.floor(now / intervalMs) * intervalMs - (n - 1) * intervalMs;
  let base = startPrice;
  for (let i = 0; i < n; i++) {
    const dip = (i % 2 === 1) ? step * 0.5 : 0;
    const open = base + dip;
    const close = base + (i % 2 === 1 ? step * 0.2 : step);
    base += step * 0.45;
    klines.push({
      openTime: startOpen + i * intervalMs,
      open, high: Math.max(open, close) + step * 0.1, low: Math.min(open, close) - step * 0.1, close,
      volume: 120, quoteVolume: 120 * close, takerBuyVolume: 66,
      closeTime: startOpen + i * intervalMs + intervalMs - 1
    });
  }
  return klines;
}

// 确定性正弦震荡 (均值回归) K 线
function mkSineChop(n, midPrice, amp, intervalMs) {
  const klines = [];
  const now = Date.now();
  const startOpen = Math.floor(now / intervalMs) * intervalMs - (n - 1) * intervalMs;
  for (let i = 0; i < n; i++) {
    const open = midPrice + Math.sin(i * 0.5) * amp;
    const close = midPrice + Math.sin((i + 1) * 0.5) * amp;
    klines.push({
      openTime: startOpen + i * intervalMs,
      open, high: Math.max(open, close) + amp * 0.1, low: Math.min(open, close) - amp * 0.1, close,
      volume: 100, quoteVolume: 100 * close, takerBuyVolume: 50,
      closeTime: startOpen + i * intervalMs + intervalMs - 1
    });
  }
  return klines;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra !== undefined ? '=> ' + JSON.stringify(extra) : ''}`); }
}

console.log('== 1. 指标计算正确性 ==');
const up = mkKlines(150, 60000, 0.0012, 0.0015, 60000, 42);
const down = mkKlines(150, 60000, -0.0012, 0.0015, 60000, 42);
const zig = mkZigzagUp(150, 60000, 40, 60000);
const chop = mkSineChop(150, 60000, 150, 60000);

const mUp = api.computeTfMetrics(up);
const mDown = api.computeTfMetrics(down);
const mZig = api.computeTfMetrics(zig);
const mChop = api.computeTfMetrics(chop);

check('上涨数据 EMA9>EMA21>EMA50', mUp.ema9 > mUp.ema21 && mUp.ema21 > mUp.ema50, { e9: mUp.ema9, e21: mUp.ema21, e50: mUp.ema50 });
check('下跌数据 EMA9<EMA21<EMA50', mDown.ema9 < mDown.ema21 && mDown.ema21 < mDown.ema50);
check('RSI 上涨>50 下跌<50', mUp.rsi > 50 && mDown.rsi < 50, { up: mUp.rsi, down: mDown.rsi });
check('ADX 上涨趋势>20', mUp.adx > 20, mUp.adx);
check('ATR>0 且分位在0-100', mUp.atr > 0 && mUp.atrPct >= 0 && mUp.atrPct <= 100, mUp.atrPct);
check('ATR 扩张倍数在合理区间(非爆炸)', mUp.atrRatio > 0.5 && mUp.atrRatio < 2.2, mUp.atrRatio);
check('摆动结构: 确定性上涨锯齿=HH-HL', mZig.swing.pattern === 'HH-HL', mZig.swing.pattern);
check('摆动结构: 确定性下跌=LH-LL', mDown.swing.pattern === 'LH-LL', mDown.swing.pattern);
// MACD: 用确定性线性下跌序列验证
const linDown = [];
for (let i = 0; i < 120; i++) {
  const p = 60000 - i * 10;
  linDown.push({ openTime: i * 60000, open: p, high: p + 2, low: p - 2, close: p, volume: 100, quoteVolume: 100 * p, takerBuyVolume: 40, closeTime: i * 60000 + 59999 });
}
const macdDown = api.calcMACD(linDown.map(k => k.close));
check('MACD 确定性下跌 hist<0', macdDown.hist < 0, macdDown.hist);
const linUpCloses = [];
for (let i = 0; i < 120; i++) linUpCloses.push(58810 + i * 10);
const macdUp = api.calcMACD(linUpCloses);
check('MACD 确定性上涨 hist>0', macdUp.hist > 0, macdUp.hist);
check('趋势评分: 上涨>0 下跌<0 正弦震荡≈0',
  api.tfTrendScore(mUp) > 15 && api.tfTrendScore(mDown) < -15 && Math.abs(api.tfTrendScore(mChop)) < 20,
  { up: api.tfTrendScore(mUp), down: api.tfTrendScore(mDown), chop: api.tfTrendScore(mChop) });

console.log('== 2. 多周期市场视图 ==');
for (const tf of ['1m', '3m', '5m', '15m', '1h']) {
  api.klineStore.BTCUSDT[tf] = { klines: mkKlines(150, 60000, 0.0011, 0.0014, tf === '1h' ? 3600000 : tf === '15m' ? 900000 : tf === '5m' ? 300000 : tf === '3m' ? 180000 : 60000, 99), updatedAt: Date.now() };
}
const view = api.computeMarketView('BTCUSDT');
check('全上涨行情 systemBias>0 且 higherBias>0', view.systemBias > 10 && view.higherBias > 10, { sys: view.systemBias, hi: view.higherBias });
check('marketViews 已写入且新鲜', api.marketViews.BTCUSDT && Date.now() - api.marketViews.BTCUSDT.updatedAt < 1000);

console.log('== 3. 入场区域识别 ==');
const m3m = view.tfs['3m'];
const nearEma21 = m3m.ema21 + m3m.atr * 0.2; // 回踩中轨附近
const zonesBull = api.detectEntryZones('3m', view, 'BULL', nearEma21);
check('BULL 方向在 EMA21 附近识别到做多区域', zonesBull.length > 0 && zonesBull[0].side === 'BUY', zonesBull.map(z => z.kind));
const farAway = m3m.ema21 + m3m.atr * 8;
check('价格远离价值区时无区域', api.detectEntryZones('3m', view, 'BULL', farAway).length === 0);

// 构造确定性震荡视图验证 RANGE 高抛低吸
const fakeChopView = {
  tfs: {
    '3m': { kc: { upper: 60500, middle: 60000, lower: 59500 }, rsi: 30, ema21: 60000, ema50: 60010, atr: 100,
      swing: { pattern: 'mixed', lastSwingHigh: 60400, lastSwingLow: 59600, higherHigh: null, higherLow: null },
      vol: { volRatioAdj: 1.2, volRatio: 1.2, takerBuyRatio: 0.5 } },
    '15m': { adx: 15 }
  },
  systemBias: 5, higherBias: 3
};
const rangeZones = api.detectEntryZones('3m', fakeChopView, 'RANGE', 59600);
check('RANGE 方向在 KC 下轨识别到吸多区域', rangeZones.some(z => z.side === 'BUY'), rangeZones.map(z => z.kind));
const rangeZonesHi = api.detectEntryZones('3m', { ...fakeChopView, tfs: { ...fakeChopView.tfs, '3m': { ...fakeChopView.tfs['3m'], rsi: 68 } } }, 'RANGE', 60400);
check('RANGE 方向在 KC 上轨识别到抛空区域', rangeZonesHi.some(z => z.side === 'SELL'), rangeZonesHi.map(z => z.kind));
// 强趋势时 RANGE 不应给出震荡区域
const strongTrendView = { tfs: { '3m': fakeChopView.tfs['3m'], '15m': { adx: 35 } }, systemBias: 40, higherBias: 38 };
check('强趋势时 RANGE 禁止震荡区域', api.detectEntryZones('3m', strongTrendView, 'RANGE', 59600).length === 0);
// BEAR 方向在 EMA21 下方反弹受阻
const bearView = {
  tfs: { '3m': { kc: { upper: 60100, middle: 59900, lower: 59700 }, rsi: 55, ema21: 59900, ema50: 60000, atr: 100,
    swing: { pattern: 'LH-LL', lastSwingHigh: 60100, lastSwingLow: 59700, higherHigh: false, higherLow: false },
    vol: { volRatioAdj: 1.2, volRatio: 1.2, takerBuyRatio: 0.45 } } },
  systemBias: -30, higherBias: -28
};
const bearZones = api.detectEntryZones('3m', bearView, 'BEAR', 59950);
check('BEAR 方向在 EMA21 附近识别到做空区域', bearZones.length > 0 && bearZones[0].side === 'SELL', bearZones.map(z => z.kind));

console.log('== 4. ARMED 确认机制 ==');
const confView = {
  tfs: {
    '3m': { close: 60100, open: 60050, ema21: 60000, atr: 100, rsi: 55, macdHist: 20, vol: { volRatioAdj: 1.3 } },
    '1m': { close: 60110, open: 60080 }
  }
};
const stateNoHL = { zone: { kind: 'pullback', side: 'BUY' }, refLow: 60050, refHigh: 60100, armedAt: Date.now() };
const r1 = api.checkEntryConfirmation('3m', 'BUY', stateNoHL, 60050, confView);
check('价格未出现更高低点 -> 等待', r1.ok === false && r1.reason === 'wait-higher-low', r1);
const stateHL = { zone: { kind: 'pullback', side: 'BUY' }, refLow: 60000, refHigh: 60100, armedAt: Date.now() };
const r2 = api.checkEntryConfirmation('3m', 'BUY', stateHL, 60120, confView);
check('出现更高低点+1m同向+量能 -> 确认', r2.ok === true, r2);
// 1m 反向 -> 等待
const r3 = api.checkEntryConfirmation('3m', 'BUY', stateHL, 60120, { tfs: { '3m': confView.tfs['3m'], '1m': { close: 60050, open: 60100 } } });
check('1分钟动量反向 -> 等待', r3.ok === false && r3.reason === 'wait-1m-bull', r3);
// RSI 超买 -> 不追
const r4 = api.checkEntryConfirmation('3m', 'BUY', stateHL, 60120, { tfs: { '3m': { ...confView.tfs['3m'], rsi: 80 }, '1m': confView.tfs['1m'] } });
check('RSI 超买 -> 拒绝追多', r4.ok === false && r4.reason === 'rsi-overbought', r4);
// 量能不足 -> 等待
const r5 = api.checkEntryConfirmation('3m', 'BUY', stateHL, 60120, { tfs: { '3m': { ...confView.tfs['3m'], vol: { volRatioAdj: 0.8 } }, '1m': confView.tfs['1m'] } });
check('量比不足 -> 等待', r5.ok === false && r5.reason === 'wait-volume', r5);

console.log('== 5. 质量评分 ==');
const strongView = {
  tfs: {
    '3m': { close: 60120, open: 60050, ema9: 60100, ema21: 60000, ema50: 59800, ema21SlopeAtr: 0.5,
      rsi: 55, rsiPrev: 52, atr: 100, atrPct: 50, atrRatio: 1.1, adx: 28, plusDI: 30, minusDI: 15,
      macdHist: 25, macdPrevHist: 15, vol: { volRatioAdj: 1.5, takerBuyRatio: 0.58 },
      swing: { pattern: 'HH-HL', higherHigh: true, higherLow: true, lastSwingHigh: 60400, lastSwingLow: 59900 } }
  },
  higherBias: 35, systemBias: 30
};
const scored = api.scoreEntrySetup('3m', 'BUY', { kind: 'pullback' }, strongView, 60120);
check('强共振setup评分 > 80', scored.score > 80, scored.score);
check('因子分项之和 = 总分', Math.abs(scored.factors.reduce((s, f) => s + f.score, 0) - scored.score) < 1.5, scored.factors);
check('大周期共振时因子满分区间合理', scored.factors.find(f => f.label.startsWith('大周期')).score >= 15, scored.factors[0]);

const weakView = {
  tfs: {
    '3m': { close: 60120, open: 60050, ema9: 59900, ema21: 60000, ema50: 60100, ema21SlopeAtr: -0.5,
      rsi: 76, rsiPrev: 74, atr: 100, atrPct: 95, atrRatio: 2.5, adx: 12, plusDI: 12, minusDI: 30,
      macdHist: -20, macdPrevHist: -25, vol: { volRatioAdj: 0.9, takerBuyRatio: 0.4 },
      swing: { pattern: 'LH-LL', higherHigh: false, higherLow: false, lastSwingHigh: 60400, lastSwingLow: 59900 } }
  },
  higherBias: -40, systemBias: -35
};
const weakScored = api.scoreEntrySetup('3m', 'BUY', { kind: 'pullback' }, weakView, 60120);
check('逆势+弱结构setup评分 < 60 (会被阈值拒绝)', weakScored.score < 60, weakScored.score);

console.log('== 6. 端到端: 模拟tick流触发信号 ==');
(async () => {
  // 恢复上涨视图 (1m 最后一根 crafted 成放量阳线, 3m 最后一根放量)
  // 注: drift/vol 调到真实市场区间 (3m RSI 约 60-75, 而非合成数据的 94)
  const gen = (tf, ms) => mkKlines(150, 60000, 0.0003, 0.0016, ms, 99);
  const k1 = gen('1m', 60000);
  const k3 = gen('3m', 180000);
  const last1 = k1[k1.length - 1];
  last1.open = last1.close - 60; last1.close = last1.open + 120; last1.volume = 400; last1.takerBuyVolume = 260;
  const last3 = k3[k3.length - 1];
  last3.volume = 400; last3.takerBuyVolume = 260;
  const kl = { '1m': k1, '3m': k3, '5m': gen('5m', 300000), '15m': gen('15m', 900000), '1h': gen('1h', 3600000) };
  for (const tf of ['1m', '3m', '5m', '15m', '1h']) {
    api.klineStore.BTCUSDT[tf] = { klines: kl[tf], updatedAt: Date.now() };
  }
  api.computeMarketView('BTCUSDT');
  api.semiautoConfig.direction = 'BULL';
  api.semiautoConfig.updatedAt = Date.now() - 100000;

  const m = api.marketViews.BTCUSDT.tfs['3m'];
  const base = m.ema21 + m.atr * 0.2;
  // 先在区域外, 再跌入区域(布防), 再拉回出现更高低点(确认)
  const tickSeries = [
    base + m.atr * 3, base + m.atr * 2, base + m.atr * 1.2,
    base + m.atr * 0.5, base, base - m.atr * 0.2, base - m.atr * 0.4,
    base - m.atr * 0.2, base + m.atr * 0.05, base + m.atr * 0.2, base + m.atr * 0.35, base + m.atr * 0.5
  ];
  let fired = 0;
  for (const px of tickSeries) {
    await api.processLiveTick('BTCUSDT', px);
    const sigs = api.signalRegistry.BTCUSDT;
    fired = sigs['3m'].length + sigs['5m'].length + sigs['10m'].length;
    if (fired > 0) break;
  }
  const allSigs = [...api.signalRegistry.BTCUSDT['3m'], ...api.signalRegistry.BTCUSDT['5m'], ...api.signalRegistry.BTCUSDT['10m']];
  check('tick 流触发了信号', allSigs.length > 0);
  if (allSigs.length) {
    const sig = allSigs[0];
    check('信号带质量评分', typeof sig.score === 'number', sig.score);
    check('信号带评分因子明细', Array.isArray(sig.factors) && sig.factors.length === 7, sig.factors && sig.factors.length);
    check('信号带多周期分值', sig.mtfScore && typeof sig.mtfScore['1h'] === 'number', sig.mtfScore);
    check('信号方向为用户锁定方向(BULL->做多)', sig.typeKey === 'BUY', sig.typeKey);
    console.log('    信号详情:', JSON.stringify({ tf: sig.timeframe, type: sig.type, score: sig.score, pattern: sig.wavePattern, sys: sig.systemBias }));
  }

  // 自适应冷却: 亏损后 lastResult 记录为 LOSS (供冷却倍数使用), 已无连亏暂停
  api.signalRegistry.BTCUSDT['5m'].length = 0;
  for (let i = 0; i < 3; i++) {
    api.signalRegistry.BTCUSDT['5m'].push({
      id: 'perf-' + i, symbol: 'BTCUSDT', coin: 'BTC', timeframe: '5m', version: 'semiauto',
      type: '做多', typeKey: 'BUY', wavePattern: 'test', price: base + 500, time: '00:00:00',
      openTime: Date.now() - 60000, triggerTime: Date.now() - 60000,
      settleTime: Date.now() - 1000, settlePrice: null, status: '等'
    });
  }
  await api.processLiveTick('BTCUSDT', base);
  const perf5 = api.perfMemory.BTCUSDT['5m'];
  check('亏损后 lastResult=LOSS (供自适应冷却)', perf5.lastResult === 'LOSS', perf5);
  check('已删除连亏暂停字段', !('pausedUntil' in perf5), perf5);

  console.log('== 7. 增强统计 ==');
  const fakeList = [];
  for (let i = 0; i < 12; i++) fakeList.push({ status: i % 3 === 0 ? '败' : '吃' }); // 8胜4负
  fakeList.push({ status: '平' }, { status: '废' });
  const st = api.enhancedStats(fakeList);
  check('胜率 66.7%', st.rate === '66.7', st.rate);
  check('期望值 (8*0.8-4*1)/12=0.2', Math.abs(st.expectancy - 0.2) < 0.001, st.expectancy);
  check('盈亏比 6.4/4=1.6', Math.abs(st.profitFactor - 1.6) < 0.001, st.profitFactor);
  check('平局/作废单独计数', st.ties === 1 && st.voids === 1, st);
  check('最大连亏 1', st.maxLossStreak === 1, st.maxLossStreak);
  check('置信区间为正', st.ci95 > 0, st.ci95);

  console.log('== 8. 结算完整性 (停机陈旧信号判废) ==');
  api.signalRegistry.BTCUSDT['3m'].length = 0;
  api.signalRegistry.BTCUSDT['3m'].push({
    id: 'test-stale', symbol: 'BTCUSDT', coin: 'BTC', timeframe: '3m', version: 'semiauto',
    type: '做多', typeKey: 'BUY', wavePattern: 'test', price: 60000, time: '00:00:00',
    openTime: Date.now() - 600000, triggerTime: Date.now() - 600000,
    settleTime: Date.now() - 300000, settlePrice: null, status: '等'
  });
  await api.processLiveTick('BTCUSDT', 61000);
  check('停机 5 分钟前的挂单被判废', api.signalRegistry.BTCUSDT['3m'][0].status === '废', api.signalRegistry.BTCUSDT['3m'][0].status);

  // 平局测试
  api.signalRegistry.BTCUSDT['3m'].length = 0;
  api.signalRegistry.BTCUSDT['3m'].push({
    id: 'test-tie', symbol: 'BTCUSDT', coin: 'BTC', timeframe: '3m', version: 'semiauto',
    type: '做多', typeKey: 'BUY', wavePattern: 'test', price: 60000, time: '00:00:00',
    openTime: Date.now() - 60000, triggerTime: Date.now() - 60000,
    settleTime: Date.now() - 1000, settlePrice: null, status: '等'
  });
  await api.processLiveTick('BTCUSDT', 60000);
  check('结算价=入场价判平局', api.signalRegistry.BTCUSDT['3m'][0].status === '平', api.signalRegistry.BTCUSDT['3m'][0].status);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();
