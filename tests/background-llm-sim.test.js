// ============================================================
// background-llm-sim.test.js — background.callLLM / doFetch 仿真
// 复用 reasoning-fallback 的加载方式(剥离 importScripts 后 eval background.js),
// 在可控 fetch 桩下覆盖:
//   · M7:baseUrl 非 https → 直接报错,不发起 fetch(防 API Key 明文泄露)
//   · 429 / 5xx:指数退避重试(标记 _retryOnStatus)
//   · 400 / 422:去掉 response_format/reasoning/thinking 重试一次(_retryable)
//   · 401 / 404:明确文案,不重试
//   · AbortError:超时文案
// 不触网:fetch / AbortController / setTimeout 全部由测试桩接管。
// ============================================================

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

function loadSrc(rel, exportNames = []) {
  const code = readSrc(rel);
  const expose = exportNames
    .map((n) => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
    .join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}

function makeChrome(store) {
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
    runtime: { onInstalled: { addListener: noop }, onMessage: { addListener: noop }, sendMessage: noop, lastError: null },
    contextMenus: { create: noop, onClicked: { addListener: noop } },
    alarms: { create: noop, clear: noop, onAlarm: { addListener: noop } },
    tabs: { sendMessage: noop, query: noop },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop }
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return new Proxy({ addListener: noop, create: noop, clear: noop, get: noop, set: noop, remove: noop, sendMessage: noop, query: noop, setBadgeText: noop }, {
        get(tt, p) { return (p in tt) ? tt[p] : noop; }
      });
    }
  });
}

