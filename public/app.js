const CIRC = 2 * Math.PI * 52;
const MAX_HISTORY = 3600;
const MAX_POINTS = 240;
const RANGES = [60, 300, 900, 3600];
const THEME_KEY = 'theme';
const LANG_KEY = 'lang';
const RANGE_KEY = 'range';

function detectLang() {
  const nav = String(navigator.language || (navigator.languages && navigator.languages[0]) || 'zh').toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}

let lang = detectLang();
try {
  const savedLang = localStorage.getItem(LANG_KEY);
  if (savedLang === 'zh' || savedLang === 'en') lang = savedLang;
} catch (e) {}

let rangeSec = 60;
try {
  const saved = Number(localStorage.getItem(RANGE_KEY));
  if (RANGES.includes(saved)) rangeSec = saved;
} catch (e) {}

const I18N = {
  zh: {
    title: '系统监控',
    themeToDark: '切换到暗黑模式',
    themeToLight: '切换到明亮模式',
    langSwitch: 'Switch to English',
    sysConfig: '系统配置',
    cpuName: '处理器',
    memory: '内存',
    gpuName: '显卡',
    osName: '操作系统',
    boardName: '主板',
    resources: '资源使用',
    cpu: 'CPU',
    history: '使用历史',
    range60: '60 秒',
    range5m: '5 分钟',
    range15m: '15 分钟',
    range1h: '1 小时',
    gpuDetails: '显卡详情',
    power: '电源',
    io: 'I/O 吞吐量',
    netDown: '网络下载',
    netUp: '网络上传',
    diskRead: '磁盘读取',
    diskWrite: '磁盘写入',
    connecting: '连接中...',
    detecting: '检测中...',
    noGpu: '未检测到显卡',
    unknown: '未知',
    usage: '占用率',
    sharedMem: '共享内存',
    vram: '显存',
    temp: '温度',
    state: '状态',
    batteryLevel: '电量',
    charging: '充电中',
    onBattery: '使用电池',
    batteryName: '电池',
    acPower: '交流电',
    notDetected: '未检测到',
    liveAt: '实时 · 更新于',
    disconnected: '连接断开：',
    gpuDiscrete: '独立显卡',
    gpuIntegrated: '核显',
    gpuGeneric: '显卡',
    gpuDiscreteShort: '独显',
    gpuIntegratedShort: '核显',
    seriesCpu: 'CPU %',
    seriesMem: '内存 %',
    seriesVram: '显存 %',
  },
  en: {
    title: 'System Monitor',
    themeToDark: 'Switch to dark mode',
    themeToLight: 'Switch to light mode',
    langSwitch: '切换到中文',
    sysConfig: 'System Info',
    cpuName: 'Processor',
    memory: 'Memory',
    gpuName: 'GPU',
    osName: 'OS',
    boardName: 'Motherboard',
    resources: 'Resource Usage',
    cpu: 'CPU',
    history: 'History',
    range60: '60s',
    range5m: '5m',
    range15m: '15m',
    range1h: '1h',
    gpuDetails: 'GPU Details',
    power: 'Power',
    io: 'I/O Throughput',
    netDown: 'Download',
    netUp: 'Upload',
    diskRead: 'Disk Read',
    diskWrite: 'Disk Write',
    connecting: 'Connecting...',
    detecting: 'Detecting...',
    noGpu: 'No GPU detected',
    unknown: 'Unknown',
    usage: 'Usage',
    sharedMem: 'Shared',
    vram: 'VRAM',
    temp: 'Temp',
    state: 'Status',
    batteryLevel: 'Battery',
    charging: 'Charging',
    onBattery: 'On battery',
    batteryName: 'Battery',
    acPower: 'AC power',
    notDetected: 'Not detected',
    liveAt: 'Live · updated at',
    disconnected: 'Disconnected: ',
    gpuDiscrete: 'Discrete GPU',
    gpuIntegrated: 'Integrated GPU',
    gpuGeneric: 'GPU',
    gpuDiscreteShort: 'dGPU',
    gpuIntegratedShort: 'iGPU',
    seriesCpu: 'CPU %',
    seriesMem: 'Memory %',
    seriesVram: 'VRAM %',
  },
};

