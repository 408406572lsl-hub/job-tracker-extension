// ============================================================
// integration-chain-sim.test.js — 跨模块入库链路仿真
// 用内存版 chrome.storage.local 桩 + 真实 JTStorage / JTAutoScan /
// JTAnalyzeHelper,模拟「导入 → 入库 → 自动分析」完整链路,覆盖:
//   · 导入无 id 岗位 → saveJobs 后每条都有稳定 jt_ 前缀 id(M9 回归)
//   · maybeAutoAnalyze 在分析「前」先 consumeAnalysisQuota(perDay)(M6 原子化)
//   · 超 analyzePerDay 时返回 {ok:false} 且不消费额度
//   · 分析失败(无 API Key)→ 额度已占(analyzedToday 不回退),不污染岗位 AI 分
// 不触网:chrome.runtime.sendMessage / setTimeout 全部由测试桩接管。
//
// 说明:本文件用「微任务版 setTimeout 桩」——被捕获的延时回调在下一个
//   微任务立即执行,因此 `await maybeAutoAnalyze(job)` 可完整结束(含 1.2s 延时),
//   无需手动 flush;同时保留对「占额度在分析前」的顺序断言能力。
// ============================================================

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

function loadSrc(rel, names = []) {
  const code = readSrc(rel);
  const expose = names
    .map((n) => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
    .join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}

// 内存版 chrome.storage.local 桩(单共享 store,跨模块可见)
function makeChromeStore() {
  const store = {};
  const noop = () => {};
  const local = {
    get(keys, cb) {
      const ks = Array.isArray(keys) ? keys : [keys];
      const res = {};
      ks.forEach((k) => { if (Object.prototype.hasOwnProperty.call(store, k)) res[k] = store[k]; });
      cb(res);
    },
    set(obj, cb) { Object.keys(obj).forEach((k) => { store[k] = obj[k]; }); if (cb) cb(); },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); if (cb) cb(); }
  };
  const target = {
    storage: { local },
    runtime: {
      onInstalled: { addListener: noop }, onMessage: { addListener: noop }, onStartup: { addListener: noop },
      sendMessage: noop, getURL: (p) => 'chrome-extension://test/' + p, lastError: null
    },
    tabs: { query: noop, sendMessage: noop, create: noop, remove: noop }
  };
  const chrome = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return new Proxy({ addListener: noop, create: noop, clear: noop, get: noop, set: noop, remove: noop, sendMessage: noop, query: noop }, {
        get(tt, p) { return (p in tt) ? tt[p] : noop; }
      });
    }
  });
  return { chrome, store };
}

// BOSS 风格详情页 URL(命中 jobKey 的 detail-url 分支 → 纯 URL 键,不含 title)
const DETAIL = (id) => `https://www.zhipin.com/job_detail/${id}.html`;

let ctx;        // { chrome, store }
let analyzeOneImpl; // 当前 analyzeOne 桩

beforeEach(() => {
  ctx = makeChromeStore();
  global.chrome = ctx.chrome;
  global.chrome.runtime.sendMessage = (msg, cb) => analyzeOneImpl(msg, cb);

  // 加载顺序:config → autoscan → storage → analyze-helper
  loadSrc('lib/config.js', ['JT_CONFIG', 'JT_STATUS', 'JT_STATUS_LABELS', 'JT_Utils']);
  loadSrc('lib/autoscan.js', ['JTAutoScan']);
  loadSrc('lib/storage.js', ['JTStorage']);
  loadSrc('lib/analyze-helper.js', ['JTAnalyzeHelper']);

  // 默认 analyzeOne 桩:模拟后台返回有效分析(含 fitScore 数字)
  analyzeOneImpl = (msg, cb) => {
    if (cb) cb({ ok: true, analysis: { fitScore: 80, overallRisk: 'low', matched: true, reasons: ['ok'] } });
  };

  // 微任务版 setTimeout:捕获的回调在下一轮微任务立即执行,使延时可被 await 越过
  global.setTimeout = (fn) => { Promise.resolve().then(() => { if (typeof fn === 'function') fn(); }); return 0; };
});

afterEach(() => {
  // 还原全局,避免污染其它套件
  global.setTimeout = (...args) => setTimeout(...args);
  delete global.chrome;
  delete global.JTStorage;
  delete global.JTAutoScan;
  delete global.JTAnalyzeHelper;
});