describe('P7 · background.callLLM / doFetch 仿真(M7 / 重试 / 超时)', () => {
  let store;
  let origChrome;
  let fetchMock;          // 当前 fetch 桩(每个用例可替换)
  let lastFetchBody;      // 最近一次请求体
  let fetchCallCount;     // fetch 调用次数

  beforeAll(() => {
    loadSrc('lib/prompts.js', ['JTPrompts']);

    store = {};
    origChrome = global.chrome;
    global.chrome = makeChrome(store);

    // AbortController 桩:abort 为 no-op(不真正中断),避免 setTimeout 立即触发误杀正常请求
    global.AbortController = class {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; }
    };
    // setTimeout 桩:回调在下一微任务立即执行(让 429/5xx 退避等待瞬时完成;
    // 同时 abort 计时器也立即触发,但 abort 是 no-op,不影响正常请求)
    global.setTimeout = (fn) => { Promise.resolve().then(() => { if (typeof fn === 'function') fn(); }); return 0; };

    const code = readSrc('background.js').replace(/importScripts\([^)]*\);?/, '');
    const expose = ['callLLM', 'doFetch', 'analyzeJob', 'saveJobDedup', 'JT_CONFIG']
      .map((n) => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
      .join('\n');
    // eslint-disable-next-line no-eval
    (0, eval)(code + '\n' + expose);
  });

  afterAll(() => {
    global.chrome = origChrome;
  });

  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
    lastFetchBody = null;
    fetchCallCount = 0;
    // 默认 fetch:200 + 简单 JSON(计数统一由 wrapper 完成,这里不再自增)
    fetchMock = async (_url, opts) => {
      lastFetchBody = opts && opts.body ? JSON.parse(opts.body) : null;
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ fitScore: 80, summary: 'ok', fitReasons: ['对口'], gaps: [], suggestions: [], risks: [], overallRisk: '低' }) } }] })
      };
    };
    // fetch 包装:每次调用都计数,再委托给当前 fetchMock(各用例可替换 fetchMock)
    global.fetch = (...args) => { fetchCallCount++; return fetchMock(...args); };
  });

  const baseSettings = (over = {}) => Object.assign({
    provider: 'deepseek',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com'
  }, over);

  const messages = [{ role: 'user', content: '分析岗位' }];

  test('saveJobDedup 对缺 id 的边界输入自动补齐稳定 id', async () => {
    store[JT_CONFIG.storageKeys.jobs] = [];
    store[JT_CONFIG.storageKeys.deletedJobs] = [];
    const result = await saveJobDedup({ title: '康复治疗师', company: '测试医院', url: 'https://example.com/job/1' });
    expect(result.action).toBe('added');
    expect(result.job.id).toMatch(/^jt_[a-z0-9]+_[a-z0-9]{6}$/);
    expect(store[JT_CONFIG.storageKeys.jobs][0].id).toBe(result.job.id);
  });

  // ---------- M7 HTTPS 强制 ----------
  test('M7 · baseUrl 为 http 明文 → 直接报错且未发起 fetch', async () => {
    const settings = baseSettings({ baseUrl: 'http://api.deepseek.com' });
    const res = await callLLM(settings, messages, true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('HTTPS');
    expect(fetchCallCount).toBe(0); // 根本没发请求
  });

  test('M7 · 正常 https baseUrl → 正常发起请求', async () => {
    const res = await callLLM(baseSettings(), messages, true);
    expect(res.ok).toBe(true);
    expect(fetchCallCount).toBe(1);
  });

  // ---------- 401 / 404 不重试 ----------
  test('401 · API Key 无效 → 明确文案,不重试', async () => {
    fetchMock = async () => ({ ok: false, status: 401, text: async () => 'invalid key', json: async () => ({ error: 'unauthorized' }) });
    const res = await callLLM(baseSettings(), messages, true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('401');
    expect(fetchCallCount).toBe(1); // 不重试
  });

  test('404 · 接口/模型错误 → 明确文案,不重试', async () => {
    fetchMock = async () => ({ ok: false, status: 404, text: async () => 'not found', json: async () => ({ error: 'not found' }) });
    const res = await callLLM(baseSettings(), messages, true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('404');
    expect(fetchCallCount).toBe(1);
  });

  // ---------- 429 / 5xx 退避重试 ----------
  test('429 · 限流 → 退避重试,最多 3 次请求', async () => {
    fetchMock = async () => ({ ok: false, status: 429, text: async () => 'rate limit', json: async () => ({ error: 'rate' }) });
    const res = await callLLM(baseSettings(), messages, true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('429');
    expect(fetchCallCount).toBe(3); // 首 + 2 次退避重试
  });

  test('500 · 服务器错误 → 退避重试,直到成功则返回 ok', async () => {
    let n = 0;
    fetchMock = async () => {
      n++;
      if (n < 2) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({ error: 'boom' }) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ fitScore: 75, summary: 'ok', fitReasons: ['x'], gaps: [], suggestions: [], risks: [], overallRisk: '低' }) } }] }) };
    };
    const res = await callLLM(baseSettings(), messages, true);
    expect(res.ok).toBe(true);
    expect(fetchCallCount).toBe(2); // 首失败 + 1 次重试成功
  });

  // ---------- 400 / 422 去掉额外参数重试 ----------
  test('400 · response_format 不被支持 → 去掉 JSON 模式参数重试一次并成功', async () => {
    let n = 0;
    fetchMock = async (_url, opts) => {
      n++;
      const body = JSON.parse(opts.body);
      if (n === 1) {
        expect(body.response_format).toBeDefined(); // 首请求带 JSON 模式
        return { ok: false, status: 400, text: async () => 'unknown field response_format', json: async () => ({ error: 'bad' }) };
      }
      expect(body.response_format).toBeUndefined(); // 重试已去掉
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ fitScore: 70, summary: 'ok', fitReasons: ['x'], gaps: [], suggestions: [], risks: [], overallRisk: '低' }) } }] }) };
    };
    const res = await callLLM(baseSettings(), messages, true);
    expect(res.ok).toBe(true);
    expect(fetchCallCount).toBe(2);
  });

  test('422 · reasoning/thinking 不被支持 → 去掉后重试', async () => {
    let n = 0;
    fetchMock = async (_url, opts) => {
      n++;
      const body = JSON.parse(opts.body);
      if (n === 1) {
        expect(body.reasoning).toBeDefined();
        expect(body.thinking).toBeDefined();
        return { ok: false, status: 422, text: async () => 'unknown field reasoning', json: async () => ({ error: 'bad' }) };
      }
      expect(body.reasoning).toBeUndefined();
      expect(body.thinking).toBeUndefined();
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ fitScore: 72, summary: 'ok', fitReasons: ['x'], gaps: [], suggestions: [], risks: [], overallRisk: '低' }) } }] }) };
    };
    const res = await callLLM(baseSettings({ disableReasoning: true }), messages, true);
    expect(res.ok).toBe(true);
    expect(fetchCallCount).toBe(2);
  });

  // ---------- 超时(AbortError) ----------
  test('AbortError · 请求超时 → 超时文案', async () => {
    fetchMock = async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
    const res = await callLLM(baseSettings(), messages, true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('超时');
  });

  // ---------- 通用网络错误 ----------
  test('网络错误 · fetch 抛非 Abort 异常 → 网络错误文案', async () => {
    fetchMock = async () => { throw new Error('Failed to fetch'); };
    const res = await callLLM(baseSettings(), messages, true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('网络错误');
  });

  // ---------- 缺 API Key ----------
  test('未填 API Key → 明确提示', async () => {
    const res = await callLLM(baseSettings({ apiKey: '' }), messages, true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('API Key');
    expect(fetchCallCount).toBe(0);
  });

  // ---------- AI 深度分析时整合天眼查企业信息 ----------
  test('analyzeJob 在调 LLM 前预查企业信息并注入 prompt(桥接已连)', async () => {
    // 种子 AI 设置(apiKey 必备)
    store[JT_CONFIG.storageKeys.aiSettings] = { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', jobIntent: '康复相关岗位' };
    store[JT_CONFIG.storageKeys.aiKeys] = { deepseek: 'sk-test' };

    const presetRisk = {
      source: 'tyc-ai', unifiedCode: '91450100MAK4RJ3C3M', legalName: '示例健康科技有限公司',
      legalStatus: '存续', insuredCount: 6, industryMatch: 'low', riskLevel: 'low',
      medicalQualified: false, judicialRisk: { caseCount: 0, types: [], level: 'low' }
    };
    // 模拟 bridge 已连 + 天眼查返回预设风险
    global.JTMcpConnector = {
      isConnected: () => true,
      getCompanyRisk: async (job) => (job.company ? presetRisk : null)
    };

    const res = await analyzeJob({ id: 'j1', title: '康复治疗师', company: '示例健康科技有限公司', description: '康复理疗' });
    expect(res.ok).toBe(true);
    // 返回结果携带企业风险(供卡片展示)
    expect(res.companyRisk).toBeDefined();
    expect(res.companyRisk.unifiedCode).toBe('91450100MAK4RJ3C3M');
    // 三态 meta:已查到企业
    expect(res.companyRiskMeta).toBeDefined();
    expect(res.companyRiskMeta.queried).toBe(true);
    expect(res.companyRiskMeta.found).toBe(true);
    // LLM 请求体必须包含企业工商/风险信息(岗位+企业结合分析)
    expect(fetchCallCount).toBe(1);
    const sentMessages = lastFetchBody.messages;
    const userText = sentMessages.find((m) => m.role === 'user').content;
    const sysText = sentMessages.find((m) => m.role === 'system').content;
    expect(sysText).toContain('企业信息使用规则');
    expect(userText).toContain('示例健康科技有限公司');
    expect(userText).toContain('参保人数：6');
    expect(userText).toContain('<company_data>');
  });

  test('analyzeJob 桥接未连时降级为仅岗位分析(不报错、不注入企业信息)', async () => {
    store[JT_CONFIG.storageKeys.aiSettings] = { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', jobIntent: '康复相关岗位' };
    store[JT_CONFIG.storageKeys.aiKeys] = { deepseek: 'sk-test' };
    global.JTMcpConnector = { isConnected: () => false, getCompanyRisk: async () => null };

    const res = await analyzeJob({ id: 'j2', title: '康复治疗师', company: '某医院', description: '康复' });
    expect(res.ok).toBe(true);
    expect(res.companyRisk).toBeUndefined();
    const userText = lastFetchBody.messages.find((m) => m.role === 'user').content;
    expect(userText).not.toContain('company_data');
  });
});