function t(key) {
  return I18N[lang]?.[key] ?? I18N.zh[key] ?? key;
}

function gpuSuffix(gpu) {
  const m = String(gpu.label || '').match(/\s(\d+)$/);
  return m ? ` ${m[1]}` : '';
}

function gpuName(gpu) {
  if (lang === 'zh') return gpu.label || t('gpuGeneric');
  if (gpu.kind === 'discrete') return t('gpuDiscrete') + gpuSuffix(gpu);
  if (gpu.kind === 'integrated') return t('gpuIntegrated') + gpuSuffix(gpu);
  if (gpu.kind === 'primary') return t('gpuGeneric') + gpuSuffix(gpu);
  return gpu.label || t('gpuGeneric');
}

function gpuShortName(gpu) {
  if (lang === 'zh') return gpu.shortLabel || t('gpuGeneric');
  if (gpu.kind === 'discrete') return t('gpuDiscreteShort') + gpuSuffix(gpu);
  if (gpu.kind === 'integrated') return t('gpuIntegratedShort') + gpuSuffix(gpu);
  return gpu.shortLabel || t('gpuGeneric');
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function chartColors() {
  return {
    legend: cssVar('--legend', '#8a93a0'),
    tick: cssVar('--tick', '#98a2b3'),
    grid: cssVar('--grid', 'rgba(16, 24, 40, 0.05)'),
    tooltipBg: cssVar('--tooltip-bg', 'rgba(255, 255, 255, 0.97)'),
    tooltipTitle: cssVar('--text', '#1f2937'),
    tooltipBody: cssVar('--text-2', '#4b5563'),
    tooltipBorder: cssVar('--border', '#e8eaee'),
  };
}

const history = {
  t: [],
  cpu: [],
  mem: [],
  gpu: [],
  gpu2: [],
  vram: [],
};

let chart = null;

function setGauge(name, percent) {
  const el = document.querySelector(`[data-gauge="${name}"]`);
  if (!el) return;
  const p = Math.max(0, Math.min(100, percent || 0));
  el.style.strokeDashoffset = CIRC * (1 - p / 100);
  const color = p > 90 ? 'var(--bad)' : p > 70 ? 'var(--warn)' : el.parentElement.parentElement.dataset.color;
  el.style.stroke = color;
}

function initChart() {
  const ctx = document.getElementById('history-chart').getContext('2d');
  const c = chartColors();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: t('seriesCpu'),
          data: [],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          tension: 0.35,
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
        },
        {
          label: t('seriesMem'),
          data: [],
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139, 92, 246, 0.1)',
          tension: 0.35,
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
        },
        {
          label: `${t('gpuGeneric')} %`,
          data: [],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.35,
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
        },
        {
          label: `${t('gpuIntegratedShort')} %`,
          data: [],
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.08)',
          tension: 0.35,
          fill: false,
          borderWidth: 2,
          pointRadius: 0,
          hidden: true,
          available: false,
        },
        {
          label: t('seriesVram'),
          data: [],
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          tension: 0.35,
          fill: false,
          borderWidth: 2,
          pointRadius: 0,
          hidden: true,
          available: false,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 4 } },
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: {
          labels: {
            color: c.legend,
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 16,
            font: { size: 11 },
            filter: (item, data) => data.datasets[item.datasetIndex]?.available !== false,
          },
        },
        tooltip: {
          backgroundColor: c.tooltipBg,
          titleColor: c.tooltipTitle,
          bodyColor: c.tooltipBody,
          borderColor: c.tooltipBorder,
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true,
        },
      },
      scales: {
        x: {
          border: { display: false },
          ticks: { color: c.tick, maxTicksLimit: 8, font: { size: 11 } },
          grid: { display: false },
        },
        y: {
          min: 0,
          max: 100,
          border: { display: false },
          ticks: { color: c.tick, stepSize: 25, font: { size: 11 }, callback: (v) => v + '%' },
          grid: { color: c.grid },
        },
      },
    },
  });
}

