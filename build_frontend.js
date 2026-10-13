const fs = require('fs');

const srcPath = 'c:/APPS/Projects/crypto-signal/public/index.html';
const destPath = 'c:/APPS/Projects/crypto-semiauto/public/index.html';

let html = fs.readFileSync(srcPath, 'utf8');

// 1. Replace title
html = html.replace(
  '<title>币安uiKlines原生高频事件合约预测系统</title>',
  '<title>币安uiKlines半自动多空合约预测系统</title>'
);

// 2. Add Semiauto Direction active styles in CSS
const cssInsert = `
    /* Semiauto Direction Button Active Highlights */
    .dir-bull.active {
      background: rgba(16, 185, 129, 0.25) !important;
      border-color: #10b981 !important;
      color: #34d399 !important;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.35);
    }
    .dir-bear.active {
      background: rgba(239, 68, 68, 0.25) !important;
      border-color: #ef4444 !important;
      color: #f87171 !important;
      box-shadow: 0 0 8px rgba(239, 68, 68, 0.35);
    }
    .dir-range.active {
      background: rgba(168, 85, 247, 0.25) !important;
      border-color: #a855f7 !important;
      color: #c084fc !important;
      box-shadow: 0 0 8px rgba(168, 85, 247, 0.35);
    }
`;
html = html.replace('</style>', `${cssInsert}\n  </style>`);

// 3. Replace version switch bar with Semiauto badge in Header
const oldVersionBarStart = '<!-- Version Switch Bar (正式版 vs 顺势版) -->';
const oldVersionBarEnd = '<div class="ver-backend-tag" title="双引擎后台全天候独立运行，切换版本即享真实订单与胜率">\n          🟢 双引擎后台独立运行\n        </div>\n      </div>';
const vIdx1 = html.indexOf(oldVersionBarStart);
const vIdx2 = html.indexOf(oldVersionBarEnd);
if (vIdx1 !== -1 && vIdx2 !== -1) {
  const newVersionBar = `<!-- Version Switch Bar (半自动系统) -->
      <div class="version-switch-bar" id="version-switch-bar">
        <span class="ver-switch-label">📊 系统:</span>
        <div class="ver-btn-group" id="version-btn-group">
          <button class="ver-btn active" id="btn-ver-semiauto" data-version="semiauto" style="background: rgba(245,158,11,0.18); border-color: #f59e0b; color: #fbbf24;">
            <span class="ver-status-dot" style="background: #fbbf24; box-shadow: 0 0 6px #fbbf24;"></span>
            <span>半自动研判</span>
            <span class="ver-desc-tag" style="background: rgba(245,158,11,0.25); color: #fbbf24;">(12h锁定+共振)</span>
          </button>
        </div>
        <div class="ver-backend-tag" title="半自动后台全天候独立运行，结合12h大方向与多周期共振">
          🟢 12h主趋势引擎全天候运行
        </div>
      </div>`;
  html = html.slice(0, vIdx1) + newVersionBar + html.slice(vIdx2 + oldVersionBarEnd.length);
} else {
  console.error('Error finding version bar');
}

// 4. Insert Compact 12H Macro Direction Bar right below the Signal Bar
const oldSignalBarEnd = `<div class="sig-bar-right">\n      <span class="sig-cur-badge" id="sig-cur-badge">当前图表标记: 3分钟合约信号</span>\n    </div>\n  </div>`;
const newDirectionBar = `<div class="sig-bar-right">
      <span class="sig-cur-badge" id="sig-cur-badge">当前图表标记: 3分钟合约信号</span>
    </div>
  </div>

  <!-- Semiauto 12H Macro Direction Bar (Compact & Intuitive) -->
  <div class="signal-bar" id="semiauto-direction-bar" style="border-top: 1px solid rgba(255,255,255,0.06); background: rgba(15, 23, 42, 0.75); padding: 4px 16px;">
    <div class="sig-bar-left" style="gap: 8px;">
      <span class="sig-bar-label" style="color: #fbbf24; font-weight: 700;">🎯 12h大方向锁定:</span>
      <div class="signal-tf-pills" id="semiauto-dir-group">
        <button class="sig-tf-pill dir-bull" data-dir="BULL" style="font-weight: 700; cursor: pointer;">🚀 看多(主升)</button>
        <button class="sig-tf-pill dir-bear" data-dir="BEAR" style="font-weight: 700; cursor: pointer;">🩸 看空(主跌)</button>
        <button class="sig-tf-pill dir-range" data-dir="RANGE" style="font-weight: 700; cursor: pointer;">🔄 震荡(博弈)</button>
      </div>
      <span class="sig-bar-hint" id="semiauto-cur-status-pill" style="color: #34d399; font-weight: 600;">当前: 🚀 看多(主升)</span>
    </div>
    <div class="sig-bar-right" style="gap: 10px;">
      <span class="sig-cur-badge" id="pred-resonance" style="background: rgba(245,158,11,0.15); color: #fbbf24; border-color: rgba(245,158,11,0.3);">12h锁定: 看多 · 多头主升共振</span>
    </div>
  </div>`;
