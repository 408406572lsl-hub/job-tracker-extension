// ============================================================
// mcp-connector-sim.test.js — MCP 桥接 WS 消息往返仿真
// 用桩 WebSocket + makeChrome(mock storage) 模拟桥接进程与扩展的
// 双向 JSON 通信,覆盖读/写 action、异常消息、Blob 分支等路径。
// 不触网:WebSocket/setTimeout 全部由测试桩接管。
//
// 关于"断线重连":源码 connect() 的守卫是
//   `if (conn.ws && (readyState===OPEN||CONNECTING)) return;`
// 当 onclose 把 conn.ws 置 null 后,该守卫为 false,会继续执行 new WebSocket()
// 重建连接——所以重连是正常工作的。本测试用单条持久连接建模正常运行态,
// 并额外用「推进 fake timers」显式验证断线后能创建出新的 WS 实例。
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
    runtime: { onInstalled: { addListener: noop }, onMessage: { addListener: noop }, onStartup: { addListener: noop }, sendMessage: noop, getURL: (p) => 'chrome-extension://test/' + p, lastError: null },
    tabs: { query: noop, sendMessage: noop, create: noop, remove: noop },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return new Proxy({ addListener: noop, create: noop, clear: noop, get: noop, set: noop, remove: noop, sendMessage: noop, query: noop }, {
        get(tt, p) { return (p in tt) ? tt[p] : noop; }
      });
    }
  });
}

function makeWebSocketStub() {
  const instances = [];
  function FakeWebSocket(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    const self = this;
    instances.push(self);
    this._open = () => { self.readyState = 1; if (self.onopen) self.onopen(); };
    this._receive = (data) => {
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data.text().then((t) => { if (self.onmessage) self.onmessage({ data: t }); });
      } else if (self.onmessage) {
        self.onmessage({ data });
      }
    };
    this._fail = () => { self.readyState = 3; if (self.onclose) self.onclose(); };
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k, idx) => {
    Object.defineProperty(FakeWebSocket, k, { value: idx, configurable: true, writable: true });
  });
  FakeWebSocket.prototype.send = function (msg) { this.sent.push(msg); };
  FakeWebSocket.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose(); };
  return { FakeWebSocket, instances };
}

