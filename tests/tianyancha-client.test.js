// ============================================================
// tianyancha-client.test.js — 浏览器端直连客户端单元测试
// 通过 mock fetch + chrome.storage 验证 MCP StreamableHTTP 流程与字段解析
// ============================================================

'use strict';

// 确保 self/global 存在,且暴露 JTTyc
if (typeof global.self === 'undefined') global.self = global;

// —— mock chrome.storage ——
function installChrome(keyValue) {
  global.chrome = {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach(k => { out[k] = keyValue; });
          cb(out);
        },
        set: (obj, cb) => { cb && cb(); },
      },
    },
  };
}

// —— mock fetch:基于请求体分支返回 MCP JSON-RPC 响应 ——
function buildFetch(opts) {
  opts = opts || {};
  const sessionId = 'test-session-123';
  return async (url, request) => {
    const body = JSON.parse(request.body);
    let payload;
    let contentType = 'application/json';
    let withSession = false;
    if (body.method === 'initialize') {
      payload = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'tyc' } } };
      withSession = true;
    } else if (body.method === 'notifications/initialized') {
      // 通知:客户端发完即丢弃响应(_post 在 fetch 后立刻 return null),这里返回空响应即可
      payload = { jsonrpc: '2.0', id: body.id, result: {} };
    } else if (body.method === 'tools/list') {
      payload = { jsonrpc: '2.0', id: body.id, result: { tools: [
        { name: 'search_companies', inputSchema: { properties: { query: {}, page: {}, page_size: {} } } },
        { name: 'get_company_basic_profile', inputSchema: { properties: { company_name: {} } } },
        { name: 'call_tool', inputSchema: { properties: { company_name: {}, tool_name: {}, arguments: {} } } },
      ] } };
    } else if (body.method === 'tools/call') {
      const name = body.params.name;
      if (name === 'search_companies') {
        payload = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text:
          '| # | 企业名称 | 统一社会信用代码 | 登记状态 |\n| 1 | 示例健康科技有限公司 | 91450100MAK4RJ3C3M | 存续 |' }] } };
      } else if (name === 'get_company_basic_profile') {
        payload = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text:
          '| 登记状态 | 存续 |\n| 注册资本 | 200万人民币 |\n| 成立日期 | 2021-03-15 |\n| 参保人数 | 6 |\n| 行业 | 商务服务业 |\n| 经营范围 | 健康咨询服务(不含诊疗);养生保健服务 |' }] } };
      } else if (name === 'call_tool') {
        // get_risk_overview → 空结果(无司法风险)
        payload = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '空结果:未发现风险记录' }] } };
      } else {
        payload = { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown tool ' + name } };
      }
    } else {
      payload = { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown method ' + body.method } };
    }

    if (opts.sse) {
      // SSE 模式:把单个 JSON-RPC 响应包成 data: 事件,通过可读流逐块下发
      contentType = 'text/event-stream';
      const sseText = 'data: ' + JSON.stringify(payload) + '\n\n';
      const bytes = new TextEncoder().encode(sseText);
      let sent = false;
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: {
          get: (h) => {
            if (h === 'content-type') return contentType;
            if (h === 'mcp-session-id') return sessionId;
            return null;
          },
        },
        body: {
          getReader: () => {
            let localSent = false;
            return {
              read: async () => {
                if (!localSent) { localSent = true; return { done: false, value: bytes }; }
                return { done: true, value: undefined };
              },
            };
          },
        },
        json: async () => payload,
        text: async () => sseText,
      };
    }

    return {
      ok: true, status: 200, statusText: 'OK',
      headers: {
        get: (h) => {
          if (h === 'content-type') return contentType;
          if (h === 'mcp-session-id') return withSession ? sessionId : null;
          return null;
        },
      },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      body: (() => {
        const bytes = new Uint8Array(0);
        return { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) };
      })(),
    };
  };
}

describe('TianyanchaClient 直连流程', () => {
  beforeEach(() => {
    installChrome('test-key-xyz');
    delete global.JTTyc;
    jest.resetModules();
    // 彻底清除模块缓存,避免上一个测试的 MCP 会话单例泄漏到本次
    try { delete require.cache[require.resolve('../lib/tianyancha-client.js')]; } catch (e) {}
  });

  test('enrich 成功返回标准化 companyRisk(JSON 响应)', async () => {
    globalThis.fetch = buildFetch({});
    require('../lib/tianyancha-client.js');
    const JTTyc = global.JTTyc;
    expect(JTTyc).toBeDefined();

    const r = await JTTyc.enrich('示例健康科技有限公司', { city: '南宁', jobIndustry: '康复治疗' });
    expect(r.skipped).toBeFalsy();
    expect(r.unifiedCode).toBe('91450100MAK4RJ3C3M');
    expect(r.legalStatus).toBe('存续');
    expect(r.registeredCapital).toBe('200万人民币');
    expect(r.insuredCount).toBe(6);
    expect(r.riskLevel).toBe('low');
    expect(r.source).toBe('tyc-ai-direct');
    expect(r.judicialRisk && r.judicialRisk.level).toBe('low');
  });

  test('无 Key → 返回 skipped:no-key', async () => {
    installChrome(''); // 清空 key
    globalThis.fetch = buildFetch({});
    require('../lib/tianyancha-client.js');
    const r = await global.JTTyc.enrich('某公司');
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no-key');
  });

  test('JSON-RPC 错误 → enrich 降级返回 unknown + note(不抛)', async () => {
    globalThis.fetch = async (url, request) => {
      const body = JSON.parse(request.body);
      const payload = { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'boom' } };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload, text: async () => '', body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
    };
    require('../lib/tianyancha-client.js');
    const r = await global.JTTyc.enrich('某公司');
    expect(r.skipped).toBeFalsy();
    expect(r.riskLevel).toBe('unknown');
    expect(String(r.note)).toMatch(/enrich 失败/);
  });

  test('SSE 响应也能解析(enrich 成功)', async () => {
    globalThis.fetch = buildFetch({ sse: true });
    require('../lib/tianyancha-client.js');
    const r = await global.JTTyc.enrich('示例健康科技有限公司', { city: '南宁' });
    expect(r.unifiedCode).toBe('91450100MAK4RJ3C3M');
  });

  test('未找到匹配企业 → 返回 found:false 语义(note)', async () => {
    globalThis.fetch = (url, request) => {
      const body = JSON.parse(request.body);
      let payload;
      if (body.method === 'initialize') payload = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {} } };
      else if (body.method === 'tools/list') payload = { jsonrpc: '2.0', id: body.id, result: { tools: [
        { name: 'search_companies', inputSchema: { properties: { query: {} } } },
        { name: 'get_company_basic_profile', inputSchema: { properties: { company_name: {} } } },
        { name: 'call_tool', inputSchema: { properties: {} } },
      ] } };
      else if (body.method === 'tools/call' && body.params.name === 'search_companies') {
        payload = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '未找到相关企业' }] } };
      } else payload = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '' }] } };
      return { ok: true, status: 200, headers: { get: (h) => h === 'content-type' ? 'application/json' : (h === 'mcp-session-id' ? 's' : null) }, json: async () => payload, text: async () => '', body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
    };
    require('../lib/tianyancha-client.js');
    const r = await global.JTTyc.enrich('不存在的鬼公司XYZ');
    expect(r.skipped).toBeFalsy();
    expect(r.unifiedCode).toBeUndefined();
    expect(String(r.note)).toMatch(/未找到匹配企业/);
  });
});