html = html.replace(oldSignalBarEnd, newDirectionBar);

// 5. Update AppState.version to 'semiauto' and add macroDirection
html = html.replace(
  "version: 'official',",
  "version: 'semiauto',\n      macroDirection: 'BULL',"
);

// 6. Update clampPanOffset
html = html.replace(
  `clampPanOffset() {
        if (!this.klines || !this.klines.length) {
          this.panOffset = 0;
          this.panOffsetY = 0;
          return;
        }
        const barStep = this.candleWidth + this.candleGap;
        // Generous right pan to view historical bars
        const maxOffset = (this.klines.length * barStep) + (this.width * 0.6);
        // Generous left pan to view future empty space
        const minOffset = -Math.max(600, this.width * 0.75);
        this.panOffset = Math.max(minOffset, Math.min(maxOffset, this.panOffset));

        // Limit vertical pan so chart doesn't disappear completely
        const maxYOffset = Math.max(800, (this.height || 600) * 2);
        this.panOffsetY = Math.max(-maxYOffset, Math.min(maxYOffset, this.panOffsetY));
      }`,
  `clampPanOffset() {
        if (isNaN(this.panOffset)) this.panOffset = 0;
        if (isNaN(this.panOffsetY)) this.panOffsetY = 0;
        if (!this.klines || !this.klines.length) {
          this.panOffset = 0;
          this.panOffsetY = 0;
          return;
        }
        const w = (this.width && this.width > 0) ? this.width : (this.container ? this.container.clientWidth : 800) || 800;
        const h = (this.height && this.height > 0) ? this.height : (this.container ? this.container.clientHeight : 500) || 500;
        const barStep = this.candleWidth + this.candleGap;
        const maxOffset = (this.klines.length * barStep) + (w * 0.6);
        const minOffset = -Math.max(600, w * 0.75);
        this.panOffset = Math.max(minOffset, Math.min(maxOffset, this.panOffset));

        const maxYOffset = Math.max(800, h * 2);
        this.panOffsetY = Math.max(-maxYOffset, Math.min(maxYOffset, this.panOffsetY));
      }`
);

// 7. Update resize
html = html.replace(
  `resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.container.getBoundingClientRect();
        const width = Math.floor(rect.width) || this.container.clientWidth;
        const height = Math.floor(rect.height) || this.container.clientHeight;

        if (width <= 0 || height <= 0) return;

        this.canvas.width = Math.floor(width * dpr);
        this.canvas.height = Math.floor(height * dpr);
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.width = width;
        this.height = height;

        this.clampPanOffset();
        this.render();
      }`,
  `resize() {
        if (!this.container || !this.canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = this.container.getBoundingClientRect();
        const width = Math.floor(rect.width) || this.container.clientWidth;
        const height = Math.floor(rect.height) || this.container.clientHeight;

        if (width <= 0 || height <= 0) return;

        this.canvas.width = Math.floor(width * dpr);
        this.canvas.height = Math.floor(height * dpr);
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.width = width;
        this.height = height;

        if (isNaN(this.panOffset)) this.panOffset = 0;
        if (isNaN(this.panOffsetY)) this.panOffsetY = 0;
        this.clampPanOffset();
        this.render();
      }`
);

