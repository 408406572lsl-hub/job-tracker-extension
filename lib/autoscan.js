// ============================================================
// autoscan.js — 自动扫描纯逻辑(环境无关,可被 jest / content / background 复用)
// 只负责:URL 构建、岗位归一化、分析挑选、日计数、配置合并
// 不涉及 DOM / chrome.* 调用(那些在 content.js / background.js 里)
// ============================================================

(function (root) {
  'use strict';

  const JTAutoScan = {};

  // 取默认配置(优先用 config.js 里的,避免两份默认值漂移)
  function defaults() {
    if (typeof JT_CONFIG !== 'undefined' && JT_CONFIG.defaultAutoScan) {
      return JT_CONFIG.defaultAutoScan;
    }
    return {
      enabled: false, keywords: '', city: '100010000', cityName: '北京',
      intervalMin: 60, maxPerScan: 20, maxJobsPerRun: 0, enrichDetails: true, autoAnalyze: true,
      analyzePerDay: 30, lastScanAt: 0, lastDate: '', analyzedToday: 0,
      totalCollected: 0, lastScanAdded: 0
    };
  }

  // 与默认配置合并(修补缺失字段)
  JTAutoScan.merge = function (saved) {
    return Object.assign({}, defaults(), saved || {});
  };

  // 是否应该运行
  JTAutoScan.shouldRun = function (cfg) {
    return !!(cfg && cfg.enabled);
  };

  // 由关键词构建 BOSS 搜索 URL(每个关键词一个)
  // BOSS web 搜索页: https://www.zhipin.com/web/geek/job?query=KW&city=CODE&page=1
  JTAutoScan.buildBossSearchUrls = function (cfg) {
    const base = 'https://www.zhipin.com/web/geek/job';
    const city = (cfg && cfg.city) ? String(cfg.city).trim() : '';
    const kws = (cfg && cfg.keywords ? String(cfg.keywords) : '')
      .split(/[\s,，、]+/).map(s => s.trim()).filter(Boolean);
    const urls = [];
    for (const kw of kws) {
      const params = new URLSearchParams();
      params.set('query', kw);
      if (city) params.set('city', city);
      params.set('page', '1');
      urls.push(base + '?' + params.toString());
    }
    return urls;
  };

  // 今日日期键(YYYY-MM-DD,本地时区)
  JTAutoScan.dayKey = function (d) {
    const dt = d || new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // 若跨日则重置当日分析计数(就地修改并返回)
  JTAutoScan.resetDailyIfNeeded = function (state) {
    const today = JTAutoScan.dayKey();
    if (state.lastDate !== today) {
      state.lastDate = today;
      state.analyzedToday = 0;
    }
    return state;
  };

  // 归一化采集到的岗位:补齐运行状态字段
  JTAutoScan.normalizeCollected = function (jobs, now) {
    const t = now || Date.now();
    return (jobs || []).map(j => Object.assign({}, j, {
      status: (typeof JT_STATUS !== 'undefined' && JT_STATUS.UNSEEN) || 'unseen',
      collectedVia: 'auto',
      capturedAt: j.capturedAt || t
    }));
  };

  // 挑选需要 AI 分析的岗位(受每日上限约束)
  // jobs: 本轮采集到的岗位(已归一化);usedToday: 今日已分析数
  JTAutoScan.pickJobsForAnalysis = function (jobs, cfg, usedToday) {
    if (!cfg || !cfg.autoAnalyze) return [];
    const remaining = Math.max(0, (cfg.analyzePerDay || 0) - (usedToday || 0));
    if (remaining <= 0) return [];
    const cap = Math.min(remaining, cfg.maxPerScan || jobs.length);
    return (jobs || []).slice(0, cap);
  };

  // 本次扫描是否已达到"最多采集岗位数"上限
  // maxJobsPerRun <= 0 视为不限制(扫满为止)
  JTAutoScan.reachedJobCap = function (totalAdded, maxJobsPerRun) {
    return !!(maxJobsPerRun && maxJobsPerRun > 0 && (totalAdded || 0) >= maxJobsPerRun);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = JTAutoScan;
  if (root) root.JTAutoScan = JTAutoScan;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