function applyChartTheme() {
  if (!chart) return;
  const c = chartColors();
  const opts = chart.options;
  opts.plugins.legend.labels.color = c.legend;
  opts.plugins.tooltip.backgroundColor = c.tooltipBg;
  opts.plugins.tooltip.titleColor = c.tooltipTitle;
  opts.plugins.tooltip.bodyColor = c.tooltipBody;
  opts.plugins.tooltip.borderColor = c.tooltipBorder;
  opts.scales.x.ticks.color = c.tick;
  opts.scales.y.ticks.color = c.tick;
  opts.scales.y.grid.color = c.grid;
  chart.update('none');
}

function refreshThemeLabel() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const label = currentTheme() === 'dark' ? t('themeToLight') : t('themeToDark');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function hasStoredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'dark' || saved === 'light';
  } catch (e) {
    return false;
  }
}

function applyTheme(theme, persist) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (persist) {
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
  }

  const btn = document.getElementById('theme-toggle');
  if (btn) btn.setAttribute('aria-pressed', String(dark));
  refreshThemeLabel();
  applyChartTheme();
}

function applyStaticText() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.textContent = lang === 'zh' ? 'EN' : '中';
    langBtn.title = t('langSwitch');
    langBtn.setAttribute('aria-label', t('langSwitch'));
  }
  refreshThemeLabel();
}

function applyLanguage(refresh = true) {
  applyStaticText();
  if (chart) {
    chart.data.datasets[0].label = t('seriesCpu');
    chart.data.datasets[1].label = t('seriesMem');
    chart.data.datasets[4].label = t('seriesVram');
    applyGpuSeries(lastGpus);
    chart.update('none');
  }
  gpuSignature = '';
  lastGpuHtml = null;
  lastPowerHtml = null;
  updateGpuList(lastGpus);
  if (refresh) {
    loadSystemInfo();
    tick();
  }
}

function pushHistory(ts, cpu, mem, gpu, gpu2, vram) {
  history.t.push(ts);
  history.cpu.push(cpu);
  history.mem.push(mem);
  history.gpu.push(gpu);
  history.gpu2.push(gpu2);
  history.vram.push(vram);
  if (history.t.length > MAX_HISTORY) {
    history.t.shift();
    history.cpu.shift();
    history.mem.shift();
    history.gpu.shift();
    history.gpu2.shift();
    history.vram.shift();
  }
  renderHistory();
}

function bucketAvg(arr, from, to) {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    const v = arr[i];
    if (v == null) continue;
    sum += v;
    count++;
  }
  return count ? sum / count : null;
}