// 8. Update setData
html = html.replace(
  `setData(klines, markers = []) {
        const prevLen = this.klines ? this.klines.length : 0;
        this.klines = klines || [];
        this.markers = markers || [];
        // If user is actively dragging or scaling price, do not interrupt viewport
        if (this.isDragging || this.isPriceScaling) {
          return;
        }
        // If user is looking at historical candles, offset when new bar arrives
        if (this.panOffset > 40 && prevLen > 0 && this.klines.length > prevLen) {
          const barStep = this.candleWidth + this.candleGap;
          this.panOffset += (this.klines.length - prevLen) * barStep;
        }
        this.clampPanOffset();
        this.render();
      }`,
  `setData(klines, markers = []) {
        const prevLen = this.klines ? this.klines.length : 0;
        this.klines = klines || [];
        this.markers = markers || [];
        if (isNaN(this.panOffset)) this.panOffset = 0;
        if (isNaN(this.panOffsetY)) this.panOffsetY = 0;
        if (!this.width || this.width <= 0 || !this.height || this.height <= 0) {
          this.resize();
        }
        if (this.isDragging || this.isPriceScaling) {
          return;
        }
        if (this.panOffset > 40 && prevLen > 0 && this.klines.length > prevLen) {
          const barStep = this.candleWidth + this.candleGap;
          this.panOffset += (this.klines.length - prevLen) * barStep;
        }
        this.clampPanOffset();
        this.render();
      }`
);

// 9. Update loadKlinesData using exact start and end in crypto-signal
const loadKlinesStart = 'async function loadKlinesData() {';
const loadKlinesEnd = "console.error('loadKlinesData error:', err);\n      }\n    }";
const lIdx1 = html.indexOf(loadKlinesStart);
const lIdx2 = html.indexOf(loadKlinesEnd);
if (lIdx1 !== -1 && lIdx2 !== -1) {
  const newLoadKlines = `async function loadKlinesData() {
      const curSeq = ++klinesReqSeq;
      const targetSymbol = AppState.symbol;
      const targetInterval = AppState.interval;
      const targetSignalTf = AppState.signalTf;
      const targetVersion = AppState.version;

      try {
        const res = await fetch(\`/api/klines/\${targetSymbol}/\${targetInterval}?signalTf=\${targetSignalTf}&version=\${targetVersion}&limit=500\`);
        const data = await res.json();

        // Discard stale responses if user switched symbol or interval during the request
        if (curSeq !== klinesReqSeq) return;
        if (!data || data.symbol !== AppState.symbol || data.interval !== AppState.interval) {
          return;
        }

        if (!data.klines || !data.klines.length) return;

        chart1.setData(data.klines, data.markers);
        AppState.lastCandle = data.klines[data.klines.length - 1];
        updateCandleInfo(AppState.lastCandle);

        // Immediate first-render guarantee
        if (!window._initialChartReady) {
          window._initialChartReady = true;
          chart1.resetView();
          setTimeout(() => chart1.render(), 50);
          setTimeout(() => chart1.render(), 150);
        }

        // Card 1: 实时信号 (当前信号周期入场信号)
        renderSignalsList(data.recentSignals || []);

        // Update Version Badges on Cards
        const verLabel = '半自动';
        const verBg = 'rgba(245,158,11,0.15)';
        const verColor = '#fbbf24';
        const tagSig = document.getElementById('cur-ver-tag-signals');
        const tagNotif = document.getElementById('cur-ver-tag-notifs');
        const tagBt = document.getElementById('cur-ver-tag-bt');
        if (tagSig) {
          tagSig.textContent = \`当前周期: \${AppState.signalTf}\`;
          tagSig.style.background = verBg;
          tagSig.style.color = verColor;
        }
        if (tagNotif) {
          tagNotif.textContent = verLabel;
          tagNotif.style.background = verBg;
          tagNotif.style.color = verColor;
        }
        if (tagBt) {
          tagBt.textContent = verLabel;
          tagBt.style.background = verBg;
          tagBt.style.color = verColor;
        }

        // Update Stats on Card 1
        if (data.stats) {
          const elWinRate = document.getElementById('sig-winrate');
          const elTodayTot = document.getElementById('sig-today-total');
          const elWin = document.getElementById('sig-win-count');
          const elLoss = document.getElementById('sig-loss-count');
          const elPending = document.getElementById('sig-pending-count');
          if (elWinRate) elWinRate.textContent = \`\${data.stats.winRate}%\`;
          if (elTodayTot) elTodayTot.textContent = data.stats.todayTotal;
          if (elWin) elWin.textContent = data.stats.winCount;
          if (elLoss) elLoss.textContent = data.stats.lossCount;
          if (elPending) elPending.textContent = data.stats.pendingCount;
        }

        if (AppState.isSplitScreen && chart2) {
          loadChart2Data();
        }
      } catch (err) {
        console.error('loadKlinesData error:', err);
      }
    }`;
  html = html.slice(0, lIdx1) + newLoadKlines + html.slice(lIdx2 + loadKlinesEnd.length);
} else {
  console.error('Error finding loadKlinesData');
}

