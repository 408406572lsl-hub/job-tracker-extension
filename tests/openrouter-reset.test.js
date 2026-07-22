// ============================================================
// openrouter-reset.test.js — OpenRouter 服务商接入 +
// resetUsageData(清空使用记录但保留 AI 配置/Key) 回归
// ============================================================

function loadStorage() {
  const code = global.readSrc('lib/storage.js');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\nglobalThis.JTStorage = (typeof JTStorage !== "undefined") ? JTStorage : undefined;');
}

describe('OpenRouter 服务商接入', () => {
  test('config 含 openrouter 且 baseUrl 正确(OpenAI 兼容)', () => {
    expect(JT_CONFIG.llm.providers.openrouter).toBeDefined();
    expect(JT_CONFIG.llm.providers.openrouter.name).toBe('OpenRouter');
    expect(JT_CONFIG.llm.providers.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(JT_CONFIG.llm.providers.openrouter.defaultModel).toBe('openai/gpt-4o-mini');
    // 聚合多厂商模型,命名形如 厂商/模型
    expect(JT_CONFIG.llm.providers.openrouter.models).toContain('deepseek/deepseek-chat');
    expect(JT_CONFIG.llm.providers.openrouter.models).toContain('openai/gpt-4o-mini');
  });
});

describe('JTStorage.resetUsageData(彻底重置:仅保留 API Key)', () => {
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
            ks.forEach(k => { if (Object.prototype.hasOwnProperty.call(store, k)) res[k] = store[k]; });
            cb(res);
          },
          set(obj, cb) {
            Object.keys(obj).forEach(k => { store[k] = obj[k]; });
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

  test('重置后岗位/墓碑清空,AI Key 保留,但 AI 配置(服务商/求职意向等)清空', async () => {
    // 模拟用户已配置 OpenRouter Key + 已记录岗位 + 已删除(墓碑)
    await JTStorage.saveAiSettings({
      provider: 'openrouter',
      apiKey: 'sk-or-test-123',
      model: 'openai/gpt-4o-mini',
      jobIntent: '康复治疗'
    });
    await JTStorage.saveJob({ id: 'x1', url: 'https://www.zhipin.com/job/x', title: '康复治疗师' });
    await JTStorage.deleteJob('x1'); // 写入墓碑

    // 执行重置
    await JTStorage.resetUsageData();

    // 岗位清空
    expect(await JTStorage.getJobs()).toHaveLength(0);
    // 墓碑清空(之后扫描可重新收录,真正的首次使用状态)
    expect(await JTStorage.getDeletedKeys()).toHaveLength(0);
    // 自动扫描统计归零(连扫过多少都不知道)
    const as = await JTStorage.getAutoScan();
    expect(as.totalCollected).toBe(0);
    expect(as.lastScanAt).toBe(0);
    expect(as.analyzedToday).toBe(0);
    // 简历档案清空
    const prof = await JTStorage.getProfile();
    expect(prof.name).toBe('');
    expect(prof.resumeText).toBe('');
    expect(prof.workExperience).toEqual([]);
    expect(prof.internship).toEqual([]);
    expect(prof.jobTarget).toBe('');
    // API Key 必须保留(按服务商存入 providerKeys)
    const keys = await JTStorage.getProviderKeys();
    expect(keys.openrouter).toBe('sk-or-test-123');
    // AI 配置(服务商/求职意向等)已清空回默认 —— 不再是重置前的自定义值
    const ai = await JTStorage.getAiSettings();
    expect(ai.provider).toBe(JT_CONFIG.defaultAiSettings.provider);
    expect(ai.jobIntent).toBe(JT_CONFIG.defaultAiSettings.jobIntent); // 重置为默认意向,而非自定义'康复治疗'
    expect(ai.model).toBe(JT_CONFIG.defaultAiSettings.model);
  });

  test('重置清空 AI 服务商/模型/简历文本等,但保留 Key', async () => {
    await JTStorage.saveAiSettings({
      provider: 'openrouter',
      apiKey: 'sk-keep-me',
      model: 'anthropic/claude-3.5-sonnet',
      resumeText: '姓名:测试用户',
      chatStyle: 'active',
      extraNotes: '月薪低于4000不考虑'
    });
    await JTStorage.saveJob({ id: 'y1', url: 'https://www.zhipin.com/job/y', title: '推拿师' });

    await JTStorage.resetUsageData();

    const ai = await JTStorage.getAiSettings();
    expect(ai.model).toBe(JT_CONFIG.defaultAiSettings.model);
    // 用户填入的 AI 上下文已清空,回落到默认值(不再是重置前的自定义内容)
    expect(ai.resumeText).toBe(JT_CONFIG.defaultAiSettings.resumeText);
    expect(ai.chatStyle).toBe(JT_CONFIG.defaultAiSettings.chatStyle);
    expect(ai.extraNotes).toBe(JT_CONFIG.defaultAiSettings.extraNotes);
    // Key 仍保留
    const keys = await JTStorage.getProviderKeys();
    expect(keys.openrouter).toBe('sk-keep-me');
    // 岗位已清空
    expect(await JTStorage.getJobs()).toHaveLength(0);
  });
});
