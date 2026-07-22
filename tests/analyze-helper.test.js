// ============================================================
// analyze-helper.test.js — 测试 JTAnalyzeHelper.maybeAutoAnalyze
// 覆盖:autoAnalyze 关闭拦截 / 日上限拦截 / 成功分析写回计数 / 分析失败静默
// ============================================================

describe('JTAnalyzeHelper.maybeAutoAnalyze', () => {
  let origChrome, origJTStorage, origJTAutoScan;

  beforeEach(() => {
    // 备份全局对象
    origChrome = global.chrome;
    origJTStorage = global.JTStorage;
    origJTAutoScan = global.JTAutoScan;

    // mock chrome.runtime.sendMessage
    global.chrome = {
      runtime: {
        sendMessage: jest.fn(),
        lastError: null
      }
    };

    // mock JTStorage
    global.JTStorage = {
      _cfgStore: null,
      getAutoScan: jest.fn(async () => {
        return global.JTStorage._cfgStore;
      }),
      saveAutoScan: jest.fn(async (cfg) => {
        global.JTStorage._cfgStore = cfg;
        return cfg;
      }),
      // 原子占额度:复用测试注入的 getAutoScan/saveAutoScan + JTAutoScan.resetDailyIfNeeded
      consumeAnalysisQuota: jest.fn(async (perDay) => {
        perDay = perDay || 0;
        const cfg = await global.JTStorage.getAutoScan();
        global.JTAutoScan.resetDailyIfNeeded(cfg);
        const cur = cfg.analyzedToday || 0;
        if (perDay > 0 && cur >= perDay) {
          return { ok: false, reason: 'limit', analyzedToday: cur };
        }
        cfg.analyzedToday = cur + 1;
        await global.JTStorage.saveAutoScan(cfg);
        return { ok: true, analyzedToday: cfg.analyzedToday };
      })
    };

    // mock JTAutoScan(保留 resetDailyIfNeeded 真实逻辑)
    global.JTAutoScan = {
      resetDailyIfNeeded: jest.fn((state) => {
        const today = new Date().toISOString().slice(0, 10);
        if (state.lastDate !== today) {
          state.lastDate = today;
          state.analyzedToday = 0;
        }
        return state;
      })
    };
  });

  afterEach(() => {
    global.chrome = origChrome;
    global.JTStorage = origJTStorage;
    global.JTAutoScan = origJTAutoScan;
  });

  function setCfg(overrides) {
    global.JTStorage._cfgStore = Object.assign({
      enabled: false,
      keywords: '康复',
      city: '100010000',
      autoAnalyze: true,
      analyzePerDay: 30,
      lastDate: new Date().toISOString().slice(0, 10), // 默认当天,避免 resetDailyIfNeeded 误重置
      analyzedToday: 0
    }, overrides || {});
  }

  test('autoAnalyze 关闭时不分析', async () => {
    setCfg({ autoAnalyze: false });
    const job = { title: '康复治疗师', url: 'https://example.com/1' };
    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(false);
    expect(r.reason).toContain('autoAnalyze');
    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('已达每日分析上限时不分析', async () => {
    setCfg({ autoAnalyze: true, analyzePerDay: 5, analyzedToday: 5 });
    const job = { title: '康复治疗师', url: 'https://example.com/1' };
    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(false);
    expect(r.reason).toContain('上限');
    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('analyzePerDay=0 时视为无上限,正常分析', async () => {
    setCfg({ autoAnalyze: true, analyzePerDay: 0, analyzedToday: 0 });
    const analysis = { fitScore: 80, fitReasons: ['匹配'], gaps: [], suggestions: [] };
    global.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, analysis: analysis, cached: false });
    });
    const job = { title: '康复治疗师', url: 'https://example.com/1' };
    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(true);
    expect(r.analysis).toEqual(analysis);
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalled();
  });

  test('分析成功时递增日计数并返回 analysis', async () => {
    setCfg({ autoAnalyze: true, analyzePerDay: 30, analyzedToday: 3 });
    const analysis = { fitScore: 85, fitReasons: ['匹配'], gaps: [], suggestions: [] };
    global.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, analysis: analysis, cached: false });
    });
    const job = { title: '康复治疗师', url: 'https://example.com/1' };
    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(true);
    expect(r.analysis).toEqual(analysis);
    expect(global.JTStorage.saveAutoScan).toHaveBeenCalled();
    // 验证日计数递增
    const savedCfg = global.JTStorage.saveAutoScan.mock.calls[0][0];
    expect(savedCfg.analyzedToday).toBe(4);
  });

  test('分析失败(无 API Key)时静默,不递增计数', async () => {
    setCfg({ autoAnalyze: true, analyzePerDay: 30, analyzedToday: 0 });
    global.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: false, error: '尚未配置 API Key', needSettings: true });
    });
    const job = { title: '康复治疗师', url: 'https://example.com/1' };
    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(true);
    expect(r.analysis).toBeUndefined();
    expect(r.reason).toContain('API Key');
    // 注意:新逻辑先原子占额度(consumeAnalysisQuota 内部已 saveAutoScan 递增计数),
    // 分析失败不退额度(最坏多算一次,但绝不超每日上限)。故此处保存已发生、计数+1。
    expect(global.JTStorage.saveAutoScan).toHaveBeenCalled();
    const savedCfg = global.JTStorage.saveAutoScan.mock.calls[0][0];
    expect(savedCfg.analyzedToday).toBe(1);
  });

  test('sendMessage 无响应时静默返回', async () => {
    setCfg({ autoAnalyze: true, analyzePerDay: 30, analyzedToday: 0 });
    global.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb(null);
    });
    const job = { title: '康复治疗师', url: 'https://example.com/1' };
    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    expect(r.analyzed).toBe(true);
    expect(r.analysis).toBeUndefined();
    expect(r.reason).toBe('无响应');
  });

  test('跨日时重置计数后再分析', async () => {
    // 模拟昨天已用满
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    setCfg({ autoAnalyze: true, analyzePerDay: 5, analyzedToday: 5, lastDate: yesterday });
    const analysis = { fitScore: 70 };
    global.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, analysis: analysis, cached: false });
    });
    const job = { title: 'PT', url: 'https://example.com/2' };
    const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
    // 跨日重置后 analyzedToday 变 0,不拦截
    expect(r.analyzed).toBe(true);
    expect(r.analysis).toEqual(analysis);
    const savedCfg = global.JTStorage.saveAutoScan.mock.calls[0][0];
    expect(savedCfg.analyzedToday).toBe(1); // 重置后递增到 1
  });

  test('无 job 对象时返回 analyzed=false', async () => {
    setCfg({ autoAnalyze: true });
    const r = await JTAnalyzeHelper.maybeAutoAnalyze(null);
    expect(r.analyzed).toBe(false);
    expect(r.reason).toContain('无岗位');
  });
});

describe('JTAnalyzeHelper.analyzeOne', () => {
  let origChrome;

  beforeEach(() => {
    origChrome = global.chrome;
    global.chrome = {
      runtime: { sendMessage: jest.fn(), lastError: null }
    };
  });

  afterEach(() => {
    global.chrome = origChrome;
  });

  test('返回 background 分析结果', async () => {
    const analysis = { fitScore: 90 };
    global.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, analysis: analysis, cached: true });
    });
    const res = await JTAnalyzeHelper.analyzeOne({ title: '测试', url: 'https://x.com' });
    expect(res.ok).toBe(true);
    expect(res.analysis).toEqual(analysis);
    expect(res.cached).toBe(true);
  });

  test('chrome.runtime.lastError 时返回 null', async () => {
    global.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      global.chrome.runtime.lastError = { message: '端口断开' };
      cb(null);
      global.chrome.runtime.lastError = null;
    });
    const res = await JTAnalyzeHelper.analyzeOne({ title: '测试' });
    expect(res).toBeNull();
  });
});
