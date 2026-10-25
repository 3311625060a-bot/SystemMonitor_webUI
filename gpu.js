// 显卡身份识别：把 Windows GPU 性能计数器的适配器与 WMI 名称、nvidia-smi 数据对齐。
// 识别结果不确定时绝不下结论，统一回退为 GPU 0 / GPU 1 这类中性标签。

const VIRTUAL_RE = /virtual|basic display|basic render|remote|parsec|spacedesk|todesk|sunlogin|oray|displaylink|idd|meta quest|oculus|render driver|mirror|warp/i;
const DISCRETE_RE = /geforce|rtx\s?\d|gtx\s?\d|quadro|tesla|radeon\s+(rx|pro|vii)|firepro|arc(\(tm\))?\s+[ab]\d|arc\s+pro|instinct/i;
const INTEGRATED_RE = /uhd graphics|iris|hd graphics|intel.*graphics|radeon.*graphics|radeon\(tm\)|vega.*graphics|radeon\s+\d{3}m|arc(\(tm\))?\s*graphics|arc(\(tm\))?\s*\d{3}v|apu/i;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 只保留真实存在的适配器；虚拟显示器 / 基础渲染驱动会带 0 显存，直接丢掉。
function usableAdapters(adapters) {
  return (Array.isArray(adapters) ? adapters : [])
    .filter((a) => a && typeof a.luid === 'string')
    .map((a) => ({
      key: a.luid,
      dedicatedMB: num(a.dedicatedMB),
      sharedMB: num(a.sharedMB),
      usagePercent: a.usagePercent == null ? null : num(a.usagePercent),
      engines: num(a.engines),
    }))
    .filter((a) => a.dedicatedMB > 16 || a.sharedMB > 32)
    .sort((a, b) => b.dedicatedMB - a.dedicatedMB);
}

function wmiNames(wmiGpus) {
  return (Array.isArray(wmiGpus) ? wmiGpus : [])
    .map((g) => (g && g.model) || '')
    .filter((n) => n && !VIRTUAL_RE.test(n));
}

function baseEntry(adapter, kind, label, shortLabel, model, confidence) {
  return {
    key: adapter ? adapter.key : 'gpu',
    kind,
    label,
    shortLabel,
    model,
    confidence,
    usagePercent: adapter ? adapter.usagePercent : null,
    dedicatedUsedMB: adapter ? adapter.dedicatedMB : 0,
    sharedUsedMB: adapter ? adapter.sharedMB : 0,
    temp: null,
    vramUsedMB: null,
    vramTotalMB: 0,
  };
}