// 10. Update loadNotifications() to fetch all 177+ signals without dropping
html = html.replace(
  "queryParams.append('version', AppState.version);",
  "queryParams.append('version', 'ALL');"
);

// 11. Replace initVersionSwitch with initSemiautoController
const verSwitchStart = '// Version Switching Controller (正式版 vs 顺势版)\n    function initVersionSwitch() {';
const verSwitchEnd = '// 9. Start Real-time Data Loops & Theme Palette';
const vsIdx1 = html.indexOf(verSwitchStart);
const vsIdx2 = html.indexOf(verSwitchEnd);
if (vsIdx1 !== -1 && vsIdx2 !== -1) {
  const newSemiautoController = `// Semiauto Controller (12H Macro Direction)
    function initSemiautoController() {
      AppState.version = 'semiauto';

      function syncSemiautoDirectionUI(dir) {
        AppState.macroDirection = dir;
        document.querySelectorAll('#semiauto-dir-group .sig-tf-pill').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-dir') === dir);
        });
        const statusPill = document.getElementById('semiauto-cur-status-pill');
        if (statusPill) {
          if (dir === 'BULL') {
            statusPill.textContent = '当前: 🚀 看多 · 多头主升 (顺应12h大周期)';
            statusPill.style.color = '#34d399';
          } else if (dir === 'BEAR') {
            statusPill.textContent = '当前: 🩸 看空 · 空头主跌 (顺应12h大周期)';
            statusPill.style.color = '#f87171';
          } else {
            statusPill.textContent = '当前: 🔄 震荡 · 区间博弈 (高抛低吸)';
            statusPill.style.color = '#c084fc';
          }
        }
        const resonance = document.getElementById('pred-resonance');
        if (resonance) {
          const dirText = dir === 'BULL' ? '看多 · 多头主升' : (dir === 'BEAR' ? '看空 · 空头主跌' : '震荡 · 区间博弈');
          resonance.textContent = \`12h锁定: \${dirText}共振\`;
        }
      }

      // Initial load of semiauto config from server
      fetch('/api/semiauto/config').then(r => r.json()).then(cfg => {
        if (cfg && (cfg.macroDirection || cfg.direction)) {
          syncSemiautoDirectionUI(cfg.macroDirection || cfg.direction);
        }
      }).catch(() => {});

      // Click binding
      document.querySelectorAll('#semiauto-dir-group .sig-tf-pill').forEach(btn => {
        btn.addEventListener('click', async () => {
          const dir = btn.getAttribute('data-dir');
          if (!dir) return;
          syncSemiautoDirectionUI(dir);
          try {
            await fetch('/api/semiauto/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ macroDirection: dir, direction: dir })
            });
          } catch (e) {}
          playBeep('win');
          loadKlinesData();
          loadNotifications();
          loadSignalPredictions();
        });
      });
    }

    `;
  html = html.slice(0, vsIdx1) + newSemiautoController + html.slice(vsIdx2);
} else {
  console.error('Error finding initVersionSwitch, vsIdx1:', vsIdx1, 'vsIdx2:', vsIdx2);
}

// 12. Replace call to initVersionSwitch() with initSemiautoController()
html = html.replace('initVersionSwitch();', 'initSemiautoController();');

fs.writeFileSync(destPath, html, 'utf8');
console.log('Success! Final output size:', fs.statSync(destPath).size);
