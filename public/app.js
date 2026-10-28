const CIRC = 2 * Math.PI * 52;
const MAX_HISTORY = 3600;
const MAX_POINTS = 240;
const RANGES = [60, 300, 900, 3600];
const THEME_KEY = 'theme';
const LANG_KEY = 'lang';
const RANGE_KEY = 'range';
const POLL_KEY = 'poll';
const POLL_OPTIONS = [1, 2, 5, 10];

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

let pollSec = 1;
try {
  const savedPoll = Number(localStorage.getItem(POLL_KEY));
  if (POLL_OPTIONS.includes(savedPoll)) pollSec = savedPoll;
} catch (e) {}

let authMode = null;
let authBusy = false;
let authErrorKey = '';
let authLocalTrust = true;
// 后台采样策略，由 /api/metrics 带回（托盘开关改的就是它），只用于让提示文案与实际一致。
let samplerIdlePause = true;
let appStarted = false;
let connFailures = 0;
let retryBusy = false;

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
    pollInterval: '页面刷新频率',
    pollHint: '降低刷新频率可减少浏览器与网络开销；页面和托盘面板都停止观测约 2 分钟后，后台采样会自动暂停',
    pollHintResident: '降低刷新频率可减少浏览器与网络开销；后台采样当前常驻运行，可在托盘面板的“空闲时暂停采样”开关改回自动暂停',
    poll1s: '1 秒',
    poll2s: '2 秒',
    poll5s: '5 秒',
    poll10s: '10 秒',
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
    powerDraw: '功耗',
    clock: '频率',
    state: '状态',
    batteryLevel: '电量',
    charging: '充电中',
    onBattery: '使用电池',
    batteryName: '电池',
    acPower: '交流电',
    notDetected: '未检测到',
    liveAt: '实时 · 更新于',
    disconnected: '连接断开：',
    connLost: '连接已断开',
    samplingResuming: '采样恢复中…',
    retry: '重试',
    retrying: '重试中…',
    password: '密码',
    confirmPassword: '确认密码',
    passwordHint: '至少 8 个字符',
    remember: '自动登录',
    showPassword: '显示密码',
    hidePassword: '隐藏密码',
    authSetupTitle: '设置访问密码',
    authSetupSubtitle: '首次使用请设置访问密码，其他设备访问时需要输入。',
    authSetupSubtitleNoTrust: '首次使用请设置访问密码，设置后本机与其他设备都需要登录。',
    authLoginTitle: '访问验证',
    authLoginSubtitle: '此设备不是主机本机，请输入访问密码。',
    authLoginSubtitleNoTrust: '请输入访问密码以继续。',
    authBlockedTitle: '尚未设置密码',
    authBlockedSubtitle: '请在主机本机上打开此页面，完成首次密码设置。',
    authLocalNote: '本机访问将保持免密，无需再次输入。',
    authLocalNoteNoTrust: '本机免密已关闭，设置后本机访问也需要登录。',
    authBlockedNote: '设置完成后刷新此页面即可登录。',
    authSetupAction: '设置并进入',
    authLoginAction: '登录',
    authWorking: '请稍候…',
    errWeakPassword: '密码至少需要 8 个字符',
    errPasswordMismatch: '两次输入的密码不一致',
    errWrongPassword: '密码错误，请重新输入',
    errTooMany: '尝试次数过多，请稍后再试',
    errSetupRequired: '主机尚未设置访问密码，请先在主机上完成设置',
    errSessionExpired: '登录已过期，请重新登录',
    errNetwork: '无法连接到服务，请稍后再试',
    errLocalOnly: '密码只能在本机上设置',
    errAlreadyConfigured: '密码已设置，请直接登录',
    gpuDiscrete: '独立显卡',
    gpuIntegrated: '核显',
    gpuGeneric: '显卡',
    gpuDiscreteShort: '独显',
    gpuIntegratedShort: '核显',
    seriesCpu: 'CPU %',
    seriesMem: '内存 %',
    seriesVram: '显存 %',
    seriesCpuPower: 'CPU W',
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
    pollInterval: 'Page refresh rate',
    pollHint: 'A lower refresh rate reduces browser and network work. Background sampling pauses about 2 minutes after the page and the tray panel stop observing.',
    pollHintResident: 'A lower refresh rate reduces browser and network work. Background sampling currently stays resident — turn the “Pause sampling when idle” switch in the tray panel to resume auto-pausing.',
    poll1s: '1s',
    poll2s: '2s',
    poll5s: '5s',
    poll10s: '10s',
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
    powerDraw: 'Power',
    clock: 'Clock',
    state: 'Status',
    batteryLevel: 'Battery',
    charging: 'Charging',
    onBattery: 'On battery',
    batteryName: 'Battery',
    acPower: 'AC power',
    notDetected: 'Not detected',
    liveAt: 'Live · updated at',
    disconnected: 'Disconnected: ',
    connLost: 'Connection lost',
    samplingResuming: 'Resuming sampling…',
    retry: 'Retry',
    retrying: 'Retrying…',
    password: 'Password',
    confirmPassword: 'Confirm password',
    passwordHint: 'At least 8 characters',
    remember: 'Keep me signed in',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    authSetupTitle: 'Set access password',
    authSetupSubtitle: 'Set a password for access from other devices. Local access stays password-free.',
    authSetupSubtitleNoTrust: 'Set the access password. This host will also require it because local trust is disabled.',
    authLoginTitle: 'Access verification',
    authLoginSubtitle: 'This device is not the host. Enter the access password to continue.',
    authLoginSubtitleNoTrust: 'Enter the access password to continue.',
    authBlockedTitle: 'Password not set',
    authBlockedSubtitle: 'Open this page on the host machine to set the access password first.',
    authLocalNote: 'Local access will stay password-free.',
    authLocalNoteNoTrust: 'Local trust is disabled, so this host will ask for the password too.',
    authBlockedNote: 'Refresh this page after setup to sign in.',
    authSetupAction: 'Set and continue',
    authLoginAction: 'Sign in',
    authWorking: 'Please wait…',
    errWeakPassword: 'Password must be at least 8 characters',
    errPasswordMismatch: 'Passwords do not match',
    errWrongPassword: 'Wrong password, try again',
    errTooMany: 'Too many attempts, try again later',
    errSetupRequired: 'The host has not set an access password yet',
    errSessionExpired: 'Session expired, please sign in again',
    errNetwork: 'Cannot reach the service, try again later',
    errLocalOnly: 'The password can only be set on the host machine',
    errAlreadyConfigured: 'Password already set, please sign in',
    gpuDiscrete: 'Discrete GPU',
    gpuIntegrated: 'Integrated GPU',
    gpuGeneric: 'GPU',
    gpuDiscreteShort: 'dGPU',
    gpuIntegratedShort: 'iGPU',
    seriesCpu: 'CPU %',
    seriesMem: 'Memory %',
    seriesVram: 'VRAM %',
    seriesCpuPower: 'CPU W',
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
  cpuPower: [],
  gpuPower: [],
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
        {
          label: t('seriesCpuPower'),
          data: [],
          borderColor: '#ef4444',
          backgroundColor: 'transparent',
          borderDash: [5, 3],
          tension: 0.35,
          fill: false,
          borderWidth: 1.8,
          pointRadius: 0,
          yAxisID: 'power',
          hidden: true,
          available: false,
        },
        {
          label: `${t('gpuGeneric')} W`,
          data: [],
          borderColor: '#f97316',
          backgroundColor: 'transparent',
          borderDash: [5, 3],
          tension: 0.35,
          fill: false,
          borderWidth: 1.8,
          pointRadius: 0,
          yAxisID: 'power',
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
          callbacks: {
            label: (item) => `${item.dataset.label}: ${Number(item.parsed.y).toFixed(1)}`,
          },
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
        power: {
          display: false,
          position: 'right',
          min: 0,
          border: { display: false },
          ticks: {
            color: c.tick,
            maxTicksLimit: 5,
            font: { size: 11 },
            callback: (v) => v + 'W',
          },
          grid: { drawOnChartArea: false },
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
  if (opts.scales.power) opts.scales.power.ticks.color = c.tick;
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
  updatePollControl();
  refreshThemeLabel();
}

function applyLanguage(refresh = true) {
  applyStaticText();
  if (chart) {
    chart.data.datasets[0].label = t('seriesCpu');
    chart.data.datasets[1].label = t('seriesMem');
    chart.data.datasets[4].label = t('seriesVram');
    applyGpuSeries(lastGpus, lastCpuPower);
    chart.update('none');
  }
  gpuSignature = '';
  lastGpuHtml = null;
  lastPowerHtml = null;
  updateGpuList(lastGpus);
  if (refresh && appStarted) {
    loadSystemInfo();
    tick();
  }
  if (authMode) renderAuthGate();
}

// ---------- 访问验证 ----------
function authElements() {
  return {
    gate: document.getElementById('auth-gate'),
    title: document.getElementById('auth-title'),
    subtitle: document.getElementById('auth-subtitle'),
    form: document.getElementById('auth-form'),
    password: document.getElementById('auth-password'),
    confirm: document.getElementById('auth-confirm'),
    confirmField: document.getElementById('auth-confirm-field'),
    hint: document.getElementById('auth-hint'),
    rememberRow: document.getElementById('auth-remember-row'),
    remember: document.getElementById('auth-remember'),
    error: document.getElementById('auth-error'),
    submit: document.getElementById('auth-submit'),
    note: document.getElementById('auth-note'),
    eye: document.getElementById('auth-eye'),
  };
}

function updateEyeLabel() {
  const els = authElements();
  if (!els.eye || !els.password) return;
  const revealed = els.password.type === 'text';
  const label = revealed ? t('hidePassword') : t('showPassword');
  els.eye.setAttribute('aria-pressed', String(revealed));
  els.eye.setAttribute('aria-label', label);
  els.eye.title = label;
}

function renderAuthGate() {
  if (!authMode) return;
  const els = authElements();
  if (!els.gate) return;

  const setup = authMode === 'setup';
  const blocked = authMode === 'blocked';
  els.title.textContent = t(setup ? 'authSetupTitle' : blocked ? 'authBlockedTitle' : 'authLoginTitle');
  els.subtitle.textContent = t(setup
    ? (authLocalTrust ? 'authSetupSubtitle' : 'authSetupSubtitleNoTrust')
    : blocked
      ? 'authBlockedSubtitle'
      : (authLocalTrust ? 'authLoginSubtitle' : 'authLoginSubtitleNoTrust'));
  els.form.hidden = blocked;
  els.confirmField.hidden = !setup;
  els.rememberRow.hidden = authMode !== 'login';
  els.hint.hidden = !setup;
  els.note.hidden = authMode === 'login';
  els.note.textContent = setup
    ? t(authLocalTrust ? 'authLocalNote' : 'authLocalNoteNoTrust')
    : blocked ? t('authBlockedNote') : '';
  els.password.setAttribute('autocomplete', setup ? 'new-password' : 'current-password');
  els.submit.disabled = authBusy;
  els.submit.textContent = authBusy
    ? t('authWorking')
    : t(setup ? 'authSetupAction' : 'authLoginAction');

  if (authErrorKey) {
    els.error.textContent = t(authErrorKey);
    els.error.hidden = false;
  } else {
    els.error.hidden = true;
  }
  updateEyeLabel();
}

function openAuthGate(mode, { error = '' } = {}) {
  const els = authElements();
  authMode = mode;
  authErrorKey = error;
  authBusy = false;
  appStarted = false;
  connFailures = 0;
  stopPolling();
  hideConnBanner();

  if (!els.gate) return;
  els.gate.hidden = false;
  document.body.classList.add('auth-locked');
  document.querySelector('main')?.setAttribute('inert', '');
  document.querySelector('footer')?.setAttribute('inert', '');
  document.querySelector('.topbar')?.classList.add('locked');
  els.password.value = '';
  els.password.type = 'password';
  els.confirm.value = '';
  els.confirm.type = 'password';
  els.remember.checked = false;
  els.eye.classList.remove('revealed');
  renderAuthGate();
  if (mode !== 'blocked') {
    requestAnimationFrame(() => els.password.focus());
  }
}

function finishAuth() {
  const els = authElements();
  authBusy = false;
  authMode = null;
  authErrorKey = '';
  els.gate.hidden = true;
  document.body.classList.remove('auth-locked');
  document.querySelector('main')?.removeAttribute('inert');
  document.querySelector('footer')?.removeAttribute('inert');
  document.querySelector('.topbar')?.classList.remove('locked');
  els.password.value = '';
  els.password.type = 'password';
  els.confirm.value = '';
  els.confirm.type = 'password';
  els.remember.checked = false;
  els.eye.classList.remove('revealed');
  startApp();
}

function startApp() {
  if (appStarted) return;
  appStarted = true;
  const status = document.getElementById('status');
  if (status) status.textContent = t('connecting');
  loadSystemInfo();
  if (!document.hidden) startPolling();
}

async function initAuthGate() {
  try {
    const r = await fetch('/api/auth/status', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const status = await r.json();
    authLocalTrust = status.localTrust !== false;
    if (status.needsSetup) {
      const canSetup = status.canSetup !== undefined ? status.canSetup : status.local;
      openAuthGate(canSetup ? 'setup' : 'blocked');
      return;
    }
    if (status.authenticated) {
      startApp();
      return;
    }
    openAuthGate('login');
  } catch (e) {
    openAuthGate('login', { error: 'errNetwork' });
  }
}

function handleAuthLost(kind) {
  stopPolling();
  appStarted = false;
  connFailures = 0;
  hideConnBanner();
  if (kind === 'setup') {
    initAuthGate();
  } else {
    openAuthGate('login', { error: 'errSessionExpired' });
  }
}

function authErrorKeyFor(data) {
  return ({
    weak_password: 'errWeakPassword',
    invalid_password: 'errWrongPassword',
    too_many_attempts: 'errTooMany',
    local_only: 'errLocalOnly',
    invalid_request: 'errWrongPassword',
  })[data && data.error] || 'errNetwork';
}

async function onAuthSubmit(event) {
  event.preventDefault();
  if (!authMode || authBusy || authMode === 'blocked') return;

  const els = authElements();
  const setup = authMode === 'setup';
  const password = els.password.value;
  if (setup) {
    if (password.length < 8) {
      authErrorKey = 'errWeakPassword';
      renderAuthGate();
      return;
    }
    if (password !== els.confirm.value) {
      authErrorKey = 'errPasswordMismatch';
      renderAuthGate();
      return;
    }
  } else if (!password) {
    authErrorKey = 'errWrongPassword';
    renderAuthGate();
    return;
  }

  authBusy = true;
  authErrorKey = '';
  renderAuthGate();
  try {
    const r = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password,
        remember: setup ? false : !!els.remember.checked,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      finishAuth();
      return;
    }
    if (data.error === 'setup_required') {
      await initAuthGate();
      return;
    }
    if (setup && data.error === 'already_configured') {
      openAuthGate('login', { error: 'errAlreadyConfigured' });
      return;
    }
    authErrorKey = authErrorKeyFor(data);
  } catch (e) {
    authErrorKey = 'errNetwork';
  } finally {
    authBusy = false;
    if (authMode) renderAuthGate();
  }
}

function bindAuthEvents() {
  const els = authElements();
  if (!els.gate) return;
  els.form.addEventListener('submit', onAuthSubmit);
  for (const input of [els.password, els.confirm]) {
    input.addEventListener('input', () => {
      if (!authErrorKey) return;
      authErrorKey = '';
      renderAuthGate();
    });
  }
  els.eye.addEventListener('click', () => {
    const reveal = els.password.type === 'password';
    els.password.type = reveal ? 'text' : 'password';
    els.confirm.type = reveal ? 'text' : 'password';
    els.eye.classList.toggle('revealed', reveal);
    updateEyeLabel();
    els.password.focus();
  });
}

function pushHistory(ts, cpu, mem, gpu, gpu2, vram, cpuPower, gpuPower) {
  history.t.push(ts);
  history.cpu.push(cpu);
  history.mem.push(mem);
  history.gpu.push(gpu);
  history.gpu2.push(gpu2);
  history.vram.push(vram);
  history.cpuPower.push(cpuPower);
  history.gpuPower.push(gpuPower);
  if (history.t.length > MAX_HISTORY) {
    history.t.shift();
    history.cpu.shift();
    history.mem.shift();
    history.gpu.shift();
    history.gpu2.shift();
    history.vram.shift();
    history.cpuPower.shift();
    history.gpuPower.shift();
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
  const cpuPower = [];
  const gpuPower = [];

  for (let i = start; i < history.t.length; i += step) {
    const end = Math.min(i + step, history.t.length);
    labels.push(formatTime(new Date(history.t[i])));
    cpu.push(bucketAvg(history.cpu, i, end));
    mem.push(bucketAvg(history.mem, i, end));
    gpu.push(bucketAvg(history.gpu, i, end));
    gpu2.push(bucketAvg(history.gpu2, i, end));
    vram.push(bucketAvg(history.vram, i, end));
    cpuPower.push(bucketAvg(history.cpuPower, i, end));
    gpuPower.push(bucketAvg(history.gpuPower, i, end));
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = cpu;
  chart.data.datasets[1].data = mem;
  chart.data.datasets[2].data = gpu;
  chart.data.datasets[3].data = gpu2;
  chart.data.datasets[4].data = vram;
  chart.data.datasets[5].data = cpuPower;
  chart.data.datasets[6].data = gpuPower;
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

function updatePollControl() {
  const select = document.getElementById('poll-interval');
  if (!select) return;
  select.value = String(pollSec);
  select.title = t(samplerIdlePause ? 'pollHint' : 'pollHintResident');
  select.setAttribute('aria-label', t('pollInterval'));
}

function setPollInterval(sec) {
  if (!POLL_OPTIONS.includes(sec) || sec === pollSec) return;
  pollSec = sec;
  try { localStorage.setItem(POLL_KEY, String(sec)); } catch (e) {}
  updatePollControl();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = setInterval(tick, pollSec * 1000);
  }
}

function formatTime(d) {
  return d.toTimeString().slice(0, 8);
}

function formatWatts(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return `${n < 100 ? n.toFixed(1) : Math.round(n)}W`;
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
let lastCpuPower = null;
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
// 机器上没有的显卡 / 显存 / 功耗信息会从图例和曲线中彻底移除，而不是留一条空线。
function applyGpuSeries(gpus, cpuPower = null) {
  if (!chart) return;
  const primary = gpus[0];
  const secondary = gpus[1];
  const ds = chart.data.datasets;

  const hasPrimary = !!primary && primary.usagePercent != null;
  const hasSecondary = !!secondary && secondary.usagePercent != null;
  const hasVram = !!primary && primary.vramTotalMB > 0 && primary.vramUsedMB != null;
  const hasCpuPower = cpuPower != null;
  const hasGpuPower = !!primary && primary.powerW != null;

  ds[2].label = `${primary ? gpuShortName(primary) : 'GPU'} %`;
  ds[3].label = `${secondary ? gpuShortName(secondary) : 'GPU'} %`;
  ds[5].label = t('seriesCpuPower');
  ds[6].label = `${primary ? gpuShortName(primary) : 'GPU'} W`;

  ds[2].available = hasPrimary;
  ds[3].available = hasSecondary;
  ds[4].available = hasVram;
  ds[5].available = hasCpuPower;
  ds[6].available = hasGpuPower;
  for (const i of [2, 3, 4, 5, 6]) ds[i].hidden = !ds[i].available;
  chart.options.scales.power.display = hasCpuPower || hasGpuPower;
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
  const integrated = sel.kind === 'integrated';

  const memLabel = integrated ? t('sharedMem') : (sel.vramTotalMB > 0 ? t('vram') : t('sharedMem'));
  let memValue;
  if (!integrated && sel.vramTotalMB > 0) {
    memValue = `${((sel.vramUsedMB || 0) / 1024).toFixed(1)} / ${(sel.vramTotalMB / 1024).toFixed(1)} GB`;
  } else {
    memValue = `${((sel.sharedUsedMB || 0) / 1024).toFixed(1)} GB`;
  }

  const stats = [
    { label: t('usage'), value: usage },
    { label: memLabel, value: memValue },
  ];
  if (sel.temp != null) stats.push({ label: t('temp'), value: `${Math.round(sel.temp)}°C` });
  if (sel.powerW != null) stats.push({ label: t('powerDraw'), value: formatWatts(sel.powerW) });
  if (sel.clockMHz != null) stats.push({ label: t('clock'), value: `${Math.round(sel.clockMHz)} MHz` });

  const statsHtml = stats.map((s) => `
          <div class="gpu-stat">
            <div class="gpu-stat-label">${s.label}</div>
            <div class="gpu-stat-value">${s.value}</div>
          </div>`).join('');

  const html = `
      <div class="gpu-row">
        <div class="gpu-model" title="${sel.model || ''}">${sel.model || 'GPU'}</div>
        <div class="gpu-stats">${statsHtml}
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

let pollTimer = null;
let tickPromise = null;

function showConnBanner() {
  const banner = document.getElementById('conn-banner');
  if (banner) banner.hidden = false;
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.classList.add('offline');
}

function hideConnBanner() {
  const banner = document.getElementById('conn-banner');
  if (banner) {
    banner.hidden = true;
    banner.classList.remove('retrying');
  }
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.classList.remove('offline');
  const button = document.getElementById('conn-retry');
  if (button) {
    button.disabled = false;
    button.textContent = t('retry');
  }
}

function handleTickSuccess(m) {
  connFailures = 0;
  hideConnBanner();
  // 托盘里改了开关，页面提示要跟着变，否则文案会和实际策略不一致。
  const pause = m && m.sampler ? m.sampler.idlePause : null;
  if (typeof pause === 'boolean' && pause !== samplerIdlePause) {
    samplerIdlePause = pause;
    updatePollControl();
  }
  const status = document.getElementById('status');
  if (!status) return;
  // 空闲暂停后刚恢复时，返回的仍是暂停前的数值，先据实提示而不是声称"实时"。
  if (m && m.sampler && m.sampler.stale) {
    status.textContent = t('samplingResuming');
    return;
  }
  status.textContent = `${t('liveAt')} ${formatTime(new Date())}`;
}

function handleTickFailure() {
  connFailures += 1;
  const status = document.getElementById('status');
  if (status) status.textContent = t('connLost');
  if (appStarted && connFailures >= 2) showConnBanner();
}

function tick() {
  if (tickPromise) return tickPromise;
  tickPromise = doTick().finally(() => { tickPromise = null; });
  return tickPromise;
}

async function doTick() {
  if (!appStarted) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const r = await fetch('/api/metrics', { cache: 'no-store', signal: controller.signal });
    if (r.status === 401) {
      handleAuthLost('login');
      return false;
    }
    if (r.status === 403) {
      const data = await r.json().catch(() => ({}));
      if (data.error === 'setup_required') {
        handleAuthLost('setup');
        return false;
      }
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = await r.json();

    document.getElementById('clock').textContent = formatTime(new Date(m.timestamp));

    document.getElementById('cpu-num').textContent = m.cpu.usagePercent.toFixed(1) + '%';
    setGauge('cpu', m.cpu.usagePercent);
    const cpuSub = document.getElementById('cpu-temp');
    const cpuBits = [];
    if (m.cpu.temp != null) cpuBits.push(`${t('temp')} ${Math.round(m.cpu.temp)}°C`);
    if (m.cpu.powerW != null) cpuBits.push(`${t('powerDraw')} ${formatWatts(m.cpu.powerW)}`);
    cpuSub.hidden = cpuBits.length === 0;
    cpuSub.textContent = cpuBits.join(' · ');

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
    lastCpuPower = m.cpu.powerW ?? null;
    applyGpuSeries(m.gpus, lastCpuPower);

    const gpuUsage = primary && primary.usagePercent != null ? Number(primary.usagePercent) : 0;
    const gpu2Usage = secondary && secondary.usagePercent != null ? Number(secondary.usagePercent) : null;
    const vramPct = primary && primary.vramTotalMB > 0
      ? (primary.vramUsedMB / primary.vramTotalMB) * 100
      : 0;
    const gpuPower = primary && primary.powerW != null ? Number(primary.powerW) : null;

    pushHistory(
      m.timestamp,
      m.cpu.usagePercent,
      m.memory.percent,
      gpuUsage,
      gpu2Usage,
      vramPct,
      lastCpuPower,
      gpuPower
    );

    handleTickSuccess(m);
    return true;
  } catch (e) {
    handleTickFailure();
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function retryConnection() {
  if (retryBusy || !appStarted) return;
  retryBusy = true;
  const banner = document.getElementById('conn-banner');
  const button = document.getElementById('conn-retry');
  if (banner) banner.classList.add('retrying');
  if (button) {
    button.disabled = true;
    button.textContent = t('retrying');
  }

  await tick();

  retryBusy = false;
  if (button) {
    button.disabled = false;
    button.textContent = t('retry');
  }
  if (banner) banner.classList.remove('retrying');
}

function startPolling() {
  if (pollTimer) return;
  tick();
  pollTimer = setInterval(tick, pollSec * 1000);
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
  updatePollControl();

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

  const pollSelect = document.getElementById('poll-interval');
  if (pollSelect) {
    pollSelect.addEventListener('change', () => setPollInterval(Number(pollSelect.value)));
  }

  const connRetry = document.getElementById('conn-retry');
  if (connRetry) connRetry.addEventListener('click', retryConnection);

  bindAuthEvents();
  await initAuthGate();
});

document.addEventListener('visibilitychange', () => {
  if (!appStarted) return;
  if (document.hidden) stopPolling();
  else startPolling();
});
