// ============================================================
// scan-controller-cap.test.js
// 验证 maxJobsPerRun 语义:"本轮实际新增上限"(重复的不算)。
// 当前页所有卡片都送去重,新增数达标后不再翻页,允许微量超量。
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

let store;
let calls;
let cards;
let removedTabs;

function installChrome() {
  store = {};
  calls = { scanPage: 0, pageJob: 0, analyze: 0 };
  removedTabs = [];
  const storageLocal = {
    get(keys, cb) {
      const arr = Array.isArray(keys) ? keys : [keys];
      const res = {};
      arr.forEach((k) => { res[k] = store[k] !== undefined ? store[k] : null; });
      cb(res);
    },
    set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
    remove(keys, cb) {
      const arr = Array.isArray(keys) ? keys : [keys];
      arr.forEach((k) => delete store[k]);
      if (cb) cb();
    },
  };
  global.chrome = {
    storage: { local: storageLocal },
    tabs: {
      create(opts, cb) { cb({ id: 1 }); },
      remove(tabId) { removedTabs.push(tabId); },
      sendMessage(tabId, msg, cb) {
        if (msg.type === 'JT_SCAN_PAGE') { calls.scanPage++; cb({ ok: true, jobs: cards }); }
        else if (msg.type === 'JT_SCAN_HAS_NEXT') { cb({ ok: true, hasNext: false }); }
        else if (msg.type === 'JT_GET_PAGE_JOB') { calls.pageJob++; cb({ ok: true, job: { description: '岗位职责xxx', requirement: '任职要求yyy' } }); }
        else if (msg.type === 'JT_SCAN_NEXT_PAGE') { cb({ ok: false }); }
        else cb({ ok: true });
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        if (msg.type === 'JT_LLM_ANALYZE') { calls.analyze++; cb({ ok: true, analysis: { fitScore: 80 } }); }
        else cb({ ok: true });
      },
    },
  };
}

beforeEach(() => {
  installChrome();
  // storage.js / scan-controller.js 依赖 chrome.*,需在 mock 之后加载
  loadSrc('lib/storage.js', ['JTStorage']);
  loadSrc('lib/scan-controller.js', ['JTScanController']);
  // 模拟一个搜索页返回 15 个卡片(列表页本身无 description)
  cards = Array.from({ length: 15 }, (_, i) => ({
    title: '康复技师' + i,
    company: '公司' + i,
    location: '南宁',
    salaryRaw: '5-8K',
    url: 'https://www.zhipin.com/job/' + i,
    site: 'BOSS直聘',
  }));
});

function baseCfg(over) {
  return Object.assign({
    enabled: true,
    keywords: '康复',
    city: '100010000',
    cityName: '北京',
    intervalMin: 60,
    maxPerScan: 20,
    maxJobsPerRun: 0,
    enrichDetails: false,
    autoAnalyze: false,
    analyzePerDay: 30,
    lastScanAt: 0,
    lastDate: '',
    analyzedToday: 0,
    totalCollected: 0,
    lastScanAdded: 0,
  }, over);
}

test('当前页所有卡片都送存,达上限后不再翻页(不再按配额预切片)', async () => {
  const cfg = baseCfg({ maxJobsPerRun: 3, enrichDetails: false, autoAnalyze: false });
  const res = await JTScanController.start(cfg);
  expect(res.ok).toBe(true);
  const jobs = store[JT_CONFIG.storageKeys.jobs] || [];
  // 所有 15 张卡片 jobKey 都不同(saveJobs 内部去重),全页入库
  // 实际场景中重复卡片只更新不计入 added,本测试模拟全部为新的极端情况
  expect(jobs.length).toBe(15);
  expect(calls.scanPage).toBe(1); // 达上限不再翻页(且 hasNext=false)
}, 30000);

test('新增岗位补全详情(每个新增岗位都补)', async () => {
  cards = cards.slice(0, 3); // 只测 3 个,验证每个都补了
  const cfg = baseCfg({ maxJobsPerRun: 3, enrichDetails: true, autoAnalyze: false });
  await JTScanController.start(cfg);
  expect(calls.pageJob).toBe(3);
  const jobs = store[JT_CONFIG.storageKeys.jobs] || [];
  expect(jobs.some((j) => j.description)).toBe(true);
}, 60000);

