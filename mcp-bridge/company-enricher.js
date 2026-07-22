// ============================================================
// company-enricher.js — 企业工商/风险 enrichment(天眼AI MCP)
// 在 mcp-bridge(Node 端)运行,作为 MCP client 直连天眼AI:
//   https://mcp.tianyancha.com/v1  (Streamable HTTP, Authorization 鉴权)
//
// 设计要点:
//   1. 密钥只读 .env 的 TYC_API_KEY,绝不进扩展包/git
//   2. 连上后 listTools() 动态建立"语义→真实 tool 名"映射,不硬编码猜测
//   3. enrich() 串: search(消歧取 top1) → basic(工商抽取) → risk_overview(司法判定)
//   4. 健壮降级:任一步失败 → companyRisk=null + note,不影响主分析
//
// 调用方(server.js / 扩展)只需: enricher.enrich(companyName, {city, jobIndustry})
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
// 注意:@modelcontextprotocol/sdk 在测试环境(jest)下会因 ESM 依赖报错,
// 故延迟到 init() 内动态 require,仅在真实连网时使用;单元测试用 mock client 绕开。

// —— 解析 .env(兼容无 dotenv 环境) ——
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const TYC_ENDPOINT = process.env.TYC_MCP_ENDPOINT || 'https://mcp.tianyancha.com/v1';

// 从 Markdown 表格/概览字段中抽取 "字段 | 值" 或 "字段：值"
function pick(text, field) {
  if (!text) return null;
  // 表格形式: | 字段 | 值 |
  let m = text.match(new RegExp('\\|\\s*' + field + '\\s*\\|\\s*([^\\n|`]+?)\\s*\\|', 'i'));
  if (m) return m[1].trim().replace(/^`|`$/g, '');
  // 概览字段形式: 字段 | 值 (无首尾竖线)
  m = text.match(new RegExp('\\b' + field + '\\s*\\|\\s*([^\\n|`]+?)\\s*(?=\\n|$)', 'i'));
  if (m) return m[1].trim().replace(/^`|`$/g, '');
  return null;
}

function pickDate(text, field) {
  const v = pick(text, field);
  if (!v) return null;
  const m = v.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : v.trim();
}

function pickInt(text, field) {
  const v = pick(text, field);
  if (!v) return null;
  const m = v.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// 判定是否为可聘用医疗/康复资质的机构
function inferMedicalQualified(basicText, scopeText) {
  const s = (scopeText || '') + ' ' + (basicText || '');
  // 明确非医疗 → false
  if (/非医疗|不含诊疗|不含医疗|不得从事医疗|不涉及诊疗/.test(s)) return false;
  // 含医疗资质关键词 → true
  if (/医疗|诊疗|康复医疗|中医(?:诊所|医院)|医疗机构|诊所|医院|卫生机构|护理机构/.test(s)) return true;
  return 'unknown';
}

function inferIndustryMatch(jobIndustry, basicText, scopeText) {
  const ji = (jobIndustry || '').toLowerCase();
  const s = ((scopeText || '') + ' ' + (basicText || '')).toLowerCase();
  const rehabKw = ['康复', '医疗', '卫生', '健康', '治疗', '理疗', '中医'];
  const jobIsRehab = rehabKw.some(k => ji.includes(k));
  if (!jobIsRehab) return 'unknown'; // 非康复类岗位不做行业错配判断
  // 否定词:明确非医疗(养生/健康咨询类) → 与康复治疗岗错配
  const nonMedical = /非医疗|不含诊疗|不含医疗|不得从事医疗|仅限健康咨询/.test(s);
  // 肯定词:真正具备医疗/诊疗资质。用硬词,且"诊疗"只在后接实词(服务/活动/科目)且
  // 不被"不含/非"否定时成立,避免误匹配"不含诊疗服务"中的"诊疗服务"。
  const hardMedical = /医疗机构|中医诊所|中医医院|康复医疗|护理机构|医院|诊所/.test(s);
  const realDiagnosis = /(?<!不含)(?<!非)(诊疗服务|诊疗活动|诊疗科目|开展诊疗|从事诊疗)/.test(s);
  const hasMedicalLicense = hardMedical || realDiagnosis;
  if (nonMedical && !hasMedicalLicense) return 'low'; // 养生保健,非医疗岗,错配
  if (hasMedicalLicense) return 'high';
  return 'mid';
}

function parseSearch(text) {
  // 候选表: | # | 企业名称 | 统一社会信用代码 | 登记状态 | ... | 匹配类型 |
  const rows = [];
  const re = /\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([0-9A-Z]+)\s*\|\s*([^|]+?)\s*\|/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    rows.push({
      index: parseInt(m[1], 10),
      name: m[2].trim().replace(/`/g, ''),
      unifiedCode: m[3].trim(),
      legalStatus: m[4].trim().replace(/`/g, ''),
    });
  }
  return rows;
}

