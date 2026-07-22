// ============================================================
// storage-migration-profile.test.js — v1.5.55 通用默认迁移 + 档案部分更新回归
// ============================================================

function loadStorage() {
  const code = global.readSrc('lib/storage.js');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\nglobalThis.JTStorage = (typeof JTStorage !== "undefined") ? JTStorage : undefined;');
}

describe('v1.5.55 通用默认值与安全迁移', () => {
  let store;
  let origChrome;

  beforeEach(() => {
    store = {};
    origChrome = global.chrome;
    global.chrome = {
      storage: {
        local: {
          get(keys, cb) {
            const ks = Array.isArray(keys) ? keys : [keys];
            const res = {};
            ks.forEach(k => {
              if (Object.prototype.hasOwnProperty.call(store, k)) res[k] = store[k];
            });
            cb(res);
          },
          set(obj, cb) {
            Object.assign(store, obj);
            if (cb) cb();
          },
          remove(keys, cb) {
            (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete store[k]; });
            if (cb) cb();
          }
        }
      }
    };
    loadStorage();
  });

  afterEach(() => {
    global.chrome = origChrome;
  });

  test('新安装默认值不预设行业关键词或求职方向', async () => {
    expect(JT_CONFIG.defaultFilters.includeKeywords).toEqual([]);
    expect(JT_CONFIG.defaultFilters.excludeKeywords).toEqual([]);
    expect(JT_CONFIG.defaultAiSettings.jobIntent).toBe('');
    expect(JT_CONFIG.defaultAutoScan.keywords).toBe('');
    expect((await JTStorage.getFilters()).includeKeywords).toEqual([]);
    expect((await JTStorage.getAutoScan()).keywords).toBe('');
  });

  test('精确命中历史默认筛选词时迁移为空，不再机械偏向康复', async () => {
    store[JT_CONFIG.storageKeys.filters] = {
      ...JT_CONFIG.defaultFilters,
      includeKeywords: ['康复', '康复治疗', 'PT', 'OT', 'ST', '物理治疗', '作业治疗', '言语治疗', '理疗'],
      excludeKeywords: ['销售', '保险', '中介']
    };
    const filters = await JTStorage.getFilters();
    expect(filters.includeKeywords).toEqual([]);
    expect(filters.excludeKeywords).toEqual([]);
    expect(store[JT_CONFIG.storageKeys.filters].includeKeywords).toEqual([]);
  });

  test('用户自定义筛选词原样保留，包括主动选择的康复方向', async () => {
    store[JT_CONFIG.storageKeys.filters] = {
      ...JT_CONFIG.defaultFilters,
      includeKeywords: ['康复', '运动康复', '运营'],
      excludeKeywords: ['保险销售']
    };
    const filters = await JTStorage.getFilters();
    expect(filters.includeKeywords).toEqual(['康复', '运动康复', '运营']);
    expect(filters.excludeKeywords).toEqual(['保险销售']);
  });

  test('只迁移精确历史 AI 意向，用户自定义康复意向不受影响', async () => {
    store[JT_CONFIG.storageKeys.aiSettings] = {
      provider: 'deepseek',
      jobIntent: '求职意向示例：前端开发岗位，一线城市优先，接受应届生'
    };
    expect((await JTStorage.getAiSettings()).jobIntent).toBe('');
    expect(store[JT_CONFIG.storageKeys.aiSettings].jobIntent).toBe('');

    store[JT_CONFIG.storageKeys.aiSettings] = {
      provider: 'deepseek',
      jobIntent: '南宁康复治疗或医疗运营岗位，接受跨专业转岗'
    };
    expect((await JTStorage.getAiSettings()).jobIntent)
      .toBe('南宁康复治疗或医疗运营岗位，接受跨专业转岗');
  });

  test('只迁移精确历史扫描关键词，用户自定义关键词不受影响', async () => {
    store[JT_CONFIG.storageKeys.autoScan] = {
      ...JT_CONFIG.defaultAutoScan,
      keywords: '康复 推拿'
    };
    expect((await JTStorage.getAutoScan()).keywords).toBe('');

    store[JT_CONFIG.storageKeys.autoScan] = {
      ...JT_CONFIG.defaultAutoScan,
      keywords: '康复 推拿 运营'
    };
    expect((await JTStorage.getAutoScan()).keywords).toBe('康复 推拿 运营');
  });

  test('设置页示例为跨行业示例，不再展示旧康复专用占位文案', () => {
    const settingsHtml = global.readSrc('settings/settings.html');
    const autoscanHtml = global.readSrc('settings/autoscan.html');
    expect(settingsHtml).toContain('运营、行政或客户支持岗位');
    expect(settingsHtml).not.toContain('专业:康复治疗技术');
    expect(settingsHtml).not.toContain('康复治疗相关岗位,广西南宁优先');
    expect(autoscanHtml).toContain('运营 行政 客服 Java 会计');
    expect(autoscanHtml).not.toContain('康复 推拿 针灸');
  });
});

