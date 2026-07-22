// ============================================================
// company-enrich-sim.test.js — 公司 enrichment 双向 RPC 仿真
// 建模:扩展 triggerAnalyze → 自动发 enrichCompany(WS) → server 桩回传预设 companyRisk
//       → 扩展写回 job.analysis.companyRisk。不触网,用桩 WebSocket。
// 对齐 mcp-connector-sim 的风格(单持久连接 + 测试侧注入响应)。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');
function loadSrc(rel, names = []) {
  const code = readSrc(rel);
  const expose = names.map((n) => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`).join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}
function makeChrome(store) {
  const noop = () => {};
  const local = {
    get(keys, cb) { const ks = Array.isArray(keys) ? keys : [keys]; const res = {}; ks.forEach((k) => { if (Object.prototype.hasOwnProperty.call(store, k)) res[k] = store[k]; }); cb(res); },
    set(obj, cb) { Object.keys(obj).forEach((k) => { store[k] = obj[k]; }); if (cb) cb(); },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); if (cb) cb(); }
  };
  return { storage: { local }, runtime: { onMessage: { addListener: noop }, sendMessage: noop, getURL: (p) => 'x/' + p }, tabs: { query: noop, sendMessage: noop } };
}
function makeWebSocketStub() {
  const instances = [];
  function FakeWebSocket(url) {
    this.url = url; this.readyState = 0; this.sent = [];
    this.onopen = null; this.onmessage = null; this.onclose = null;
    const self = this; instances.push(self);
    this._open = () => { self.readyState = 1; if (self.onopen) self.onopen(); };
    this._receive = (data) => { if (self.onmessage) self.onmessage({ data }); };
  }
  FakeWebSocket.OPEN = 1; FakeWebSocket.CONNECTING = 0; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  FakeWebSocket.prototype.send = function (msg) { this.sent.push(msg); };
  FakeWebSocket.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose(); };
  return { FakeWebSocket, instances };
}

const PRESET_RISK = {
  source: 'tyc-ai',
  unifiedCode: '91450100MAK4RJ3C3M',
  legalName: '示例健康科技有限公司',
  legalStatus: '存续',
  establishedAt: '2025-12-30',
  registeredCapital: '200万人民币',
  insuredCount: 6,
  industry: '科技推广和应用服务业',
  city: '南宁市',
  medicalQualified: false,
  industryMatch: 'low',
  riskLevel: 'low',
  judicialRisk: { caseCount: 0, types: [], level: 'low' }
};

describe('company enrichment 双向 RPC 仿真', () => {
  let store, wsStub, persistentWs, bridge;

  async function sendRequest(action, params = {}) {
    const _reqId = 'req-' + Math.random().toString(36).slice(2);
    persistentWs._receive(JSON.stringify({ _reqId, action, params }));
    for (let i = 0; i < 300; i++) {
      await Promise.resolve();
      const sent = persistentWs.sent.filter((s) => { try { return JSON.parse(s)._reqId === _reqId; } catch (e) { return false; } });
      if (sent.length > 0) return JSON.parse(sent[0]).result;
    }
    return null;
  }

  beforeAll(() => {
    store = {};
    wsStub = makeWebSocketStub();
    global.WebSocket = wsStub.FakeWebSocket;
    globalThis.WebSocket = wsStub.FakeWebSocket;
    global.chrome = makeChrome(store);
    global.analyzeJob = async () => ({ ok: true, analysis: { fitScore: 90, summary: 'ok' }, cached: false });

    loadSrc('lib/config.js', ['JT_CONFIG', 'JT_Utils']);
    loadSrc('lib/mcp-connector.js', []);

    store[JT_CONFIG.storageKeys.jobs] = [
      { id: 'j1', title: '康复治疗师', company: '示例健康科技有限公司', city: '南宁', status: 'unseen', analysis: {} },
    ];

    // 测试侧"server 桩":拦截扩展发出的消息
    bridge = {
      onExtMessage(raw) {
        const msg = JSON.parse(raw);
        // 1) 扩展对 enrichCompany(L 前缀)的主动请求 → 模拟天眼AI 回传预设 companyRisk
        if (msg.action === 'enrichCompany' && typeof msg._reqId === 'string' && msg._reqId.startsWith('L')) {
          Promise.resolve().then(() => {
            persistentWs._receive(JSON.stringify({ _reqId: msg._reqId, result: PRESET_RISK }));
          });
          return;
        }
        // 2) 扩展对 server 主动请求(triggerAnalyze/saveCompanyRisk 等)的"回复" → 回环给 sendRequest 轮询
        if (msg._reqId && (msg.result !== undefined || msg.error !== undefined) && !(typeof msg._reqId === 'string' && msg._reqId.startsWith('L'))) {
          Promise.resolve().then(() => {
            persistentWs._receive(JSON.stringify(msg));
          });
        }
      }
    };
    // 覆盖 send:保留原始"记录已发消息"行为(供 sendRequest 轮询),再路由给 server 桩
    wsStub.FakeWebSocket.prototype.send = function (msg) {
      this.sent.push(msg);
      bridge.onExtMessage(msg);
    };

    global.JTMcpConnector.connect();
    persistentWs = wsStub.instances[wsStub.instances.length - 1];
    persistentWs._open(); // 触发 onopen → 发送 JT_MCP_CONNECTED 握手
  });

  test('triggerAnalyze 后自动 enrich 并写回 companyRisk', async () => {
    const res = await sendRequest('triggerAnalyze', { jobId: 'j1' });
    expect(res).not.toBeNull();
    expect(res.ok).toBe(true);
    // 等待 enrich 异步写回
    for (let i = 0; i < 300; i++) await Promise.resolve();
    const jobs = store[JT_CONFIG.storageKeys.jobs];
    const job = jobs.find((j) => j.id === 'j1');
    expect(job.analysis.companyRisk).toBeDefined();
    expect(job.analysis.companyRisk.unifiedCode).toBe('91450100MAK4RJ3C3M');
    expect(job.analysis.companyRisk.industryMatch).toBe('low');
  });

  test('saveCompanyRisk 直接写回', async () => {
    const res = await sendRequest('saveCompanyRisk', { jobId: 'j1', companyRisk: PRESET_RISK });
    expect(res.ok).toBe(true);
    expect(res.hasRisk).toBe(true);
    const jobs = store[JT_CONFIG.storageKeys.jobs];
    const job = jobs.find((j) => j.id === 'j1');
    expect(job.analysis.companyRisk.legalName).toBe('示例健康科技有限公司');
  });

  test('enrichCompany 失败不阻塞主分析(降级静默)', async () => {
    // 让 server 桩回传空(模拟天眼AI 异常)
    bridge.onExtMessage = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.action === 'enrichCompany' && typeof msg._reqId === 'string' && msg._reqId.startsWith('L')) {
        Promise.resolve().then(() => persistentWs._receive(JSON.stringify({ _reqId: msg._reqId, error: '天眼AI 未配置' })));
      }
    };
    const res = await sendRequest('triggerAnalyze', { jobId: 'j1' });
    expect(res.ok).toBe(true); // 主分析仍成功
    for (let i = 0; i < 300; i++) await Promise.resolve();
    const jobs = store[JT_CONFIG.storageKeys.jobs];
    const job = jobs.find((j) => j.id === 'j1');
    // 写回可能未成功,但不抛错;companyRisk 保持上次或为空
    expect(job).toBeDefined();
  });
});