// 长档位自动抽样：按时间窗口取最近数据，超过 MAX_POINTS 时按桶取均值，
// 保证曲线刷新开销与档位无关。
function renderHistory() {
  if (!chart) return;
  const cutoff = Date.now() - rangeSec * 1000;
  let start = 0;
  while (start < history.t.length && history.t[start] < cutoff) start++;

  const total = history.t.length - start;
  const step = Math.max(1, Math.ceil(total / MAX_POINTS));
  const labels = [];
  const cpu = [];
  const mem = [];
  const gpu = [];
  const gpu2 = [];
  const vram = [];

  for (let i = start; i < history.t.length; i += step) {
    const end = Math.min(i + step, history.t.length);
    labels.push(formatTime(new Date(history.t[i])));
    cpu.push(bucketAvg(history.cpu, i, end));
    mem.push(bucketAvg(history.mem, i, end));
    gpu.push(bucketAvg(history.gpu, i, end));
    gpu2.push(bucketAvg(history.gpu2, i, end));
    vram.push(bucketAvg(history.vram, i, end));
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = cpu;
  chart.data.datasets[1].data = mem;
  chart.data.datasets[2].data = gpu;
  chart.data.datasets[3].data = gpu2;
  chart.data.datasets[4].data = vram;
  chart.update('none');
}

function updateRangeToggle() {
  const toggle = document.getElementById('range-toggle');
  if (!toggle) return;
  for (const btn of toggle.querySelectorAll('button')) {
    btn.classList.toggle('on', Number(btn.dataset.range) === rangeSec);
  }
}

function setRange(sec) {
  if (!RANGES.includes(sec) || sec === rangeSec) return;
  rangeSec = sec;
  try { localStorage.setItem(RANGE_KEY, String(sec)); } catch (e) {}
  updateRangeToggle();
  renderHistory();
}

function formatTime(d) {
  return d.toTimeString().slice(0, 8);
}

async function loadSystemInfo() {
  try {
    const r = await fetch('/api/system-info');
    const d = await r.json();
    document.getElementById('hostname').textContent = d.os.hostname || '';
    document.getElementById('os-info').textContent =
      `${d.os.distro} ${d.os.release} (${d.os.arch})`;

    document.getElementById('sys-cpu').textContent = d.cpu.brand || t('unknown');
    document.getElementById('sys-cpu-sub').textContent =
      `${d.cpu.physicalCores}C / ${d.cpu.cores}T · ${d.cpu.speedMaxGHz || d.cpu.speedGHz} GHz`;

    document.getElementById('sys-mem').textContent = `${d.memory.totalGB} GB`;

    if (d.gpus && d.gpus.length > 0) {
      const real = d.gpus.filter((g) => !/virtual|display adapter|basic|remote|parsec|zako|spacedesk/i.test(g.model || ''));
      const list = real.length ? real : d.gpus;
      document.getElementById('sys-gpu').textContent = list.map(g => g.model).join(' · ') || t('unknown');
      document.getElementById('sys-gpu-sub').textContent = '';
    } else {
      document.getElementById('sys-gpu').textContent = t('noGpu');
    }

    document.getElementById('sys-os').textContent = `${d.os.distro} ${d.os.release}`;
    document.getElementById('sys-os-sub').textContent = `Kernel ${d.os.kernel}`;

    document.getElementById('sys-board').textContent =
      (d.baseboard.manufacturer && d.baseboard.model)
        ? `${d.baseboard.manufacturer} ${d.baseboard.model}`
        : t('unknown');
  } catch (e) {
    console.error('Failed to load system info', e);
  }
}

let lastGpuHtml = null;
let lastPowerHtml = null;
let lastGpus = [];
let gpuSignature = '';

let gpuKey = localStorage.getItem('gpu-key') || '';

function selectedGpu(list) {
  return list.find((g) => g.key === gpuKey) || list[0] || null;
}

function updateGpuToggle(gpus) {
  const toggle = document.getElementById('gpu-toggle');
  if (!toggle) return;

  const show = gpus.length > 1;
  const signature = gpus.map((g) => `${g.key}|${gpuName(g)}`).join(',');
  if (signature !== gpuSignature) {
    gpuSignature = signature;
    toggle.innerHTML = '';
    for (const g of gpus) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.key = g.key;
      btn.textContent = gpuName(g);
      toggle.appendChild(btn);
    }
  }
  toggle.hidden = !show;

  if (gpuKey && !gpus.some((g) => g.key === gpuKey)) gpuKey = '';
  for (const btn of toggle.querySelectorAll('button')) {
    btn.classList.toggle('on', gpuKey ? btn.dataset.key === gpuKey : btn === toggle.firstElementChild);
  }
}

