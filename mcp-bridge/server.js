#!/usr/bin/env node
// ============================================================
// server.js — Job Tracker MCP Server (stdio 传输)
// 每个 AI 助手通过 stdio 启动各自的 server 进程,连接扩展的 WS 端口 8765
// 数据一致性由 chrome.storage.local 保证
//
// 架构(单进程连接扩展的 8765 端口):
//   AI 助手 <--MCP(stdio)--> server.js[WS :8765] <--WS--> Chrome 扩展
//   (注:8766 已废弃,不再使用;多个 AI 助手复用同一 8765,同时只运行一个桥接进程)
//
// 启动方式:
//   node server.js                  (默认 WS 端口 8765)
//   node server.js --ws-port=XXXX   (仅供高级自定义;标准端口为 8765)
// ============================================================

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { ExtBridge } = require('./ext-bridge');

// 从命令行参数读取 WS 端口(默认 8765)
const wsPortArg = process.argv.find(a => a.startsWith('--ws-port='));
const WS_PORT = wsPortArg ? parseInt(wsPortArg.split('=')[1], 10) : 8765;

// 创建扩展通信桥接(WS,给扩展连)
const bridge = new ExtBridge(WS_PORT);

// 创建 MCP Server
const server = new Server(
  { name: 'job-tracker', version: '1.1.0' },
  { capabilities: { resources: {}, tools: {} } }
);

// ----------------------------------------------------------
// Resources(只读数据)
// ----------------------------------------------------------
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      { uri: 'jobs://list', name: '全部岗位列表', description: '岗位猎手中记录的所有岗位(含 AI 分析结果、状态、匹配分)', mimeType: 'application/json' },
      { uri: 'jobs://stats', name: '岗位统计', description: '岗位总数、匹配数、各状态数量统计', mimeType: 'application/json' },
      { uri: 'config://filters', name: '筛选条件', description: '当前生效的关键词/城市/薪资/排除项等筛选配置', mimeType: 'application/json' },
      { uri: 'config://autoscan', name: '自动扫描配置', description: '自动扫描的开关、关键词、城市、间隔、日上限等', mimeType: 'application/json' },
      { uri: 'profile://resume', name: '简历档案', description: '用户的简历档案(求职意向、技能、经验等)', mimeType: 'application/json' },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  try {
    let data;
    switch (uri) {
      case 'jobs://list': data = await bridge.getJobs(); break;
      case 'jobs://stats': data = await bridge.getStats(); break;
      case 'config://filters': data = await bridge.getFilters(); break;
      case 'config://autoscan': data = await bridge.getAutoScan(); break;
      case 'profile://resume': data = await bridge.request('getProfile'); break;
      default: throw new Error('未知 resource: ' + uri);
    }
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    throw new Error('读取 ' + uri + ' 失败: ' + e.message);
  }
});

