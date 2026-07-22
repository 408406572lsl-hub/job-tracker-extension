// ============================================================
// autoscan.js — 自动扫描设置页逻辑
// ============================================================

(function () {
  'use strict';

  let cfg = null;

  // 城市名 → BOSS 数字城市码(避免用户填城市名导致扫描无效)
  const CITY_NAME_TO_CODE = {
    '北京': '100010000', '上海': '101020100', '广州': '101280100',
    '深圳': '101280600', '南宁': '101300100', '长沙': '101270100',
    '杭州': '101210100', '武汉': '101200100', '成都': '101110100',
    '南京': '101190100', '佛山': '101280700', '苏州': '101230100',
    '重庆': '101040100', '西安': '101110200', '天津': '101030100',
    '郑州': '101180100', '青岛': '101200200', '东莞': '101281600',
    '昆明': '101290100', '合肥': '101220100', '厦门': '101230200',
    '南昌': '101240100', '福州': '101230300', '贵阳': '101260100',
    '海口': '101310100', '桂林': '101300200', '柳州': '101300300'
  };

  // 反向表:数字城市码 → 城市名(用于回填表单时显示名字而非码)
  const CITY_CODE_TO_NAME = Object.keys(CITY_NAME_TO_CODE).reduce((m, name) => {
    m[CITY_NAME_TO_CODE[name]] = name;
    return m;
  }, {});

  function normalizeCity(raw) {
    if (!raw) return '';
    const v = String(raw).trim();
    if (/^\d{6,}$/.test(v)) return v;            // 已经是数字城市码
    const mapped = CITY_NAME_TO_CODE[v];
    return mapped || v;                           // 城市名→码,否则原样返回
  }

  function resolveCityLabel(raw) {
    const code = normalizeCity(raw);
    if (!code) return '';
    const name = CITY_CODE_TO_NAME[code] || '';
    return name ? (name + ' (' + code + ')') : ('城市码 ' + code);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    // 先绑定返回键:即使后续初始化(getAutoScan 等)抛错,用户也总能返回管理面板
    const backBtn = document.getElementById('btnBack');
    if (backBtn) backBtn.addEventListener('click', () => {
      window.location.href = '../dashboard/dashboard.html';
    });

    try {
      cfg = await JTStorage.getAutoScan();
      fillForm();
      bindEvents();
      updateCityLabel();
      await refreshStatus();
    } catch (e) {
      console.error('[岗位猎手] 自动扫描设置初始化失败:', e);
    }
  });

  function fillForm() {
    // v1.5.30 起定时自动扫描已停用,扫描仅支持手动触发。
    // 这里强制取消勾选并禁用该选项,避免用户误开启(enable 也不会再创建定时闹钟)。
    const enabledEl = document.getElementById('enabled');
    enabledEl.checked = false;
    enabledEl.disabled = true;
    document.getElementById('keywords').value = cfg.keywords || '';
    // 回填时显示城市【名】(如"南宁"),而非数字码
    document.getElementById('city').value = (CITY_CODE_TO_NAME[cfg.city] || cfg.cityName || cfg.city || '');
    document.getElementById('intervalMin').value = cfg.intervalMin || 60;
    document.getElementById('maxJobsPerRun').value = cfg.maxJobsPerRun || 0;
    document.getElementById('enrichDetails').checked = cfg.enrichDetails !== false;
    document.getElementById('autoAnalyze').checked = cfg.autoAnalyze !== false;
    document.getElementById('analyzePerDay').value = cfg.analyzePerDay || 0;
  }

  function collect() {
    const cityRaw = document.getElementById('city').value.trim();
    return {
      enabled: document.getElementById('enabled').checked,
      keywords: document.getElementById('keywords').value.trim(),
      city: normalizeCity(cityRaw),
      cityName: CITY_CODE_TO_NAME[normalizeCity(cityRaw)] || cityRaw || '',
      intervalMin: Math.max(5, parseInt(document.getElementById('intervalMin').value, 10) || 60),
      maxJobsPerRun: Math.max(0, parseInt(document.getElementById('maxJobsPerRun').value, 10) || 0),
      maxPerScan: cfg.maxPerScan || 20, // 内部每轮上限(补全/分析),不暴露给用户
      enrichDetails: document.getElementById('enrichDetails').checked,
      autoAnalyze: document.getElementById('autoAnalyze').checked,
      analyzePerDay: Math.max(0, parseInt(document.getElementById('analyzePerDay').value, 10) || 0)
    };
  }

  // 实时显示解析出的城市码
  function updateCityLabel() {
    const el = document.getElementById('cityResolved');
    if (!el) return;
    const label = resolveCityLabel(document.getElementById('city').value);
    el.textContent = label ? ('将扫描: ' + label) : '请输入城市(如 南宁)';
  }

  function bindEvents() {
    document.getElementById('btnSave').addEventListener('click', save);
    document.getElementById('btnRunNow').addEventListener('click', runNow);
    const cityInput = document.getElementById('city');
    if (cityInput) cityInput.addEventListener('input', updateCityLabel);
    const resetBtn = document.getElementById('btnResetTomb');
    if (resetBtn) resetBtn.addEventListener('click', resetTombstone);
  }

  // 重置删除记录(清空墓碑),之后扫描可重新收录之前删过的岗位
  async function resetTombstone() {
    if (!confirm('确定清空"已删除记录"?\n\n清空后,之前删除/清空的岗位在下次扫描时会重新被收录。')) return;
    await JTStorage.clearDeletedJobs();
    const el = document.getElementById('saveResult');
    el.textContent = '✓ 已清空删除记录';
    el.className = 'test-result ok';
    setTimeout(() => { el.textContent = ''; el.className = 'test-result'; }, 2500);
  }

  async function save() {
    const data = collect();
    cfg = await JTStorage.saveAutoScan(data);
    const el = document.getElementById('saveResult');
    el.textContent = '✓ 已保存(定时任务已更新)';
    el.className = 'test-result ok';
    setTimeout(() => { el.textContent = ''; el.className = 'test-result'; }, 2500);
    await refreshStatus();
  }

  async function runNow() {
    const btn = document.getElementById('btnRunNow');
    btn.disabled = true;
    btn.textContent = '正在打开管理面板…';
    // v1.5.20:扫描执行在前端(dashboard),不再由 SW 跑
    // 打开 dashboard 并通过 hash 触发自动扫描
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#autoscan-run'), active: true });
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '立即扫描一轮';
    }, 1500);
  }

  async function refreshStatus() {
    const box = document.getElementById('statusBox');
    chrome.runtime.sendMessage({ type: 'JT_GET_AUTOSCAN_STATUS' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        box.textContent = '状态获取失败';
        return;
      }
      const fmt = (ts) => ts ? new Date(ts).toLocaleString('zh-CN') : '—';
      box.innerHTML = `
        <div>定时自动扫描: <b>已停用</b>（仅手动触发）</div>
        <div>上次扫描: ${fmt(res.lastScanAt)}</div>
        <div>累计采集: ${res.totalCollected} 个</div>
        <div>本次上限: ${res.maxJobsPerRun ? res.maxJobsPerRun + ' 个' : '不限制'}</div>
        <div>今日已分析: ${res.analyzedToday} / ${res.analyzePerDay || '∞'}</div>
        <div>本轮新增: ${res.lastScanAdded}</div>
      `;
    });
  }
})();