describe('mcp-connector WS 消息往返仿真', () => {
  let store;
  let wsStub;
  let persistentWs; // 单条持久连接
  let origChrome, origWebSocket, origSetTimeout, origConsoleDebug, origConsoleLog, origBlob;
  let debugCalls;

  // 向持久 WS 塞入一条桥接请求,等待扩展异步回发后返回解析响应
  // 用 _reqId 匹配而非"最后一条",避免 storage 异步回发晚于 30 轮微任务时取到旧消息
  async function sendRequest(action, params = {}) {
    const _reqId = 'req-' + Math.random().toString(36).slice(2);
    persistentWs._receive(JSON.stringify({ _reqId, action, params }));
    let raw = null;
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
      const sent = persistentWs.sent.filter((s) => {
        try { return JSON.parse(s)._reqId === _reqId; } catch (e) { return false; }
      });
      if (sent.length > 0) { raw = sent[0]; break; }
    }
    return raw ? JSON.parse(raw) : null;
  }

  function seedJobs() {
    store[JT_CONFIG.storageKeys.jobs] = [
      { id: 'j1', title: '康复治疗师', company: 'A医院', location: '南宁', url: 'https://x.com/1', score: 60, status: 'unseen', aiFitScore: 70 },
      { id: 'j2', title: '理疗师', company: 'B中心', location: '广州', url: 'https://x.com/2', score: 30, status: 'applied', aiFitScore: null },
      { id: 'j3', title: '康复治疗师', company: 'C院', location: '南宁', url: 'https://x.com/3', score: 85, status: 'unseen', aiFitScore: 80 },
    ];
  }

  beforeAll(() => {
    jest.useFakeTimers();
    store = {};
    wsStub = makeWebSocketStub();
    origChrome = global.chrome; origWebSocket = global.WebSocket; origSetTimeout = global.setTimeout;
    origConsoleDebug = console.debug;
    const origConsoleLog = console.log;
    debugCalls = [];
    console.debug = (...a) => { debugCalls.push(a.join(' ')); };
    console.log = (...a) => { debugCalls.push(a.join(' ')); };
    origBlob = global.Blob;
    global.Blob = class { constructor(parts) { this._parts = parts || []; } text() { return Promise.resolve(this._parts.map((p) => String(p)).join('')); } };
    global.WebSocket = wsStub.FakeWebSocket;
    globalThis.WebSocket = wsStub.FakeWebSocket;
    if (typeof window !== 'undefined') window.WebSocket = wsStub.FakeWebSocket;
    global.chrome = makeChrome(store);

    global.analyzeJob = async () => ({ ok: true, analysis: { fitScore: 90, summary: 'ok' }, cached: false });
    global.wakeFrontendToScan = async () => ({ via: 'new_dashboard' });
    global.getAutoScanStatus = async () => ({ running: false });
    global.handleReply = async () => ({ ok: true, versions: [{ text: 'hi' }] });
    global.handleSmartReply = async () => ({ ok: true, versions: [{ text: 'smart' }] });

    loadSrc('lib/config.js', ['JT_CONFIG', 'JT_Utils']);
    loadSrc('lib/mcp-connector.js', []);
    seedJobs();
    // 建立单条持久连接并握手
    global.JTMcpConnector.connect();
    persistentWs = wsStub.instances[0];
    persistentWs._open();
    // 桩"server":对扩展主动发出的 enrichCompany(L 前缀)请求回传预设 companyRisk,
    // 模拟 mcp-bridge 调天眼AI 后写回(避免 requestToBridge 在 fake timer 下永久挂起)。
    const origSend = wsStub.FakeWebSocket.prototype.send;
    wsStub.FakeWebSocket.prototype.send = function (msg) {
      const parsed = (() => { try { return JSON.parse(msg); } catch (e) { return null; } })();
      if (parsed && parsed.action === 'enrichCompany' && typeof parsed._reqId === 'string' && parsed._reqId.startsWith('L')) {
        Promise.resolve().then(() => {
          persistentWs._receive(JSON.stringify({
            _reqId: parsed._reqId,
            result: { source: 'tyc-ai', unifiedCode: 'X1', legalName: parsed.params.companyName, riskLevel: 'low', industryMatch: 'mid', judicialRisk: { level: 'low' } },
          }));
        });
      }
      return origSend.call(this, msg);
    };
  });

  afterAll(() => {
    jest.useRealTimers();
    global.chrome = origChrome; global.WebSocket = origWebSocket; global.setTimeout = origSetTimeout;
    console.debug = origConsoleDebug;
    console.log = origConsoleLog;
    if (origBlob !== undefined) global.Blob = origBlob;
    delete global.analyzeJob; delete global.wakeFrontendToScan;
    delete global.getAutoScanStatus; delete global.handleReply; delete global.handleSmartReply;
  });

  beforeEach(() => {
    debugCalls.length = 0;
    Object.keys(store).forEach((k) => delete store[k]);
    seedJobs();
  });

  test('握手:连接后首条消息为 JT_MCP_CONNECTED', () => {
    expect(persistentWs.sent[0]).toContain('JT_MCP_CONNECTED');
  });

  test('getJobs 返回岗位数组', async () => {
    const res = await sendRequest('getJobs');
    expect(Array.isArray(res.result)).toBe(true);
    expect(res.result.length).toBe(3);
  });

  test('getStats 聚合 byStatus,matched 使用 AI 分优先', async () => {
    store[JT_CONFIG.storageKeys.jobs][0].score = 10;
    store[JT_CONFIG.storageKeys.jobs][0].aiFitScore = 70;
    const res = await sendRequest('getStats');
    expect(res.result.total).toBe(3);
    expect(res.result.byStatus.unseen).toBe(2);
    expect(res.result.byStatus.applied).toBe(1);
    expect(res.result.matched).toBe(2);
  });

  test('searchJobs 关键词+状态+minScore 过滤与排序,AI 分优先', async () => {
    store[JT_CONFIG.storageKeys.jobs][0].score = 95;
    store[JT_CONFIG.storageKeys.jobs][0].aiFitScore = 70;
    store[JT_CONFIG.storageKeys.jobs][2].score = 20;
    store[JT_CONFIG.storageKeys.jobs][2].aiFitScore = 80;
    let res = await sendRequest('searchJobs', { keyword: '康复', status: 'unseen', minScore: 75, sortBy: 'score' });
    expect(res.result.total).toBe(1);
    expect(res.result.jobs[0].id).toBe('j3');
    expect(res.result.jobs[0].score).toBe(80);
    expect(res.result.jobs[0].scoreSource).toBe('ai');
    res = await sendRequest('searchJobs', { city: '广州' });
    expect(res.result.total).toBe(1);
    expect(res.result.jobs[0].id).toBe('j2');
  });

  test('getJobDetail 返回完整字段含 AI 分析', async () => {
    const res = await sendRequest('getJobDetail', { jobId: 'j1' });
    expect(res.result.ok).toBe(true);
    expect(res.result.job.id).toBe('j1');
    expect(res.result.job.aiFitScore).toBe(70);
  });

  test('getJobDetail 不存在的岗位抛错回传 error', async () => {
    const res = await sendRequest('getJobDetail', { jobId: 'nope' });
    expect(res.result).toBeUndefined();
    expect(res.error).toMatch(/岗位不存在/);
  });

  test('updateStatus / updateNotes 实际改写 store', async () => {
    let res = await sendRequest('updateStatus', { jobId: 'j1', status: 'applied' });
    expect(res.result.ok).toBe(true);
    expect(store[JT_CONFIG.storageKeys.jobs].find((j) => j.id === 'j1').status).toBe('applied');
    res = await sendRequest('updateNotes', { jobId: 'j1', notes: '已沟通' });
    expect(res.result.ok).toBe(true);
    expect(store[JT_CONFIG.storageKeys.jobs].find((j) => j.id === 'j1').notes).toBe('已沟通');
  });

  test('deleteJob / deleteJobs 实际删除并写入墓碑', async () => {
    let res = await sendRequest('deleteJob', { jobId: 'j1' });
    expect(res.result.ok).toBe(true);
    expect(res.result.remaining).toBe(2);
    expect(store[JT_CONFIG.storageKeys.deletedJobs]).toContain(JT_Utils.jobKey({
      url: 'https://x.com/1', title: '康复治疗师', company: 'A医院'
    }));

    res = await sendRequest('deleteJobs', { jobIds: ['j2', 'j3'] });
    expect(res.result.deleted).toBe(2);
    expect(res.result.remaining).toBe(0);
    expect(store[JT_CONFIG.storageKeys.deletedJobs]).toEqual(expect.arrayContaining([
      JT_Utils.jobKey({ url: 'https://x.com/2', title: '理疗师', company: 'B中心' }),
      JT_Utils.jobKey({ url: 'https://x.com/3', title: '康复治疗师', company: 'C院' })
    ]));
  });

  test('exportJobs 的 minScore 与 CSV 分数使用 AI 分优先', async () => {
    store[JT_CONFIG.storageKeys.jobs][0].score = 10;
    store[JT_CONFIG.storageKeys.jobs][0].aiFitScore = 70;
    store[JT_CONFIG.storageKeys.jobs][2].score = 85;
    store[JT_CONFIG.storageKeys.jobs][2].aiFitScore = 30;

    const jsonRes = await sendRequest('exportJobs', { format: 'json', filter: { minScore: 60 } });
    const exported = JSON.parse(jsonRes.result);
    expect(exported.map(j => j.id)).toContain('j1');
    expect(exported.map(j => j.id)).not.toContain('j3');

    store[JT_CONFIG.storageKeys.jobs][0].title = '=HYPERLINK("https://evil.example")';
    const csvRes = await sendRequest('exportJobs', { format: 'csv', filter: { minScore: 60 } });
    expect(csvRes.result).toContain('"70"');
    expect(csvRes.result).toContain("'=HYPERLINK");
  });

  test('batchUpdateStatus 批量改状态', async () => {
    const res = await sendRequest('batchUpdateStatus', { jobIds: ['j1', 'j3'], status: 'ignored' });
    expect(res.result.changed).toBe(2);
    const jobs = store[JT_CONFIG.storageKeys.jobs];
    expect(jobs.find((j) => j.id === 'j1').status).toBe('ignored');
    expect(jobs.find((j) => j.id === 'j3').status).toBe('ignored');
  });

  test('triggerAnalyze 调用全局 analyzeJob 并透传结果', async () => {
    const res = await sendRequest('triggerAnalyze', { jobId: 'j1' });
    expect(res.result.ok).toBe(true);
    expect(res.result.analysis.fitScore).toBe(90);
  });

  test('未知 action 返回 error 含「未知 action」', async () => {
    const res = await sendRequest('frobnicate');
    expect(res.result).toBeUndefined();
    expect(res.error).toMatch(/未知 action/);
  });

  test('JSON.parse 失败的消息被静默吞掉(不回发)', async () => {
    const before = persistentWs.sent.length;
    persistentWs._receive('this is not json {{{');
    await Promise.resolve();
    expect(persistentWs.sent.length).toBe(before);
  });

  test('_reqId 缺失的消息不回发', async () => {
    const before = persistentWs.sent.length;
    persistentWs._receive(JSON.stringify({ action: 'getJobs' }));
    await Promise.resolve();
    expect(persistentWs.sent.length).toBe(before);
  });

  test('Blob 类型消息经 text() 分支解析', async () => {
    const blob = new global.Blob([JSON.stringify({ _reqId: 'req-blob', action: 'getStats' })], { type: 'application/json' });
    const before = persistentWs.sent.length;
    persistentWs._receive(blob);
    for (let i = 0; i < 30 && persistentWs.sent.length <= before; i++) await Promise.resolve();
    const res = JSON.parse(persistentWs.sent[persistentWs.sent.length - 1]);
    expect(res._reqId).toBe('req-blob');
    expect(res.result.total).toBe(3);
  });

  describe('updateAutoScan 城市名→码转换', () => {
    const SK = JT_CONFIG.storageKeys.autoScan;
    beforeEach(() => { delete store[SK]; });

    test('传中文城市名 → 存数字码, cityName 同步', async () => {
      const res = await sendRequest('updateAutoScan', { city: '北京' });
      expect(res.result.ok).toBe(true);
      expect(res.result.config.city).toBe('100010000');
      expect(res.result.config.cityName).toBe('北京');
      expect(store[SK].city).toBe('100010000');
      expect(store[SK].cityName).toBe('北京');
    });

    test('传数字城市码 → 原样保留, cityName 回填', async () => {
      const res = await sendRequest('updateAutoScan', { city: '101280100' });
      expect(res.result.config.city).toBe('101280100');
      expect(res.result.config.cityName).toBe('广州');
    });

    test('传未知城市名 → 原样保留(不静默吞)', async () => {
      const res = await sendRequest('updateAutoScan', { city: '某某未知城市' });
      expect(res.result.config.city).toBe('某某未知城市');
      expect(res.result.config.cityName).toBe('');
    });

    test('不传 city → 不动现有 city 字段', async () => {
      store[SK] = { city: '100010000', cityName: '北京', keywords: '康复' };
      const res = await sendRequest('updateAutoScan', { keywords: '推拿' });
      expect(res.result.config.city).toBe('100010000');
      expect(res.result.config.keywords).toBe('推拿');
    });

    test('传空 city → cityCode 为空字符串', async () => {
      const res = await sendRequest('updateAutoScan', { city: '' });
      expect(res.result.config.city).toBe('');
    });
  });

  test('断线(onclose 已连过)走「桥接断开」日志', () => {
    debugCalls.length = 0;
    persistentWs._fail();
    expect(debugCalls.join(' ')).toMatch(/桥接断开|重连/);
  });

  test('重连:断线后 scheduleReconnect 能重建新的 WS 连接', () => {
    const before = wsStub.instances.length;
    // 触发断开(模拟桥接进程掉线)
    persistentWs._fail();
    // 推进重连计时器(RECONNECT_DELAY_INITIAL = 5000ms,首次失败 failCount=1)
    jest.advanceTimersByTime(5000 + 200);
    // 应创建出新的 WS 实例(数量增加)
    expect(wsStub.instances.length).toBeGreaterThan(before);
    const newWs = wsStub.instances[wsStub.instances.length - 1];
    // 新连接应处于 CONNECTING(0)或 OPEN(1),而非停留在断线态
    expect([0, 1]).toContain(newWs.readyState);
    // 新连接对象必须是全新实例(证明 connect() 重建了 WS,而非复用旧的已断开对象)
    expect(newWs).not.toBe(persistentWs);
  });
});