// ----------------------------------------------------------
// Tools(可执行操作)
// ----------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: 'search_jobs', description: '搜索/筛选岗位。可按关键词(标题/公司)、城市、状态、最低分筛选,按分数/时间/薪资排序', inputSchema: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键词(匹配标题或公司名)' }, city: { type: 'string', description: '城市筛选' }, status: { type: 'string', enum: ['unseen', 'interested', 'applied', 'interview', 'rejected', 'offer'], description: '状态筛选' }, minScore: { type: 'number', description: '最低匹配分(0-100)' }, sortBy: { type: 'string', enum: ['score', 'capturedAt', 'salaryMax', 'title'], description: '排序方式,默认 score' }, limit: { type: 'number', description: '返回数量上限,默认 50' } } } },
      { name: 'get_job_detail', description: '获取单个岗位的完整详情(含 AI 分析全文、匹配理由、避坑提示、笔记等)', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '岗位 ID' } }, required: ['jobId'] } },
      { name: 'update_status', description: '更新岗位状态(如标记为已投递、面试中、录用等)', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '岗位 ID' }, status: { type: 'string', enum: ['unseen', 'interested', 'applied', 'interview', 'rejected', 'offer'], description: '新状态' } }, required: ['jobId', 'status'] } },
      { name: 'export_jobs', description: '导出岗位数据为 CSV 或 JSON 格式,返回内容文本', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['csv', 'json'], description: '导出格式,默认 json' }, filter: { type: 'object', properties: { keyword: { type: 'string' }, status: { type: 'string' }, minScore: { type: 'number' } }, description: '可选筛选条件' } } } },
      { name: 'delete_job', description: '删除单个岗位', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '岗位 ID' } }, required: ['jobId'] } },
      { name: 'delete_jobs', description: '批量删除岗位', inputSchema: { type: 'object', properties: { jobIds: { type: 'array', items: { type: 'string' }, description: '岗位 ID 列表' } }, required: ['jobIds'] } },
      { name: 'update_notes', description: '更新岗位的笔记内容', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '岗位 ID' }, notes: { type: 'string', description: '笔记内容' } }, required: ['jobId', 'notes'] } },
      { name: 'batch_update_status', description: '批量更新岗位状态(如把所有 80 分以上的标记为感兴趣)', inputSchema: { type: 'object', properties: { jobIds: { type: 'array', items: { type: 'string' }, description: '岗位 ID 列表' }, status: { type: 'string', enum: ['unseen', 'interested', 'applied', 'interview', 'rejected', 'offer'], description: '新状态' } }, required: ['jobIds', 'status'] } },
      { name: 'analyze_job', description: '对指定岗位触发通用 AI 分析：评估与求职者的关系程度、可迁移能力、准入门槛、投递建议和独立岗位风险。force=true 时跳过缓存强制重新分析', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '岗位 ID' }, force: { type: 'boolean', description: '是否强制重新分析(跳过缓存),默认 false' } }, required: ['jobId'] } },
      { name: 'batch_analyze', description: '批量运行通用岗位分析(或 force=true 时强制刷新所有)，结果包含关系程度与独立风险结论。串行执行，默认上限 5 个', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '本次最多分析数量,默认 5,上限 10' }, force: { type: 'boolean', description: '是否强制重新分析所有岗位(跳过缓存),默认 false' } } } },
      { name: 'run_autoscan', description: '立即触发一轮自动扫描(唤醒前端执行扫描)', inputSchema: { type: 'object', properties: {} } },
      { name: 'get_autoscan_status', description: '查询自动扫描的当前状态(是否在运行、今日已扫描数、剩余配额等)', inputSchema: { type: 'object', properties: {} } },
      { name: 'update_autoscan', description: '修改自动扫描配置(只改传入的字段)。可改: keywords(搜索关键词,空格分隔如"运营 行政 客服"), city(城市名如"南宁"), maxJobsPerRun(本轮实际新增上限,达到后会继续翻页直到找够或没有更多新岗位), autoAnalyze(是否自动分析), analyzePerDay(每日分析上限), enrichDetails(是否补全详情)', inputSchema: { type: 'object', properties: { keywords: { type: 'string', description: '搜索关键词,多个用空格分隔(如"运营 行政 客服")' }, city: { type: 'string', description: '城市名(如"南宁")或城市码' }, maxJobsPerRun: { type: 'number', description: '本轮实际最多新增几个岗位(不是查看几张卡片,重复的不算)。达到后会继续翻页/切换关键词直到找够或没更多结果' }, autoAnalyze: { type: 'boolean', description: '采集后是否自动跑 AI 分析' }, analyzePerDay: { type: 'number', description: '每日 AI 分析上限,0=不限' }, enrichDetails: { type: 'boolean', description: '是否打开详情页补全信息' } } } },
      { name: 'generate_reply', description: '根据 HR 消息生成回复(调用扩展的 LLM)。返回多个版本供选择', inputSchema: { type: 'object', properties: { hrMessage: { type: 'string', description: 'HR 发来的消息内容' }, intent: { type: 'string', enum: ['interested', 'polite_decline', 'negotiate', 'ask_more_info'], description: '回复意图,默认 interested' }, style: { type: 'string', enum: ['professional', 'enthusiastic', 'concise'], description: '回复风格,默认 professional' }, context: { type: 'object', properties: { jobTitle: { type: 'string', description: '岗位标题(提供更精准的回复)' } }, description: '可选上下文' } }, required: ['hrMessage'] } },
      { name: 'get_chat_context', description: '获取当前 BOSS 聊天页的聊天上下文(HR 消息历史、岗位标题等)。需要用户当前在 BOSS 聊天页且已选中对话', inputSchema: { type: 'object', properties: { maxMessages: { type: 'number', description: '最多返回多少条消息,默认 20' } } } },
      { name: 'get_chat_debug', description: '获取 BOSS 聊天页的 DOM 调试信息(输入框/消息列表检测结果、候选元素等)。用于选择器调整和故障排查', inputSchema: { type: 'object', properties: {} } },
      { name: 'smart_reply', description: '半自动智能回复:综合岗位信息+简历+求职意向+聊天历史,调用 LLM 生成回复。需要用户当前在 BOSS 聊天页', inputSchema: { type: 'object', properties: { maxMessages: { type: 'number', description: '最多读取多少条聊天历史,默认 20' } } } },
      { name: 'enrich_company', description: '对指定岗位的公司做工商/风险 enrichment(直连天眼AI):存续状态、注册资本、成立日期、参保人数、行业匹配、医疗资质、司法风险。结果写回岗位的 analysis.companyRisk。返回 companyRisk 与缓存状态', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '岗位 ID' }, force: { type: 'boolean', description: '是否强制重新查询(跳过缓存),默认 false' } }, required: ['jobId'] } },
      { name: 'get_company_info', description: '读取指定岗位已缓存的公司风险(analysis.companyRisk),不触发新查询', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '岗位 ID' } }, required: ['jobId'] } },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case 'search_jobs': result = await bridge.searchJobs(args || {}); break;
      case 'get_job_detail':
        if (!args.jobId) throw new Error('需要 jobId 参数');
        result = await bridge.request('getJobDetail', args); break;
      case 'update_status':
        if (!args.jobId || !args.status) throw new Error('需要 jobId 和 status 参数');
        result = await bridge.updateStatus(args); break;
      case 'export_jobs': result = await bridge.exportJobs(args || {}); break;
      case 'delete_job':
        if (!args.jobId) throw new Error('需要 jobId 参数');
        result = await bridge.request('deleteJob', args); break;
      case 'delete_jobs':
        if (!args.jobIds) throw new Error('需要 jobIds 参数');
        result = await bridge.request('deleteJobs', args); break;
      case 'update_notes':
        if (!args.jobId) throw new Error('需要 jobId 参数');
        result = await bridge.request('updateNotes', args); break;
      case 'batch_update_status':
        if (!args.jobIds || !args.status) throw new Error('需要 jobIds 和 status 参数');
        result = await bridge.request('batchUpdateStatus', args); break;
      case 'analyze_job':
        if (!args.jobId) throw new Error('需要 jobId 参数');
        result = await bridge.request('triggerAnalyze', args); break;
      case 'batch_analyze': result = await bridge.request('batchAnalyze', args || {}); break;
      case 'run_autoscan': result = await bridge.request('runAutoScan', {}); break;
      case 'get_autoscan_status': result = await bridge.request('getAutoScanStatus', {}); break;
      case 'update_autoscan': result = await bridge.request('updateAutoScan', args || {}); break;
      case 'generate_reply':
        if (!args.hrMessage) throw new Error('需要 hrMessage 参数');
        result = await bridge.request('generateReply', args); break;
      case 'get_chat_context': result = await bridge.request('chatGetContext', args || {}); break;
      case 'get_chat_debug': result = await bridge.request('chatGetDebug', {}); break;
      case 'smart_reply': result = await bridge.request('chatSmartReply', args || {}); break;
      case 'enrich_company': {
        if (!args.jobId) throw new Error('需要 jobId 参数');
        const job = await bridge.request('getJobDetail', { jobId: args.jobId });
        if (!job) throw new Error('岗位不存在: ' + args.jobId);
        // 缓存:已有 companyRisk 且非 force → 直接返回
        if (!args.force && job.analysis && job.analysis.companyRisk && job.analysis.companyRisk.unifiedCode) {
          result = { ok: true, jobId: args.jobId, companyRisk: job.analysis.companyRisk, cached: true };
          break;
        }
        const companyName = job.company || job.title;
        const city = job.city || '';
        const jobIndustry = /康复|医疗|治疗|理疗|中医/.test(job.title || '') ? job.title : '';
        const companyRisk = await bridge.enrichCompany({ companyName, city, jobIndustry });
        await bridge.request('saveCompanyRisk', { jobId: args.jobId, companyRisk });
        result = { ok: true, jobId: args.jobId, companyRisk, cached: false };
        break;
      }
      case 'get_company_info': {
        if (!args.jobId) throw new Error('需要 jobId 参数');
        const job = await bridge.request('getJobDetail', { jobId: args.jobId });
        result = { jobId: args.jobId, companyRisk: (job && job.analysis && job.analysis.companyRisk) || null };
        break;
      }
      default: throw new Error('未知 tool: ' + name);
    }
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: '错误: ' + e.message }], isError: true };
  }
});

// ----------------------------------------------------------
// 启动(stdio 传输)
// ----------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[job-tracker-mcp] MCP server 已启动(WS 端口 ' + WS_PORT + '),等待扩展连接...');
}

main().catch(e => {
  console.error('[job-tracker-mcp] 启动失败:', e);
  process.exit(1);
});
