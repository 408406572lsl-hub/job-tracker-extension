// ============================================================
// settings-save-repro.test.js
// 用 jsdom 真实加载 settings.html + settings.js，复现两个 bug：
//  ① 本次填写的模型保存不住（上次填的还在）
//  ② 模型框有值时，旁边三角形（datalist 下拉箭头）点击无反应
// 通过模拟「输入模型 → 点保存 → 重新打开」全流程定位根因。
// ============================================================
const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(rootDir, rel), 'utf8');

function loadSrc(rel, exportNames = []) {
  const code = readSrc(rel);
  const expose = exportNames
    .map(n => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
    .join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}

const flush = async (n = 25) => {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
};
const bodyOf = () =>
  readSrc('settings/settings.html')
    .match(/<body>([\s\S]*?)<\/body>/)[1]
    .replace(/<script[\s\S]*?<\/script>/g, '');

describe('settings 模型保存 + 下拉箭头 复现', () => {
  let store, settingsJsLoaded;

  beforeEach(() => {
    store = {};
    settingsJsLoaded = false;
    global.chrome = {
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            if (typeof keys === 'string') { if (keys in store) out[keys] = store[keys]; }
            else if (Array.isArray(keys)) { keys.forEach(k => { if (k in store) out[k] = store[k]; }); }
            else if (keys && typeof keys === 'object') {
              Object.keys(keys).forEach(k => { out[k] = (k in store) ? store[k] : keys[k]; });
            }
            cb(out);
          },
          set: (obj, cb) => { Object.entries(obj).forEach(([k, v]) => { store[k] = v; }); if (cb) cb(); },
        },
      },
      runtime: { sendMessage: (msg, cb) => { if (cb) cb({ ok: true, reply: 'pong' }); } },
    };
    loadSrc('lib/config.js', ['JT_CONFIG', 'JT_STATUS', 'JT_STATUS_LABELS', 'JT_Utils']);
    loadSrc('lib/storage.js', ['JTStorage']);
    document.body.innerHTML = bodyOf();
  });

  async function init() {
    if (!settingsJsLoaded) {
      loadSrc('settings/settings.js', []);
      settingsJsLoaded = true;
    }
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flush();
  }

  test('A. 输入模型 → 点保存 → 重新打开后模型仍在', async () => {
    await init();
    const modelEl = document.getElementById('model');
    modelEl.value = 'my-custom-model-xyz';
    modelEl.dispatchEvent(new Event('input'));
    document.getElementById('btnSaveInline').click();
    await flush();

    const k = JT_CONFIG.storageKeys.aiSettings;
    expect(store[k] && store[k].model).toBe('my-custom-model-xyz');

    // 重新打开（同一 store）
    document.body.innerHTML = bodyOf();
    await init();
    expect(document.getElementById('model').value).toBe('my-custom-model-xyz');
  });

  test('B. 只输入不点保存（仅 blur）→ 模型也应自动落盘（修复"本次没保存"）', async () => {
    // 先保存一个旧模型 "old-model"
    await init();
    let modelEl = document.getElementById('model');
    modelEl.value = 'old-model';
    document.getElementById('btnSaveInline').click();
    await flush();

    // 重新打开，改成本次模型 "new-model"，只触发 blur（不点保存）
    document.body.innerHTML = bodyOf();
    await init();
    modelEl = document.getElementById('model');
    expect(modelEl.value).toBe('old-model'); // 旧模型确实在
    modelEl.value = 'new-model';
    modelEl.dispatchEvent(new Event('blur')); // 仅失焦
    await flush();

    // 重新打开，new-model 应已保存住（blur 自动落盘 aiSettings.model）
    document.body.innerHTML = bodyOf();
    await init();
    expect(document.getElementById('model').value).toBe('new-model');
    // datalist 里也应有 new-model（blur 已 addCustomModel + 重新渲染）
    const dlOpts = [...document.getElementById('modelList').options].map(o => o.value);
    expect(dlOpts).toContain('new-model');
  });

  test('C. provider=custom 时 datalist 是否被填充（决定下拉箭头是否有用）', async () => {
    await init();
    const providerEl = document.getElementById('provider');
    providerEl.value = 'custom';
    providerEl.dispatchEvent(new Event('change'));
    await flush();

    const dl = document.getElementById('modelList');
    // 未输入任何自定义模型前，custom 预设模型为空 → datalist 应为空 → 下拉箭头无反应
    expect([...dl.options].map(o => o.value)).toEqual([]);

    // 输入并失焦 → 应写入 datalist
    const modelEl = document.getElementById('model');
    modelEl.value = 'abc-model';
    modelEl.dispatchEvent(new Event('blur'));
    await flush();
    expect([...dl.options].map(o => o.value)).toContain('abc-model');
  });

  test('D. 预设服务商（如 deepseek）datalist 应含预设模型', async () => {
    await init();
    const providerEl = document.getElementById('provider');
    providerEl.value = 'deepseek';
    providerEl.dispatchEvent(new Event('change'));
    await flush();
    const dl = document.getElementById('modelList');
    const opts = [...dl.options].map(o => o.value);
    // deepseek 的预设模型应从 config 注入
    expect(opts.length).toBeGreaterThan(0);
  });
});