describe('简历档案部分更新与彻底重置', () => {
  let store;
  let origChrome;

  beforeEach(() => {
    store = {};
    origChrome = global.chrome;
    global.chrome = {
      storage: {
        local: {
          get(keys, cb) {
            const ks = Array.isArray(keys) ? keys : [keys];
            const res = {};
            ks.forEach(k => {
              if (Object.prototype.hasOwnProperty.call(store, k)) res[k] = store[k];
            });
            cb(res);
          },
          set(obj, cb) {
            Object.assign(store, obj);
            if (cb) cb();
          },
          remove(keys, cb) {
            (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete store[k]; });
            if (cb) cb();
          }
        }
      }
    };
    loadStorage();
  });

  afterEach(() => {
    global.chrome = origChrome;
  });

  test('手工保存可见字段时保留 AI 扩展字段和未来未知字段', async () => {
    await JTStorage.saveProfile({
      name: '旧姓名',
      workExperience: [{ company: 'A公司', role: '运营实习生' }],
      internship: [{ organization: 'B机构', months: 6 }],
      jobTarget: '运营或客户支持',
      futureField: { source: 'ai-v3' }
    });

    const saved = await JTStorage.saveProfile({ name: '新姓名', skills: ['Excel'] });
    expect(saved.name).toBe('新姓名');
    expect(saved.skills).toEqual(['Excel']);
    expect(saved.workExperience).toEqual([{ company: 'A公司', role: '运营实习生' }]);
    expect(saved.internship).toEqual([{ organization: 'B机构', months: 6 }]);
    expect(saved.jobTarget).toBe('运营或客户支持');
    expect(saved.futureField).toEqual({ source: 'ai-v3' });
  });

  test('并发部分更新按调用顺序串行，两个补丁都不会丢失', async () => {
    const originalSet = global.chrome.storage.local.set;
    global.chrome.storage.local.set = (obj, cb) => {
      setTimeout(() => {
        Object.assign(store, obj);
        if (cb) cb();
      }, 5);
    };

    await Promise.all([
      JTStorage.saveProfile({ workExperience: [{ company: '并发A' }] }),
      JTStorage.saveProfile({ jobTarget: '并发B' })
    ]);
    const profile = await JTStorage.getProfile();
    expect(profile.workExperience).toEqual([{ company: '并发A' }]);
    expect(profile.jobTarget).toBe('并发B');
    global.chrome.storage.local.set = originalSet;
  });

  test('彻底重置使用 replace 覆盖，所有档案扩展字段均被清空', async () => {
    await JTStorage.saveProfile({
      name: '测试用户',
      workExperience: [{ company: 'A公司' }],
      internship: [{ organization: 'B机构' }],
      jobTarget: '跨行业岗位',
      futureField: 'should-disappear'
    });

    await JTStorage.resetUsageData();
    const profile = await JTStorage.getProfile();
    expect(profile.name).toBe('');
    expect(profile.workExperience).toEqual([]);
    expect(profile.internship).toEqual([]);
    expect(profile.jobTarget).toBe('');
    expect(profile.futureField).toBeUndefined();
  });
});
