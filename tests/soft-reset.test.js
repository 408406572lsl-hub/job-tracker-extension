// soft-reset.test.js — 验证「仅清岗位数据」软重置行为:
// 清空岗位 + AI 缓存 + 扫描统计;完整保留 AI 配置(服务商/模型/Base URL/Key)、简历档案、筛选、删除记录。
const store = {};
global.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        if (typeof keys === 'string') keys = [keys];
        if (Array.isArray(keys)) {
          const r = {};
          keys.forEach(k => { if (store[k] !== undefined) r[k] = store[k]; });
          cb(r);
        } else if (keys && typeof keys === 'object') {
          const r = {};
          Object.keys(keys).forEach(k => { r[k] = store[k] !== undefined ? store[k] : keys[k]; });
          cb(r);
        } else { cb({}); }
      },
      set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
      remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); if (cb) cb(); }
    }
  }
};

// setup.js 已加载 config / autoscan,这里再加载 storage.js 并暴露 JTStorage
const fs = require('fs');
const path = require('path');
function loadSrc(rel, exportNames = []) {
  const code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const expose = exportNames
    .map((n) => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
    .join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}
loadSrc('lib/storage.js', ['JTStorage']);

describe('softResetData (仅清岗位数据)', () => {
  beforeEach(() => {
    store[JT_CONFIG.storageKeys.jobs] = [{ id: '1', title: '康复师' }];
    store[JT_CONFIG.storageKeys.aiCache] = { 'k1': { fitScore: 80 } };
    store[JT_CONFIG.storageKeys.aiSettings] = { provider: 'openrouter', model: 'deepseek/deepseek-r1', baseUrl: 'https://oa.com/v1' };
    store[JT_CONFIG.storageKeys.aiKeys] = { openrouter: 'sk-test-123' };
    store[JT_CONFIG.storageKeys.profile] = { name: '张三', education: '大专' };
    store[JT_CONFIG.storageKeys.filters] = { status: 'all' };
    store[JT_CONFIG.storageKeys.deletedJobs] = ['del-1'];
    store[JT_CONFIG.storageKeys.autoScan] = { enabled: false, maxJobsPerRun: 3, totalCollected: 15, lastScanAt: 999, analyzedToday: 5, lastScanAdded: 7 };
  });

  test('清空岗位与 AI 缓存', async () => {
    await JTStorage.softResetData();
    // 岗位被清空为空数组(与 resetUsageData 一致,getter 返回 [] 而非 undefined)
    expect(store[JT_CONFIG.storageKeys.jobs]).toEqual([]);
    // AI 缓存被彻底删除
    expect(store[JT_CONFIG.storageKeys.aiCache]).toBeUndefined();
  });

  test('完整保留 AI 配置(服务商/模型/Base URL/Key)', async () => {
    await JTStorage.softResetData();
    expect(store[JT_CONFIG.storageKeys.aiSettings]).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-r1', baseUrl: 'https://oa.com/v1' });
    expect(store[JT_CONFIG.storageKeys.aiKeys]).toEqual({ openrouter: 'sk-test-123' });
  });

  test('保留简历档案、筛选条件、删除记录', async () => {
    await JTStorage.softResetData();
    expect(store[JT_CONFIG.storageKeys.profile]).toEqual({ name: '张三', education: '大专' });
    expect(store[JT_CONFIG.storageKeys.filters]).toEqual({ status: 'all' });
    expect(store[JT_CONFIG.storageKeys.deletedJobs]).toEqual(['del-1']);
  });

  test('扫描统计清零,但自动扫描配置保留(不重新打开已关闭的扫描)', async () => {
    await JTStorage.softResetData();
    const as = store[JT_CONFIG.storageKeys.autoScan];
    expect(as.enabled).toBe(false);          // 关扫描状态保留
    expect(as.maxJobsPerRun).toBe(3);        // 配置保留
    expect(as.totalCollected).toBe(0);       // 统计清零
    expect(as.lastScanAt).toBe(0);
    expect(as.analyzedToday).toBe(0);
    expect(as.lastScanAdded).toBe(0);
  });
});