class CompanyEnricher {
  constructor() {
    this.client = null;
    this.tools = [];
    this.toolMap = {};
    this._connecting = null;
    this._injectedKey = null; // 由扩展握手注入(优先级高于 .env)
  }

  // 由扩展在 WS 握手时注入 Key(使用者自填,不依赖 .env)
  // 优先级:.env 仅在未注入 key 时作为兜底
  setApiKey(key) {
    this._injectedKey = (key && key.trim()) ? key.trim() : null;
    // 切换 key 时,若已连接则断开让下次 init 用新 key 重建
    if (this._injectedKey && this.client) {
      this.client = null;
      this._connecting = null;
    }
  }

  async init() {
    if (this.client) return;
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      loadEnv();
      // 优先级:扩展注入的 key > 环境变量(.env)
      const apiKey = this._injectedKey || process.env.TYC_API_KEY;
      if (!apiKey) throw new Error('TYC_API_KEY 未配置(请在扩展「企业分析(天眼查)」卡片填入天眼AI key,或在 mcp-bridge/.env 填入)');
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const transport = new StreamableHTTPClientTransport(new URL(TYC_ENDPOINT), {
        requestInit: { headers: { Authorization: apiKey } },
      });
      const client = new Client(
        { name: 'job-tracker-company-enricher', version: '1.0.0' },
        { capabilities: {} }
      );
      await client.connect(transport);
      this.client = client;
      const list = await client.listTools();
      this.tools = list.tools || [];
      this._buildToolMap();
      console.error('[company-enricher] 天眼AI 已连接, tools: ' + this.tools.map(t => t.name).join(', '));
    })();
    return this._connecting;
  }

  // 动态语义→真实 tool 名映射(不硬编码)
  _buildToolMap() {
    const names = this.tools.map(t => t.name);
    const find = (...kw) => names.find(n => kw.every(k => n.toLowerCase().includes(k))) || null;
    this.toolMap = {
      search: find('search', 'compan') || find('search') || null,
      basic: find('basic', 'profil') || find('basic') || null,
      capabilities: find('capabilit') || null,
      callTool: find('call', 'tool') || find('call_tool') || null,
      // 注:天眼AI 原生 MCP 无 get_risk_overview 顶层工具,企业风险需经 call_tool 调内部工具
      riskInternal: 'get_risk_overview',
    };
    console.error('[company-enricher] toolMap: ' + JSON.stringify(this.toolMap));
  }

  _require(toolName) {
    if (!this.client) throw new Error('company-enricher 未初始化');
    if (!toolName) throw new Error('天眼AI 未暴露所需工具(可能账号/endpoint 不匹配)');
    return toolName;
  }

  async _call(toolName, args) {
    const res = await this.client.callTool({ name: toolName, arguments: args });
    // 兼容两种返回形态:真实 SDK 返回 { content:[{type:'text',text}] },
    // 个别桥接/桩可能直接返回 content 数组。统一规整为文本。
    const content = Array.isArray(res) ? res : (res && res.content) || [];
    const text = (Array.isArray(content) ? content : []).map(c => (c && c.text) || '').join('\n');
    return text;
  }

  // 按真实 tool 的 inputSchema 智能填参(兼容 query/keyword/name 等不同键名)
  _fillArgs(toolName, preferred) {
    const tool = this.tools.find(t => t.name === toolName);
    const props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
    const keys = Object.keys(props);
    const out = {};
    for (const [k, v] of Object.entries(preferred)) {
      // 若 tool 显式要求该 key,直接用
      if (keys.includes(k)) { out[k] = v; continue; }
      // 否则尝试映射到 schema 里语义相近的 key
      const alias = keys.find(kk => {
        const kkl = kk.toLowerCase();
        if (k === 'query' || k === 'company_name') return /(query|keyword|name|q|company)/.test(kkl);
        if (k === 'page') return kkl === 'page';
        if (k === 'page_size') return /page_?size/.test(kkl);
        return false;
      });
      if (alias) out[alias] = v;
    }
    // 补齐默认值
    if (keys.includes('page') && out.page == null) out.page = 1;
    if (keys.includes('page_size') && out.page_size == null) out.page_size = 10;
    return out;
  }

  async searchCompany(name) {
    const tn = this._require(this.toolMap.search);
    const args = this._fillArgs(tn, { query: name, page: 1, page_size: 10 });
    const text = await this._call(tn, args);
    return parseSearch(text);
  }

  async getBasic(name) {
    const tn = this._require(this.toolMap.basic);
    const args = this._fillArgs(tn, { company_name: name });
    return this._call(tn, args);
  }

  async getRiskOverview(name) {
    if (!this.toolMap.callTool) return null; // 无 call_tool 时跳过
    try {
      const args = this._fillArgs(this.toolMap.callTool, {
        company_name: name,
        tool_name: this.toolMap.riskInternal,
        arguments: { page: 1, page_size: 20 },
      });
      return await this._call(this.toolMap.callTool, args);
    } catch (e) {
      return null; // 风险查询失败不阻塞主流程
    }
  }

  // 主入口:返回标准化 companyRisk(失败返回 {fetchedAt, source, riskLevel:'unknown', note})
  async enrich(companyName, opts = {}) {
    const fetchedAt = new Date().toISOString();
    const base = { fetchedAt, source: 'tyc-ai' };
    try {
      await this.init();
      if (!companyName || !companyName.trim()) {
        return { ...base, riskLevel: 'unknown', note: '未提供公司名' };
      }
      // 1) 搜索消歧
      const candidates = await this.searchCompany(companyName.trim());
      if (!candidates.length) {
        return { ...base, riskLevel: 'unknown', note: '天眼AI 未找到匹配企业: ' + companyName };
      }
      // 优先匹配类型/城市命中的候选
      let top = candidates[0];
      if (opts.city) {
        const cityHit = candidates.find(c => c.name.includes(opts.city) || (c.city && c.city.includes(opts.city)));
        if (cityHit) top = cityHit;
      }
      const legalName = top.name;

      // 2) 基础工商
      const basicText = await this.getBasic(legalName);
      const scopeText = pick(basicText, '经营范围') || '';
      const riskLevel = (() => {
        const ls = (pick(basicText, '登记状态') || '').trim();
        if (/注销|吊销|清算/.test(ls)) return 'high';
        if (/存续|在业|正常/.test(ls)) return 'low';
        return 'unknown';
      })();

      const companyRisk = {
        ...base,
        unifiedCode: top.unifiedCode || pick(basicText, '统一社会信用代码'),
        legalName,
        legalStatus: pick(basicText, '登记状态'),
        establishedAt: pickDate(basicText, '成立日期'),
        registeredCapital: pick(basicText, '注册资本'),
        insuredCount: pickInt(basicText, '参保人数'),
        industry: pick(basicText, '行业'),
        city: pick(basicText, '城市') || opts.city || null,
        medicalQualified: inferMedicalQualified(basicText, scopeText),
        industryMatch: inferIndustryMatch(opts.jobIndustry, basicText, scopeText),
        riskLevel,
        note: '',
      };

      // 3) 司法风险(查不到记录即视为 low)
      const riskText = await this.getRiskOverview(legalName);
      if (riskText && /空结果|未发现风险|未查询到风险/.test(riskText)) {
        companyRisk.judicialRisk = { caseCount: 0, types: [], level: 'low' };
      } else if (riskText) {
        companyRisk.judicialRisk = {
          caseCount: null,
          types: [],
          level: 'mid',
          note: '存在风险记录,建议人工复核',
        };
      } else {
        companyRisk.judicialRisk = { caseCount: 0, types: [], level: 'low' };
      }

      return companyRisk;
    } catch (e) {
      return { ...base, riskLevel: 'unknown', note: 'enrich 失败: ' + e.message };
    }
  }
}

module.exports = { CompanyEnricher, inferMedicalQualified, inferIndustryMatch, parseSearch, pick };