function setGpuMode(key) {
  if (!key || key === gpuKey) return;
  gpuKey = key;
  localStorage.setItem('gpu-key', key);
  lastGpuHtml = null;
  updateGpuToggle(lastGpus);
  updateGpuList(lastGpus);
}

// 图表固定展示前两块卡（独显 + 核显/第二块卡），标签由后端识别结果决定。
// 机器上没有的显卡 / 显存信息会从图例和曲线中彻底移除，而不是留一条空线。
function applyGpuSeries(gpus) {
  if (!chart) return;
  const primary = gpus[0];
  const secondary = gpus[1];
  const ds = chart.data.datasets;

  const hasPrimary = !!primary && primary.usagePercent != null;
  const hasSecondary = !!secondary && secondary.usagePercent != null;
  const hasVram = !!primary && primary.vramTotalMB > 0 && primary.vramUsedMB != null;

  ds[2].label = `${primary ? gpuShortName(primary) : 'GPU'} %`;
  ds[3].label = `${secondary ? gpuShortName(secondary) : 'GPU'} %`;

  ds[2].available = hasPrimary;
  ds[3].available = hasSecondary;
  ds[4].available = hasVram;
  for (const i of [2, 3, 4]) ds[i].hidden = !ds[i].available;
}

function updateGpuList(gpus) {
  const container = document.getElementById('gpu-list-container');
  if (!container) return;
  lastGpus = gpus;
  updateGpuToggle(gpus);

  const sel = selectedGpu(gpus);
  if (!sel) {
    if (lastGpuHtml !== 'empty') {
      container.innerHTML = `<div class="muted">${t('noGpu')}</div>`;
      lastGpuHtml = 'empty';
    }
    return;
  }

  const usage = sel.usagePercent != null ? `${Number(sel.usagePercent).toFixed(0)}%` : '--';
  const hasTemp = sel.temp != null;
  const integrated = sel.kind === 'integrated';

  const memLabel = integrated ? t('sharedMem') : (sel.vramTotalMB > 0 ? t('vram') : t('sharedMem'));
  let memValue;
  if (!integrated && sel.vramTotalMB > 0) {
    memValue = `${((sel.vramUsedMB || 0) / 1024).toFixed(1)} / ${(sel.vramTotalMB / 1024).toFixed(1)} GB`;
  } else {
    memValue = `${((sel.sharedUsedMB || 0) / 1024).toFixed(1)} GB`;
  }

  const html = `
      <div class="gpu-row">
        <div class="gpu-model" title="${sel.model || ''}">${sel.model || 'GPU'}</div>
        <div class="gpu-stats${hasTemp ? '' : ' no-temp'}">
          <div class="gpu-stat">
            <div class="gpu-stat-label">${t('usage')}</div>
            <div class="gpu-stat-value">${usage}</div>
          </div>
          <div class="gpu-stat">
            <div class="gpu-stat-label">${memLabel}</div>
            <div class="gpu-stat-value">${memValue}</div>
          </div>
          ${hasTemp ? `
          <div class="gpu-stat">
            <div class="gpu-stat-label">${t('temp')}</div>
            <div class="gpu-stat-value">${sel.temp}°C</div>
          </div>` : ''}
        </div>
      </div>
    `;

  if (html === lastGpuHtml) return;
  lastGpuHtml = html;
  container.innerHTML = html;
}

