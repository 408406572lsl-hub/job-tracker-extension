// ============================================================
// company-enricher.test.js — 企业 enrichment 单元测试
// 用 mock MCP client 模拟天眼AI,不触网;覆盖字段抽取、消歧、降级、行业匹配。
// ============================================================
'use strict';

const { CompanyEnricher, inferMedicalQualified, inferIndustryMatch, parseSearch, pick } = require('../mcp-bridge/company-enricher.js');

// 构造一个能返回预设 Markdown 的 mock client
function makeEnricher(searchText, basicText, riskText) {
  const e = new CompanyEnricher();
  // 注入 mock client(绕过真实网络 init)
  e.client = {
    listTools: async () => ({
      tools: [
        { name: 'search_companies', inputSchema: { properties: { query: {}, page: {}, page_size: {} } } },
        { name: 'get_company_basic_profile', inputSchema: { properties: { company_name: {} } } },
        { name: 'call_tool', inputSchema: { properties: { company_name: {}, tool_name: {}, arguments: {} } } },
        { name: 'get_company_capabilities', inputSchema: { properties: {} } },
      ],
    }),
    callTool: async ({ name, arguments: args }) => {
      // 与真实 MCP SDK 一致:返回 { content:[{type:'text', text}] }
      if (name === 'search_companies') return { content: [{ type: 'text', text: searchText }] };
      if (name === 'get_company_basic_profile') return { content: [{ type: 'text', text: basicText }] };
      if (name === 'call_tool' && args.tool_name === 'get_risk_overview') {
        return { content: [{ type: 'text', text: riskText || '空结果：未发现风险总览记录' }] };
      }
      return { content: [{ type: 'text', text: '' }] };
    },
  };
  // 手动建立 toolMap(跳过 listTools 网络)
  e.tools = [
    { name: 'search_companies', inputSchema: { properties: { query: {}, page: {}, page_size: {} } } },
    { name: 'get_company_basic_profile', inputSchema: { properties: { company_name: {} } } },
    { name: 'call_tool', inputSchema: { properties: { company_name: {}, tool_name: {}, arguments: {} } } },
  ];
  e._buildToolMap();
  return e;
}

const SEARCH = `| # | 企业名称 | 统一社会信用代码 | 登记状态 |
| 1 | 示例健康科技有限公司 | 91450100MAK4RJ3C3M | 存续 |
| 2 | 元气空间（北京）科技有限公司 | 91110000MAA1B2C3D4 | 注销 |`;

const BASIC = `| 统一社会信用代码 | 91450100MAK4RJ3C3M |
| 登记状态 | 存续 |
| 法定代表人 | 莫妮 |
| 注册资本 | 200万人民币 |
| 成立日期 | 2025-12-30 00:00:00.0 |
| 行业 | 科技推广和应用服务业 |
| 参保人数 | 6 |
| 城市 | 南宁市 |
| 经营范围 | 一般项目：数字技术服务;养生保健服务（非医疗）;健康咨询服务（不含诊疗服务）;远程健康管理服务 |`;

describe('company-enricher 字段抽取', () => {
  test('pick 从表格抽字段', () => {
    expect(pick(BASIC, '统一社会信用代码')).toBe('91450100MAK4RJ3C3M');
    expect(pick(BASIC, '登记状态')).toBe('存续');
    expect(pick(BASIC, '参保人数')).toBe('6');
  });

  test('parseSearch 抽候选(含统一信用代码/状态)', () => {
    const rows = parseSearch(SEARCH);
    expect(rows.length).toBe(2);
    expect(rows[0].unifiedCode).toBe('91450100MAK4RJ3C3M');
    expect(rows[0].legalStatus).toBe('存续');
    expect(rows[1].legalStatus).toBe('注销');
  });
});

describe('company-enricher enrich 主流程', () => {
  test('正常返回 companyRisk(非医疗养生→行业错配 low)', async () => {
    const e = makeEnricher(SEARCH, BASIC, '空结果：未发现风险总览记录');
    const r = await e.enrich('示例健康科技有限公司', { city: '南宁', jobIndustry: '康复治疗技术' });
    expect(r.source).toBe('tyc-ai');
    expect(r.unifiedCode).toBe('91450100MAK4RJ3C3M');
    expect(r.legalStatus).toBe('存续');
    expect(r.insuredCount).toBe(6);
    expect(r.medicalQualified).toBe(false);
    expect(r.industryMatch).toBe('low');
    expect(r.riskLevel).toBe('low');
    expect(r.judicialRisk.level).toBe('low');
  });

  test('城市命中优先选候选', async () => {
    const e = makeEnricher(SEARCH, BASIC, '空结果');
    const r = await e.enrich('元气空间', { city: '南宁' });
    expect(r.legalName).toBe('示例健康科技有限公司'); // 南宁命中,非北京
  });

  test('查不到企业 → unknown + note', async () => {
    const e = makeEnricher('未找到匹配企业', BASIC, '空结果');
    const r = await e.enrich('不存在的公司XYZ', {});
    expect(r.riskLevel).toBe('unknown');
    expect(r.unifiedCode).toBeUndefined();
    expect(r.note).toMatch(/未找到/);
  });

  test('空公司名 → 早退', async () => {
    const e = makeEnricher(SEARCH, BASIC, '空结果');
    const r = await e.enrich('', {});
    expect(r.riskLevel).toBe('unknown');
    expect(r.note).toMatch(/未提供/);
  });
});

describe('inferMedicalQualified', () => {
  test('明确非医疗 → false', () => {
    expect(inferMedicalQualified('', '养生保健服务（非医疗）;健康咨询（不含诊疗）')).toBe(false);
  });
  test('含诊所/医院 → true', () => {
    expect(inferMedicalQualified('', '康复医疗服务;中医诊所;诊疗服务')).toBe(true);
  });
  test('无关行业 → unknown', () => {
    expect(inferMedicalQualified('', '软件开发;技术服务')).toBe('unknown');
  });
});

describe('inferIndustryMatch', () => {
  const basic = '行业 | 科技推广和应用服务业\n经营范围 | 养生保健服务（非医疗）;健康咨询（不含诊疗服务）';
  test('康复岗 + 非医疗养生 → low(错配)', () => {
    expect(inferIndustryMatch('康复治疗技术', basic, '养生保健服务（非医疗）')).toBe('low');
  });
  test('康复岗 + 真医疗 → high', () => {
    const med = '经营范围 | 康复医疗服务（凭许可证）;中医诊所;诊疗服务';
    expect(inferIndustryMatch('康复治疗技术', med, med)).toBe('high');
  });
  test('非康复岗 → unknown(不判错配)', () => {
    expect(inferIndustryMatch('运营专员', basic, '养生保健服务（非医疗）')).toBe('unknown');
  });
  test('否定词"不含诊疗服务"不被误判为医疗', () => {
    const s = '健康咨询服务（不含诊疗服务）';
    expect(inferIndustryMatch('康复治疗技术', s, s)).toBe('low');
  });
});