export function classifyGpuAdapters(adapters, nvidiaGpus = [], wmiGpus = []) {
  const clean = usableAdapters(adapters);
  const names = wmiNames(wmiGpus);
  const integratedNames = names.filter((n) => INTEGRATED_RE.test(n) && !DISCRETE_RE.test(n));
  const discreteNames = names.filter((n) => DISCRETE_RE.test(n));

  const entries = [];
  const used = new Set();

  // 1. nvidia-smi 提供显存用量，用它和每条适配器的专用显存用量做匹配，最可靠。
  for (const ng of Array.isArray(nvidiaGpus) ? nvidiaGpus : []) {
    let bestIdx = -1;
    let bestDiff = Infinity;
    clean.forEach((a, i) => {
      if (used.has(i)) return;
      const diff = Math.abs(a.dedicatedMB - num(ng.vramUsedMB));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    const tolerance = Math.max(384, num(ng.vramUsedMB) * 0.4);
    if (bestIdx >= 0 && bestDiff <= tolerance) {
      used.add(bestIdx);
      const e = baseEntry(clean[bestIdx], 'discrete', '独立显卡', '独显', ng.model || 'NVIDIA GPU', 'high');
      e.usagePercent = ng.usagePercent != null ? num(ng.usagePercent) : e.usagePercent;
      e.temp = ng.temp != null ? num(ng.temp) : null;
      e.vramUsedMB = num(ng.vramUsedMB);
      e.vramTotalMB = num(ng.vramTotalMB);
      entries.push(e);
    } else {
      // 计数器和 nvidia-smi 对不上：保留 nvidia 的详情，但不抢占任何适配器。
      const e = baseEntry(null, 'discrete', '独立显卡', '独显', ng.model || 'NVIDIA GPU', 'low');
      e.key = 'nvidia:' + (ng.model || 'gpu');
      e.usagePercent = ng.usagePercent != null ? num(ng.usagePercent) : null;
      e.temp = ng.temp != null ? num(ng.temp) : null;
      e.vramUsedMB = num(ng.vramUsedMB);
      e.vramTotalMB = num(ng.vramTotalMB);
      entries.push(e);
    }
  }

  const rest = clean.filter((_, i) => !used.has(i));

  // 2. 核显的典型特征：专用显存很小（共享系统内存），共享显存明显大于专用显存。
  let igIdx = -1;
  let igConf = 'low';
  const igCandidates = rest
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.dedicatedMB < 1024 && a.sharedMB >= 128);
  if (igCandidates.length) {
    const top = igCandidates.reduce((m, c) => (c.a.sharedMB > m.a.sharedMB ? c : m));
    if (top.a.sharedMB >= 256 && top.a.sharedMB > top.a.dedicatedMB) {
      igIdx = clean.indexOf(top.a);
      igConf = 'high';
    }
  }

  const integratedAdapter = igIdx >= 0 ? clean[igIdx] : null;
  const others = rest.filter((a) => a !== integratedAdapter);

  // 3. 非绑定适配器的独显：专用显存足够大，或“核显之外只剩一块卡 + 系统只报告了一个独显名称”。
  for (const a of others) {
    const nameMatched = others.length === 1 && !!integratedAdapter && discreteNames.length === 1;
    const looksDiscrete = nameMatched || (a.dedicatedMB >= 1536 && a.sharedMB < a.dedicatedMB * 2.5);
    const model = looksDiscrete
      ? (discreteNames.length === 1 ? discreteNames[0] : '独立显卡')
      : '';
    entries.push(baseEntry(a, looksDiscrete ? 'discrete' : 'unknown', '', '', model, 'low'));
  }

  if (integratedAdapter) {
    const model = integratedNames.length === 1 ? integratedNames[0] : '集成显卡';
    entries.push(baseEntry(integratedAdapter, 'integrated', '核显', '核显', model, igConf));
  }

  // 4. 单显卡机器：WMI 名称优先，其次看计数器特征；都说不准时用中性标签兜底。
  //    切换按钮由前端按显卡数量隐藏，单卡机器不会出现独显/核显切换。
  if (entries.length === 1) {
    const only = entries[0];
    const onlyName = names.length === 1 ? names[0] : '';
    const nameSaysIntegrated = integratedNames.length === 1 && discreteNames.length === 0;
    const nameSaysDiscrete = discreteNames.length === 1 && integratedNames.length === 0;
    const strongIntegratedCounter =
      only.kind === 'integrated' &&
      only.dedicatedUsedMB < 512 &&
      only.sharedUsedMB > only.dedicatedUsedMB * 2;

    if (nameSaysIntegrated) {
      only.kind = 'integrated';
      only.label = '核显';
      only.shortLabel = '核显';
      only.confidence = 'high';
      if (onlyName) only.model = onlyName;
    } else if (nameSaysDiscrete) {
      only.kind = 'discrete';
      only.label = '独立显卡';
      only.shortLabel = '独显';
      if (only.confidence !== 'high') only.confidence = 'medium';
      if (onlyName) only.model = onlyName;
    } else if (only.kind === 'discrete') {
      only.label = '独立显卡';
      only.shortLabel = '独显';
      if (only.confidence !== 'high') only.confidence = 'medium';
    } else if (strongIntegratedCounter) {
      only.kind = 'integrated';
      only.label = '核显';
      only.shortLabel = '核显';
      only.confidence = 'high';
    } else {
      only.kind = 'primary';
      only.label = '显卡';
      only.shortLabel = 'GPU';
      only.confidence = 'low';
      only.model = onlyName || '显卡';
    }
  }

  // 5. 兜底标签：没有确定身份的条目按位置编号为 GPU 0 / GPU 1，绝不猜测。
  entries.forEach((e, i) => {
    if (e.label) return;
    if (e.kind === 'discrete') {
      e.label = '独立显卡';
      e.shortLabel = '独显';
    } else {
      e.kind = 'unknown';
      e.label = 'GPU ' + i;
      e.shortLabel = 'GPU ' + i;
      if (!e.model) e.model = 'GPU ' + i;
    }
  });

  // 6. 排序：独显 → 核显 → 未识别，保证切换按钮和曲线槽位稳定。
  const rank = { discrete: 0, primary: 0, integrated: 1, unknown: 2 };
  entries.sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3));

  // 多块同类型显卡时追加序号，避免出现两个一模一样的按钮。
  const counts = {};
  for (const e of entries) counts[e.label] = (counts[e.label] || 0) + 1;
  const seen = {};
  for (const e of entries) {
    const count = counts[e.label];
    if (count > 1) {
      seen[e.label] = (seen[e.label] || 0) + 1;
      const n = seen[e.label];
      e.label = `${e.label} ${n}`;
      e.shortLabel = `${e.shortLabel} ${n}`;
    }
  }

  return entries;
}