function updatePower(power) {
  const el = document.getElementById('power-content');
  if (!el) return;

  const html = power
    ? (() => {
        const pct = power.percent || 0;
        const stateText = power.acConnected ? t('charging') : t('onBattery');
        return `
    <div class="power-row">
      <span class="label">${t('state')}</span>
      <span class="val">${stateText}</span>
    </div>
    <div class="power-row">
      <span class="label">${t('batteryLevel')}</span>
      <span class="val">${pct}%</span>
    </div>
    <div class="battery-bar"><div class="battery-fill" style="width:${pct}%"></div></div>`;
      })()
    : `
      <div class="power-row">
        <span class="label">${t('power')}</span>
        <span class="val">${t('acPower')}</span>
      </div>
      <div class="power-row">
        <span class="label">${t('batteryName')}</span>
        <span class="val">${t('notDetected')}</span>
      </div>`;

  if (html === lastPowerHtml) return;
  lastPowerHtml = html;
  el.innerHTML = html;
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const r = await fetch('/api/metrics', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = await r.json();

    document.getElementById('clock').textContent = formatTime(new Date(m.timestamp));

    document.getElementById('cpu-num').textContent = m.cpu.usagePercent.toFixed(1) + '%';
    setGauge('cpu', m.cpu.usagePercent);
    const cpuTemp = document.getElementById('cpu-temp');
    if (m.cpu.temp != null) {
      cpuTemp.hidden = false;
      cpuTemp.textContent = `${t('temp')} ${m.cpu.temp}°C`;
    } else {
      cpuTemp.hidden = true;
      cpuTemp.textContent = '';
    }

    document.getElementById('mem-num').textContent = m.memory.percent.toFixed(1) + '%';
    setGauge('mem', m.memory.percent);
    document.getElementById('mem-sub').textContent =
      `${m.memory.usedGB} / ${m.memory.totalGB} GB`;

    updateGpuList(m.gpus);

    document.getElementById('net-down').textContent = (m.io.netDownMBs || 0).toFixed(2);
    document.getElementById('net-up').textContent = (m.io.netUpMBs || 0).toFixed(2);
    document.getElementById('disk-reads').textContent = (m.io.diskReadMBs || 0).toFixed(2);
    document.getElementById('disk-writes').textContent = (m.io.diskWriteMBs || 0).toFixed(2);

    updatePower(m.power);

    const primary = m.gpus[0] || null;
    const secondary = m.gpus[1] || null;
    applyGpuSeries(m.gpus);

    const gpuUsage = primary && primary.usagePercent != null ? Number(primary.usagePercent) : 0;
    const gpu2Usage = secondary && secondary.usagePercent != null ? Number(secondary.usagePercent) : null;
    const vramPct = primary && primary.vramTotalMB > 0
      ? (primary.vramUsedMB / primary.vramTotalMB) * 100
      : 0;

    pushHistory(
      m.timestamp,
      m.cpu.usagePercent,
      m.memory.percent,
      gpuUsage,
      gpu2Usage,
      vramPct
    );

    document.getElementById('status').textContent =
      `${t('liveAt')} ${formatTime(new Date())}`;
  } catch (e) {
    document.getElementById('status').textContent = `${t('disconnected')}${e.message}`;
  } finally {
    ticking = false;
  }
}

let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  tick();
  pollTimer = setInterval(tick, 1000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

window.addEventListener('DOMContentLoaded', async () => {
  applyTheme(currentTheme(), false);
  initChart();
  applyGpuSeries([]);
  applyStaticText();
  updateRangeToggle();

  // 用户未手动选择过主题时，跟随系统明暗设置实时变化
  const darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (darkMedia && darkMedia.addEventListener) {
    darkMedia.addEventListener('change', (e) => {
      if (!hasStoredTheme()) applyTheme(e.matches ? 'dark' : 'light', false);
    });
  }

  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });
  }

  const langToggle = document.getElementById('lang-toggle');
  if (langToggle) {
    langToggle.addEventListener('click', () => {
      lang = lang === 'zh' ? 'en' : 'zh';
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
      applyLanguage();
    });
  }

  const toggle = document.getElementById('gpu-toggle');
  if (toggle) {
    toggle.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && btn.dataset.key) setGpuMode(btn.dataset.key);
    });
  }

  const rangeToggle = document.getElementById('range-toggle');
  if (rangeToggle) {
    rangeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && btn.dataset.range) setRange(Number(btn.dataset.range));
    });
  }

  await loadSystemInfo();
  if (!document.hidden) startPolling();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else startPolling();
});
