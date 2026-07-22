// 全链路集成测试:用 StdioClientTransport 启 server.js(MCP + WS 8765),
// 模拟扩展 WS 客户端回应 getJobDetail / saveCompanyRisk,再调 enrich_company tool。
'use strict';
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');

const BRIDGE = path.join(__dirname, '..', '..'); // job-tracker-extension 根

function startFakeExtension() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:8799');
    const jobs = [{ id: 'job-test-1', title: '康复治疗师', company: '示例健康科技有限公司', city: '南宁', analysis: {} }];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'JT_MCP_CONNECTED' }));
      setTimeout(() => resolve(ws), 400);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg._reqId && msg.action) {
        let result;
        if (msg.action === 'getJobDetail') result = jobs.find(j => j.id === msg.params.jobId) || null;
        else if (msg.action === 'saveCompanyRisk') {
          const j = jobs.find(x => x.id === msg.params.jobId);
          if (j) { j.analysis = j.analysis || {}; j.analysis.companyRisk = msg.params.companyRisk; }
          result = { ok: true, saved: !!j };
        } else result = { ok: false };
        ws.send(JSON.stringify({ _reqId: msg._reqId, result }));
      }
    });
    ws.on('error', reject);
  });
}

(async () => {
  const transport = new StdioClientTransport({ command: 'node', args: ['mcp-bridge/server.js', '--ws-port=8799'], cwd: BRIDGE, env: process.env });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('[test] MCP client 已连 server');
  await new Promise(r => setTimeout(r, 1200)); // 等 WS 8765 起

  const ws = await startFakeExtension();
  console.log('[test] 模拟扩展已连 WS 8765');

  console.log('[test] 调用 enrich_company...');
  const res = await client.callTool({ name: 'enrich_company', arguments: { jobId: 'job-test-1' } });
  console.log('=== RAW RES ===');
  console.log(JSON.stringify(res, null, 2));
  const text = (res.content || []).map(c => c.text || '').join('\n');
  console.log('=== enrich_company 文本结果 ===\n' + text);

  const parsed = JSON.parse(text);
  console.log('\n[test] cached:', parsed.cached, '| riskLevel:', parsed.companyRisk && parsed.companyRisk.riskLevel, '| unifiedCode:', parsed.companyRisk && parsed.companyRisk.unifiedCode, '| industryMatch:', parsed.companyRisk && parsed.companyRisk.industryMatch);

  await client.close();
  ws.close();
  process.exit(0);
})().catch(e => { console.error('TEST ERR', e); process.exit(1); });