describe('P4 · 导入入库链路仿真', () => {
  // ---------- M9:导入无 id 岗位稳定 id ----------
  test('M9 · 导入无 id 岗位,saveJobs 后每条都有 jt_ 前缀 id', async () => {
    const imported = [
      { title: '康复治疗师', company: 'A医院', url: DETAIL('a1') },
      { title: '物理治疗师', company: 'B中心', url: DETAIL('a2') },
      { title: '作业治疗师', company: 'C机构', url: DETAIL('a3') }
    ];
    const res = await JTStorage.saveJobs(imported, {});
    expect(res.added).toBe(3);
    expect(res.total).toBe(3);

    const jobs = await JTStorage.getJobs();
    expect(jobs.length).toBe(3);
    jobs.forEach((j) => {
      expect(typeof j.id).toBe('string');
      expect(j.id.startsWith('jt_')).toBe(true);
      expect(j.id.length).toBeGreaterThan(8);
    });
    const ids = new Set(jobs.map((j) => j.id));
    expect(ids.size).toBe(3);
  });

  test('M9 · 单条 saveJob 也能补 id', async () => {
    const job = { title: '言语治疗师', company: 'D中心', url: DETAIL('a4') };
    const r = await JTStorage.saveJob(job, {});
    expect(r.action).toBe('added');
    expect(typeof r.job.id).toBe('string');
    expect(r.job.id.startsWith('jt_')).toBe(true);
  });

  test('M9 · 已有 id 的岗位不被覆盖', async () => {
    const job = { id: 'keep-id-123', title: '康复技师', company: 'E院', url: DETAIL('a5') };
    await JTStorage.saveJob(job, {});
    const jobs = await JTStorage.getJobs();
    expect(jobs[0].id).toBe('keep-id-123');
  });

  // ---------- M9:去重不受补 id 影响 ----------
  test('M9 · 同详情 URL 重复导入只算 added 一次,id 稳定', async () => {
    const a = { title: '康复医师', url: DETAIL('same') };
    const b = { title: '康复医师(更新)', url: DETAIL('same') }; // 同详情 URL → 同 key
    const r1 = await JTStorage.saveJobs([a], {});
    expect(r1.added).toBe(1);
    const firstId = (await JTStorage.getJobs())[0].id;

    const r2 = await JTStorage.saveJobs([b], {});
    expect(r2.updated).toBe(1);
    expect(r2.added).toBe(0);
    expect(r2.total).toBe(1);
    const afterId = (await JTStorage.getJobs())[0].id;
    expect(afterId).toBe(firstId); // id 不随更新翻转
  });

  // ---------- M6:原子化配额 ----------
  test('M6 · maybeAutoAnalyze 在「分析前」先占额度', async () => {
    // 注意:每日计数复位看的是 cfg.lastDate(不是 lastResetDate)
    await JTStorage.saveAutoScan({ autoAnalyze: true, analyzePerDay: 5, analyzedToday: 0, lastDate: JTAutoScan.dayKey() });
    const job = { id: 'jt_test_1', title: '岗位X', url: DETAIL('x') };

    // analyzeOne 桩同步读取「发起分析那一刻」store 里的 analyzedToday
    let analyzedTodayAtAnalyze = null;
    analyzeOneImpl = (msg, cb) => {
      const cur = ctx.store[JT_CONFIG.storageKeys.autoScan];
      analyzedTodayAtAnalyze = cur ? cur.analyzedToday : null;
      if (cb) cb({ ok: true, analysis: { fitScore: 80 } });
    };

    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(true);
    expect(r.analysis.fitScore).toBe(80);
    expect(analyzedTodayAtAnalyze).toBe(1); // 占额度发生在 analyzeOne 之前

    const cfg = await JTStorage.getAutoScan();
    expect(cfg.analyzedToday).toBe(1);
  });

  test('M6 · 超 analyzePerDay 时 ok:false 且不消费额度', async () => {
    await JTStorage.saveAutoScan({ autoAnalyze: true, analyzePerDay: 3, analyzedToday: 3, lastDate: JTAutoScan.dayKey() });
    const job = { id: 'jt_test_2', title: '岗位Y', url: DETAIL('y') };

    let analyzeCalled = false;
    analyzeOneImpl = (msg, cb) => { analyzeCalled = true; if (cb) cb({ ok: true, analysis: { fitScore: 90 } }); };

    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(false);
    expect(r.reason).toContain('每日分析上限');
    expect(analyzeCalled).toBe(false); // 未真正发起分析

    const cfg = await JTStorage.getAutoScan();
    expect(cfg.analyzedToday).toBe(3); // 额度未变
  });

  test('M6 · 连续两次 consume,第二次因达上限被拦截(串行原子)', async () => {
    // 验证 consumeAnalysisQuota 每次都「重读最新配置 → 判断 → +1 → 写回」,
    // 因此串行两次调用不会重复占用同一额度(chrome.storage 串行保证原子性)。
    await JTStorage.saveAutoScan({ autoAnalyze: true, analyzePerDay: 1, analyzedToday: 0, lastDate: JTAutoScan.dayKey() });

    const q1 = await JTStorage.consumeAnalysisQuota(1);
    expect(q1.ok).toBe(true);
    expect(q1.analyzedToday).toBe(1);

    const q2 = await JTStorage.consumeAnalysisQuota(1); // 已用满 → 拦截
    expect(q2.ok).toBe(false);
    expect(q2.reason).toBe('limit');
    expect(q2.analyzedToday).toBe(1);

    const cfg = await JTStorage.getAutoScan();
    expect(cfg.analyzedToday).toBe(1);
  });

  test('M6 · 并发两次 consume 由队列串行化,每日上限不会被突破', async () => {
    await JTStorage.saveAutoScan({ autoAnalyze: true, analyzePerDay: 1, analyzedToday: 0, lastDate: JTAutoScan.dayKey() });

    const [q1, q2] = await Promise.all([
      JTStorage.consumeAnalysisQuota(1),
      JTStorage.consumeAnalysisQuota(1)
    ]);
    expect([q1.ok, q2.ok].filter(Boolean)).toHaveLength(1);
    expect([q1.reason, q2.reason]).toContain('limit');
    const cfg = await JTStorage.getAutoScan();
    expect(cfg.analyzedToday).toBe(1);
  });

  // ---------- v1.5.48:分析失败额度不退,但岗位 AI 分不污染 ----------
  test('分析失败(无 API Key)→ 额度已占(不回退),岗位无 aiFitScore', async () => {
    await JTStorage.saveAutoScan({ autoAnalyze: true, analyzePerDay: 10, analyzedToday: 0, lastResetDate: '' });
    const job = { id: 'jt_test_4', title: '岗位W', url: DETAIL('w') };
    await JTStorage.saveJob(job, {});

    analyzeOneImpl = (msg, cb) => { if (cb) cb({ ok: false, error: '未配置 API Key' }); };

    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(true); // 已发起分析(额度已占)
    expect(r.reason).toContain('API Key');

    const cfg = await JTStorage.getAutoScan();
    expect(cfg.analyzedToday).toBe(1); // 额度不退

    const jobs = await JTStorage.getJobs();
    const saved = jobs.find((j) => j.id === 'jt_test_4');
    expect(saved.aiFitScore).toBeUndefined();
    expect(saved.aiAnalysis).toBeUndefined();
  });

  test('autoAnalyze 关闭时不分析也不占额度', async () => {
    await JTStorage.saveAutoScan({ autoAnalyze: false, analyzePerDay: 5, analyzedToday: 0, lastResetDate: '' });
    let analyzeCalled = false;
    analyzeOneImpl = (msg, cb) => { analyzeCalled = true; if (cb) cb({ ok: true, analysis: { fitScore: 70 } }); };

    const r = await JTAnalyzeHelper.maybeAutoAnalyze({ id: 'jt_test_5', title: '岗位V', url: DETAIL('v') });
    expect(r.analyzed).toBe(false);
    expect(r.reason).toContain('autoAnalyze');
    expect(analyzeCalled).toBe(false);

    const cfg = await JTStorage.getAutoScan();
    expect(cfg.analyzedToday).toBe(0);
  });

  // ---------- 跨模块串联:导入 → 入库 → 自动分析成功写回 ----------
  test('串联 · 导入无 id 岗位 → 自动分析成功 → aiFitScore 写回存储', async () => {
    await JTStorage.saveAutoScan({ autoAnalyze: true, analyzePerDay: 5, analyzedToday: 0, lastResetDate: '' });
    const imported = [{ title: '康复医师(串联)', url: DETAIL('chain') }];

    const saveRes = await JTStorage.saveJobs(imported, {});
    expect(saveRes.added).toBe(1);
    const savedJob = (await JTStorage.getJobs())[0];
    expect(savedJob.id.startsWith('jt_')).toBe(true);

    // 模拟后台 analyzeOne 成功并把结果写回(复刻 background 的 persistAiScore 逻辑)
    analyzeOneImpl = (msg, cb) => {
      JTStorage.updateAiAnalysis(msg.job.id, 88, { fitScore: 88, overallRisk: 'low', matched: true, reasons: ['匹配'] })
        .then(() => cb && cb({ ok: true, analysis: { fitScore: 88 } }));
    };

    const r = await JTAnalyzeHelper.maybeAutoAnalyze(savedJob);
    expect(r.analyzed).toBe(true);
    expect(r.analysis.fitScore).toBe(88);

    const jobs = await JTStorage.getJobs();
    const finalJob = jobs.find((j) => j.id === savedJob.id);
    expect(finalJob.aiFitScore).toBe(88);
  });

  // ---------- 跨日重置 ----------
  test('跨日 · 次日 consumeAnalysisQuota 自动归零 analyzedToday', async () => {
    const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
    await JTStorage.saveAutoScan({ autoAnalyze: true, analyzePerDay: 2, analyzedToday: 2, lastDate: yesterday });

    // 跨日:consumeAnalysisQuota 内部会 resetDailyIfNeeded → analyzedToday 归零后 +1
    const q = await JTStorage.consumeAnalysisQuota(2);
    expect(q.ok).toBe(true);
    expect(q.analyzedToday).toBe(1); // 新的一日,额度重新计数

    const cfg = await JTStorage.getAutoScan();
    expect(cfg.lastDate).toBe(JTAutoScan.dayKey());
  });

  test('同日 · analyzedToday 已达上限,consume 返回 ok:false', async () => {
    const today = JTAutoScan.dayKey();
    await JTStorage.saveAutoScan({ autoAnalyze: true, analyzePerDay: 2, analyzedToday: 2, lastDate: today });

    const q = await JTStorage.consumeAnalysisQuota(2);
    expect(q.ok).toBe(false);
    expect(q.reason).toBe('limit');
    expect(q.analyzedToday).toBe(2);
  });
});
