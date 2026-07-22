// ============================================================
// reasoning-fallback.test.js — 回归:推理模型不再把"思考过程"当答案
// 修复 v1.5.36 的 bug:content 为空时把 reasoning(思考过程)覆盖到 content,
// 再用 tryExtractJSON/extractFieldsFallback 抠出 "fitScore:100 但无结论" 的空壳。
// 本测试断言:content 为空(答案只在 reasoning)时,analyzeJob 必须返回 ok:false(明确报错),
// 绝不能再返回 fitScore:100 的假结果。
// ============================================================

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

// 在全局作用域 eval 源码,并暴露指定顶层符号到 globalThis
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

describe('推理模型把思考过程当答案的回归(根因:100 分空壳)', () => {
  let store;
  let lastFetchBody = null;
  let fetchResponse = null;
  let origChrome;
  let mockFetch;

  beforeAll(() => {
    // 依赖全局(由 setup.js 预加载):JT_CONFIG / JT_Utils / JTAutoScan
    loadSrc('lib/prompts.js', ['JTPrompts']);

    store = {};
    origChrome = global.chrome;
    global.chrome = makeChrome(store);
    // 注意:jsdom 默认没有 global.fetch,必须自己注入 mock(不能用 origFetch 记忆,否则为 undefined)
    mockFetch = async (_url, opts) => {
      lastFetchBody = opts && opts.body ? JSON.parse(opts.body) : null;
      return { ok: true, status: 200, json: async () => fetchResponse };
    };
    global.fetch = mockFetch;

    // 加载 background.js(去掉 importScripts,运行时全局已就绪)
    const code = readSrc('background.js').replace(/importScripts\([^)]*\);?/, '');
    const expose = ['analyzeJob', 'handleResumeAnalysis', 'callLLM', 'isCompleteAnalysis', 'isCompleteResume', 'safeParseAnalysis', 'tryExtractJSON', 'extractCompleteFromText']
      .map((n) => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
      .join('\n');
    // eslint-disable-next-line no-eval
    (0, eval)(code + '\n' + expose);
  });

  afterAll(() => {
    global.chrome = origChrome;
    global.fetch = mockFetch;
  });

  beforeEach(() => {
    // 注意:global.chrome 在 beforeAll 已绑定此 store 对象,这里只能清空并复用同一对象,
    // 不能重新赋值 store = {},否则 chrome 仍引用旧对象导致读不到设置。
    Object.keys(store).forEach((k) => delete store[k]);
    lastFetchBody = null;
    fetchResponse = null;
    // 还原 fetch mock(防止某测试自定义的 fetch 泄漏到后续用例,造成污染)
    global.fetch = mockFetch;
    // 预设 AI 设置:OpenRouter + 推理模型 deepseek-r1
    store[JT_CONFIG.storageKeys.aiSettings] = {
      provider: 'openrouter',
      apiKey: 'sk-or-test',
      model: 'deepseek/deepseek-r1',
      resumeText: '康复治疗专业应届生',
      jobIntent: '南宁康复治疗岗位',
      disableReasoning: false
    };
  });

  test('content 为空、答案只在 reasoning 时:analyzeJob 必须返回 ok:false,绝不返回 100 分空壳', async () => {
    // 模拟推理模型:content 空,reasoning 是思考过程(内含草稿 "fitScore: 100")
    fetchResponse = {
      choices: [{
        message: {
          content: '',
          reasoning: '让我想想这个岗位。专业方向对口,不要求证书,应届可接受。fitScore: 100。结论:很匹配。'
        }
      }]
    };

    const job = { id: 'r1', title: '康复治疗师', company: '某医院', location: '南宁', url: 'https://x.com/1' };
    const res = await analyzeJob(job, true); // force 跳过缓存

    expect(res.ok).toBe(false);
    expect(res.analysis).toBeUndefined();
    // 关键:不能把思考过程里的草稿当结果缓存
    const jobs = (await new Promise((r) => chrome.storage.local.get([JT_CONFIG.storageKeys.jobs], r)))[JT_CONFIG.storageKeys.jobs] || [];
    const saved = jobs.find((j) => j.id === 'r1');
    expect(saved && saved.aiFitScore).toBeUndefined();
    // 报错应引导用户:关闭思考过程 或 换非推理模型
    expect(res.error).toMatch(/关闭思考过程|非推理模型|gpt-4o-mini/);
  });

  test('content 含完整 JSON 时:正常返回分析结果', async () => {
    const analysis = {
      fitScore: 85,
      fitReasons: ['专业对口'],
      gaps: ['薪资偏低'],
      suggestions: ['可协商'],
      risks: [],
      overallRisk: '低',
      summary: '总体较匹配'
    };
    fetchResponse = { choices: [{ message: { content: JSON.stringify(analysis) } }] };

    const job = { id: 'r2', title: '康复治疗师', company: '某医院', location: '南宁', url: 'https://x.com/2' };
    const res = await analyzeJob(job, true);

    expect(res.ok).toBe(true);
    expect(res.analysis.fitScore).toBe(85);
    expect(res.analysis.summary).toBe('总体较匹配');
  });

  test('disableReasoning=true:请求体带 reasoning.enabled=false + thinking.type=disabled,且不再强制 JSON 模式', async () => {
    store[JT_CONFIG.storageKeys.aiSettings].disableReasoning = true;
    const analysis = {
      fitScore: 78,
      fitReasons: ['对口'],
      gaps: [],
      suggestions: ['可考证'],
      risks: [],
      overallRisk: '低',
      summary: '匹配'
    };
    fetchResponse = { choices: [{ message: { content: JSON.stringify(analysis) } }] };

    const job = { id: 'r3', title: '康复治疗师', company: '某医院', location: '南宁', url: 'https://x.com/3' };
    const res = await analyzeJob(job, true);

    expect(res.ok).toBe(true);
    // 关闭思考过程:同时向网关发送两种常见"关思考"参数
    expect(lastFetchBody.reasoning).toEqual({ enabled: false });
    expect(lastFetchBody.thinking).toEqual({ type: 'disabled' });
    // 关思考后不再强制 response_format(避免与"关思考"在某些网关冲突),纯靠提示词约束 JSON
    expect(lastFetchBody.response_format).toBeUndefined();
  });

  test('glm-5.2 被识别为推理模型,glm-4 不识别', () => {
    expect(JT_CONFIG.llm.isReasoningModel('glm-5.2')).toBe(true);
    expect(JT_CONFIG.llm.isReasoningModel('glm-5')).toBe(true);
    expect(JT_CONFIG.llm.isReasoningModel('GLM-5.2')).toBe(true);
    expect(JT_CONFIG.llm.isReasoningModel('glm-4')).toBe(false);
    expect(JT_CONFIG.llm.isReasoningModel('glm-4-plus')).toBe(false);
  });

  test('extractCompleteFromText:从多段文本(草稿在前、完整 JSON 在后)中抠出通过校验的对象', () => {
    const draft = '让我先列草稿:fitScore: 95。';
    const real = { fitScore: 82, fitReasons: ['对口'], gaps: ['薪资低'], suggestions: ['可谈'], risks: [], overallRisk: '低', summary: '总体较匹配' };
    const text = draft + '\n' + JSON.stringify(real) + '\n补充:以上为最终结论。';
    const r = extractCompleteFromText(text, isCompleteAnalysis);
    expect(r).not.toBeNull();
    expect(r.fitScore).toBe(82);
    expect(r.summary).toBe('总体较匹配');
  });

  test('disableReasoning + 网关不支持额外参数(400):自动去掉 reasoning/thinking 重试一次并成功', async () => {
    store[JT_CONFIG.storageKeys.aiSettings].disableReasoning = true;
    store[JT_CONFIG.storageKeys.aiSettings].provider = 'deepseek';
    const analysis = {
      fitScore: 70,
      fitReasons: ['基础对口'],
      gaps: ['经验少'],
      suggestions: ['实习'],
      risks: [],
      overallRisk: '低',
      summary: '可培养'
    };
    let callCount = 0;
    global.fetch = async (_url, opts) => {
      callCount++;
      const body = JSON.parse(opts.body);
      if (callCount === 1) {
        // 第一次带 reasoning/thinking → 网关报 400
        expect(body.reasoning).toEqual({ enabled: false });
        expect(body.thinking).toEqual({ type: 'disabled' });
        return { ok: false, status: 400, text: async () => 'unknown field reasoning', json: async () => ({ error: 'unknown field reasoning' }) };
      }
      // 重试:应已去掉 reasoning/thinking(及 response_format)
      expect(body.reasoning).toBeUndefined();
      expect(body.thinking).toBeUndefined();
      expect(body.response_format).toBeUndefined();
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(analysis) } }] }) };
    };

    const job = { id: 'r9', title: '康复治疗师', company: '某医院', location: '南宁', url: 'https://x.com/9' };
    const res = await analyzeJob(job, true);
    expect(callCount).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.analysis.fitScore).toBe(70);
  });

  test('content 空 + reasoning 无完整 JSON:错误 raw 应携带 reasoning 预览供排查', async () => {
    fetchResponse = {
      choices: [{
        message: { content: '', reasoning: '我在思考这个岗位的匹配度。结论是专业方向大致对口,但没有给出结构化 JSON。' }
      }]
    };
    const job = { id: 'r10', title: '康复治疗师', company: '某医院', location: '南宁', url: 'https://x.com/10' };
    const res = await analyzeJob(job, true);
    expect(res.ok).toBe(false);
    expect(res.raw).toMatch(/reasoning\(思考过程\)前/);
    expect(res.raw).toMatch(/专业方向大致对口/);
  });


  test('isCompleteAnalysis:拒绝 100 分空壳(无 summary/无要点),接受完整结果', () => {
    expect(isCompleteAnalysis({ fitScore: 100 })).toBe(false);
    expect(isCompleteAnalysis({ fitScore: 100, summary: '还行' })).toBe(false); // 缺要点数组
    expect(isCompleteAnalysis({ fitScore: 100, summary: '很匹配', fitReasons: ['对口'] })).toBe(true);
    expect(isCompleteAnalysis(null)).toBe(false);
  });

  test('修复 glm-5.2 等任意网关推理模型:content 空但 reasoning 含完整 JSON 时,analyzeJob 应返回 ok:true', async () => {
    // 模拟混元网关 glm-5.2 的表现:content 为空,完整 JSON 答案在 reasoning 字段。
    const analysis = {
      fitScore: 82,
      fitReasons: ['专业对口'],
      gaps: ['薪资偏低'],
      suggestions: ['可协商'],
      risks: [],
      overallRisk: '低',
      summary: '总体较匹配'
    };
    fetchResponse = { choices: [{ message: { content: '', reasoning: '思考:匹配度较高。\n' + JSON.stringify(analysis) } }] };

    // 预置岗位到存储,验证 AI 分能被持久化(不再是 100 分空壳)
    store[JT_CONFIG.storageKeys.jobs] = [{ id: 'r4', title: '康复治疗师', company: '某医院', location: '南宁', url: 'https://x.com/4' }];

    const job = { id: 'r4', title: '康复治疗师', company: '某医院', location: '南宁', url: 'https://x.com/4' };
    const res = await analyzeJob(job, true);

    expect(res.ok).toBe(true);
    expect(res.analysis.fitScore).toBe(82);
    expect(res.analysis.summary).toBe('总体较匹配');
    const jobs = (await new Promise((r) => chrome.storage.local.get([JT_CONFIG.storageKeys.jobs], r)))[JT_CONFIG.storageKeys.jobs] || [];
    const saved = jobs.find((j) => j.id === 'r4');
    expect(saved && saved.aiFitScore).toBe(82);
  });

  test('(简历)content 空但 reasoning 含完整档案 JSON 时,handleResumeAnalysis 应返回 ok:true', async () => {
    const profile = { name: '测试用户', education: '大专', skills: ['PT'] };
    fetchResponse = { choices: [{ message: { content: '', reasoning: JSON.stringify(profile) } }] };

    // 简历文本需 ≥20 字,否则会在开头被"文本太少"拦截
    const res = await handleResumeAnalysis('康复治疗专业应届生,希望找南宁正规医疗机构的岗位', '南宁');
    expect(res.ok).toBe(true);
    expect(res.profile.name).toBe('测试用户');
    expect(res.profile.education).toBe('大专');
  });

  test('isCompleteResume:拒绝无姓名,接受姓名+其它字段', () => {
    expect(isCompleteResume({ phone: '123' })).toBe(false);
    expect(isCompleteResume({ name: '测试用户' })).toBe(false); // 仅姓名,缺其它
    expect(isCompleteResume({ name: '测试用户', education: '大专' })).toBe(true);
    expect(isCompleteResume({ name: '测试用户', skills: ['PT'] })).toBe(true);
  });
});
