/** @jest-environment jsdom */
// ============================================================
// autoscan-page.test.js — 回归测试
// 1) autoscan.html 必须完整加载依赖脚本(config.js / autoscan.js / storage.js)
//    否则 storage.js 加载即抛 ReferenceError(JT_CONFIG 未定义),
//    页面 init 崩溃 → btnSave / btnRunNow 永远不被绑定 → 按钮全部"不生效"。
//    这正是 v1.5.23 之前"保存设置 / 立即扫描一轮"都点不动的根因。
// 2) 加载齐全后,初始化应能绑定两个按钮,点击触发预期行为。
// ============================================================

const fs = require('fs');
const path = require('path');

function loadStorage() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storage.js'), 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\nglobalThis.JTStorage = (typeof JTStorage !== "undefined") ? JTStorage : undefined;');
}

function loadPage() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'settings', 'autoscan.js'), 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(code);
}

describe('autoscan.html 脚本引用防回归(根因:缺 config.js / autoscan.js 致按钮全失效)', () => {
  test('必须按序加载 config.js / autoscan.js / storage.js / autoscan.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'autoscan.html'), 'utf8');
    const idx = (s) => html.indexOf(s);
    const cfg = idx('<script src="../lib/config.js"></script>');
    const asc = idx('<script src="../lib/autoscan.js"></script>');
    const sto = idx('<script src="../lib/storage.js"></script>');
    const page = idx('<script src="autoscan.js"></script>');
    expect(cfg).toBeGreaterThan(-1);
    expect(asc).toBeGreaterThan(-1);
    expect(sto).toBeGreaterThan(-1);
    expect(page).toBeGreaterThan(-1);
    // 依赖顺序:config → autoscan(lib) → storage → 页面脚本
    expect(cfg).toBeLessThan(asc);
    expect(asc).toBeLessThan(sto);
    expect(sto).toBeLessThan(page);
  });

  test('不该再出现"只有 storage.js + autoscan.js"的残缺引用', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'autoscan.html'), 'utf8');
    // 旧的错误引用只加载 storage.js 与页面脚本,缺少 config/autoscan(lib)
    const hasConfig = html.includes('<script src="../lib/config.js"></script>');
    const hasAutoScanLib = html.includes('<script src="../lib/autoscan.js"></script>');
    expect(hasConfig).toBe(true);
    expect(hasAutoScanLib).toBe(true);
  });
});

describe('autoscan 页面初始化后按钮生效', () => {
  let store;
  let origChrome;

  beforeEach(() => {
    // 构造 autoscan.html 所需的 DOM
    document.body.innerHTML = `
      <button id="btnBack"></button>
      <input type="checkbox" id="enabled">
      <input type="text" id="keywords">
      <input type="text" id="city">
      <span id="cityResolved"></span>
      <input type="number" id="intervalMin">
      <input type="number" id="maxJobsPerRun">
      <input type="checkbox" id="enrichDetails">
      <input type="checkbox" id="autoAnalyze">
      <input type="number" id="analyzePerDay">
      <button id="btnSave"></button>
      <button id="btnRunNow"></button>
      <span id="saveResult"></span>
      <div id="statusBox"></div>
    `;
    store = {};
    origChrome = global.chrome;
    global.chrome = {
      storage: {
        local: {
          get(keys, cb) {
            const ks = Array.isArray(keys) ? keys : [keys];
            const res = {};
            ks.forEach((k) => { if (Object.prototype.hasOwnProperty.call(store, k)) res[k] = store[k]; });
            cb(res);
          },
          set(obj, cb) {
            Object.keys(obj).forEach((k) => { store[k] = obj[k]; });
            if (cb) cb();
          }
        }
      },
      runtime: {
        sendMessage(msg, cb) {
          if (cb) cb({
            ok: true, enabled: false, intervalMin: 60, lastScanAt: 0,
            totalCollected: 0, analyzedToday: 0, analyzePerDay: 0, lastScanAdded: 0, nextFireTime: 0
          });
        },
        getURL(p) { return 'chrome-extension://test/' + p; }
      },
      tabs: { create() {} }
    };

    loadStorage();
    loadPage();
  });

  afterEach(() => {
    global.chrome = origChrome;
  });

  test('初始化不抛错,btnSave / btnRunNow 都被绑定并能触发预期行为', async () => {
    // 触发页面 init
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 20)); // 等 init (async) 完成

    // 1) 点击"保存设置" → 应把配置写入 storage.autoScan
    document.getElementById('btnSave').click();
    await new Promise((r) => setTimeout(r, 20));
    const key = JT_CONFIG.storageKeys.autoScan;
    expect(store[key]).toBeDefined();
    expect(store[key].city).toBe('100010000'); // 默认北京码(defaultAutoScan 已改北京)
    expect(store[key].keywords).toBeDefined();

    // 2) 点击"立即扫描一轮" → 应打开 dashboard(hash 触发扫描),不再无反应
    let created = null;
    global.chrome.tabs.create = (opts) => { created = opts; };
    document.getElementById('btnRunNow').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(created).not.toBeNull();
    expect(created.url).toContain('dashboard/dashboard.html#autoscan-run');
  });
});