test('详情补全消息抛错时仍关闭临时 tab', async () => {
  cards = cards.slice(0, 1);
  const origSend = global.chrome.tabs.sendMessage;
  global.chrome.tabs.sendMessage = (tabId, msg, cb) => {
    if (msg.type === 'JT_GET_PAGE_JOB') throw new Error('页面通信异常');
    origSend(tabId, msg, cb);
  };
  const cfg = baseCfg({ enrichDetails: true, autoAnalyze: false });
  const res = await JTScanController.start(cfg);
  expect(res.ok).toBe(false); // 当前控制器会终止本轮,但资源必须清理
  expect(res.error).toContain('页面通信异常');
  expect(removedTabs.length).toBeGreaterThanOrEqual(1); // 至少详情 tab 已由 finally 关闭
}, 30000);

test('新增岗位全部做 AI 分析(force 透传,不引用缓存)', async () => {
  const cfg = baseCfg({ maxJobsPerRun: 3, enrichDetails: false, autoAnalyze: true, analyzePerDay: 30 });
  await JTScanController.start(cfg);
  expect(calls.analyze).toBe(15); // 15 个全分析
}, 30000);

test('扫描完成后 totalCollected/lastScanAdded/lastScanAt 回写到 storage', async () => {
  const cfg = baseCfg({
    maxJobsPerRun: 5,
    enrichDetails: false,
    autoAnalyze: false,
    totalCollected: 10, // 已累计 10
    lastScanAdded: 2,
    lastScanAt: 1000,
  });
  const before = Date.now();
  const res = await JTScanController.start(cfg);
  expect(res.ok).toBe(true);
  expect(res.added).toBe(15); // 本轮全部新增
  // finally 块应回写 cfg 统计字段
  expect(cfg.lastScanAt).toBeGreaterThanOrEqual(before);
  expect(cfg.lastScanAdded).toBe(15);
  expect(cfg.totalCollected).toBe(25); // 10 + 15
  // storage 里存的也应是回写后的值
  const stored = store[JT_CONFIG.storageKeys.autoScan];
  expect(stored.totalCollected).toBe(25);
  expect(stored.lastScanAdded).toBe(15);
  expect(stored.lastScanAt).toBeGreaterThanOrEqual(before);
}, 30000);

test('扫描期间外部配置更新不会被 finally 的旧 cfg 覆盖', async () => {
  cards = cards.slice(0, 1);
  const cfg = baseCfg({ keywords: '康复', autoAnalyze: false, totalCollected: 4 });
  const originalSet = global.chrome.storage.local.set;
  let injected = false;
  global.chrome.storage.local.set = (obj, cb) => {
    originalSet(obj, () => {
      if (!injected && Object.prototype.hasOwnProperty.call(obj, JT_CONFIG.storageKeys.jobs)) {
        injected = true;
        store[JT_CONFIG.storageKeys.autoScan] = Object.assign({}, store[JT_CONFIG.storageKeys.autoScan], {
          keywords: '推拿', autoAnalyze: true, totalCollected: 4
        });
      }
      if (cb) cb();
    });
  };

  await JTScanController.start(cfg);
  const stored = store[JT_CONFIG.storageKeys.autoScan];
  expect(stored.keywords).toBe('推拿');
  expect(stored.autoAnalyze).toBe(true);
  expect(stored.totalCollected).toBe(5);
}, 30000);

test('扫描异常时也回写已发生的统计(不丢失采集进度)', async () => {
  // 让 JT_SCAN_PAGE 第二次抛错以模拟中途异常
  let throwOnce = true;
  const origSend = global.chrome.tabs.sendMessage;
  global.chrome.tabs.sendMessage = (tabId, msg, cb) => {
    if (msg.type === 'JT_SCAN_PAGE' && throwOnce) {
      throwOnce = false;
      cb({ ok: false }); // 首页采集失败,触发 break
    } else {
      origSend(tabId, msg, cb);
    }
  };
  const cfg = baseCfg({ totalCollected: 5, lastScanAdded: 1, lastScanAt: 500 });
  await JTScanController.start(cfg);
  // 即使首页失败(0 新增),finally 仍应回写 lastScanAt,lastScanAdded=0,totalCollected 不变
  expect(cfg.lastScanAdded).toBe(0);
  expect(cfg.totalCollected).toBe(5); // 没新增不累加
  expect(cfg.lastScanAt).toBeGreaterThan(500);
}, 30000);
