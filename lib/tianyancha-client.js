// ============================================================
// tianyancha-client.js — 浏览器端直连天眼查(企业工商/风险 enrichment)
// 在 Chrome 扩展 background Service Worker / 设置页中运行。
//
// 设计目标(方案 A):让扩展脱离 mcp-bridge 也能查天眼查,
//   彻底解除"天眼查可用"对 8765 端口(bridge 进程)的依赖。
//   - Key 来源:扩展设置页填写后存 chrome.storage.local(jt_tyc_api_key),不进包、不进 git
//   - 协议:MCP StreamableHTTP(POST JSON-RPC,Authorization 鉴权,支持 JSON / SSE 响应)
//   - 复用:enrich() 的字段解析与 company-enricher.js(Node 端)保持逐行一致,结果格式统一
//
// 降级:无 key → { skipped:true, reason:'no-key' };网络/鉴权失败 → { skipped:true, reason:'error' }
//   调用方(fetchCompanyRiskForJob)据此决定回退桥接或降级为仅岗位分析。
// ============================================================

(function () {
  'use strict';

  const TYC_ENDPOINT = 'https://mcp.tianyancha.com/v1';
  // 对齐 @modelcontextprotocol/sdk 客户端默认协议版本(实测可连天眼查)
  const PROTOCOL_VERSION = '2025-11-25';

  // —— 文本抽取工具(与 mcp-bridge/company-enricher.js 一致) ——
  function pick(text, field) {
    if (!text) return null;
    let m = text.match(new RegExp('\\|\\s*' + field + '\\s*\\|\\s*([^\\n|`]+?)\\s*\\|', 'i'));
    if (m) return m[1].trim().replace(/^`|`$/g, '');
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
  function inferMedicalQualified(basicText, scopeText) {
    const s = (scopeText || '') + ' ' + (basicText || '');
    if (/非医疗|不含诊疗|不含医疗|不得从事医疗|不涉及诊疗/.test(s)) return false;
    if (/医疗|诊疗|康复医疗|中医(?:诊所|医院)|医疗机构|诊所|医院|卫生机构|护理机构/.test(s)) return true;
    return 'unknown';
  }
  function inferIndustryMatch(jobIndustry, basicText, scopeText) {
    const ji = (jobIndustry || '').toLowerCase();
    const s = ((scopeText || '') + ' ' + (basicText || '')).toLowerCase();
    const rehabKw = ['康复', '医疗', '卫生', '健康', '治疗', '理疗', '中医'];
    const jobIsRehab = rehabKw.some(k => ji.includes(k));
    if (!jobIsRehab) return 'unknown';
    const nonMedical = /非医疗|不含诊疗|不含医疗|不得从事医疗|仅限健康咨询/.test(s);
    const hardMedical = /医疗机构|中医诊所|中医医院|康复医疗|护理机构|医院|诊所/.test(s);
    const realDiagnosis = /(?<!不含)(?<!非)(诊疗服务|诊疗活动|诊疗科目|开展诊疗|从事诊疗)/.test(s);
    const hasMedicalLicense = hardMedical || realDiagnosis;
    if (nonMedical && !hasMedicalLicense) return 'low';
    if (hasMedicalLicense) return 'high';
    return 'mid';
  }
  function parseSearch(text) {
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

  // —— SSE 响应解析(StreamableHTTP 可能返回 text/event-stream) ——
  // SSE 帧格式:`event: xxx\ndata: <json>\n\n`,行以 \n 分隔,空行表示一个事件结束。
  // 关键点:data: 行本身是有效载荷,必须在读到该行时立即解析,不能依赖 flush(buf)。
  async function readSSE(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const out = [];
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return; // 仅处理 data 行;event:/id:/其它忽略
      const data = line.slice(5).trim();
      if (data) { try { out.push(JSON.parse(data)); } catch (e) { /* 忽略非 JSON 行 */ } }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim() === '') continue; // 空行:事件分隔符,忽略
        handleLine(line);
      }
    }
    if (buf.trim()) handleLine(buf.trim()); // 流结束若仍有残留行
    return out;
  }

  // —— 浏览器端 MCP StreamableHTTP 客户端 ——
  class TianyanchaClient {
    constructor(endpoint, apiKey) {
      this.endpoint = endpoint || TYC_ENDPOINT;
      this.apiKey = apiKey || '';
      this._sessionId = null;
      this._clientReady = false;
      this._initPromise = null;
      this._idSeq = 0;
      this.tools = [];
      this.toolMap = {};
    }

    setApiKey(key) {
      const k = (key && key.trim()) ? key.trim() : '';
      if (k && k !== this.apiKey) {
        // key 变更:断开旧会话,下次请求重建
        this.apiKey = k;
        this._clientReady = false;
        this._initPromise = null;
        this._sessionId = null;
      } else if (!k) {
        this.apiKey = '';
      }
    }

    async _post(payload, opts) {
      opts = opts || {};
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': this.apiKey,
      };
      if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const sid = res.headers && res.headers.get ? res.headers.get('mcp-session-id') : null;
      if (sid) this._sessionId = sid;
      if (opts.isNotification) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + ' ' + (res.statusText || '') + ' ' + body.slice(0, 200));
      }
      const ct = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
      let messages;
      if (ct.indexOf('text/event-stream') >= 0) {
        messages = await readSSE(res);
      } else {
        const json = await res.json();
        messages = Array.isArray(json) ? json : [json];
      }
      // 取与请求 id 匹配且含 result/error 的响应
      const match = messages.find(m => m && m.id === payload.id && (m.result !== undefined || m.error !== undefined));
      return match || messages[messages.length - 1] || null;
    }

    async _ensureSession() {
      if (this._clientReady) return;
      if (this._initPromise) return this._initPromise;
      this._initPromise = (async () => {
        if (!this.apiKey) throw new Error('未配置天眼查 Key');
        const initRes = await this._post({
          jsonrpc: '2.0', id: ++this._idSeq, method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'job-tracker-ext', version: '1.5.55' },
          },
        });
        if (!initRes || initRes.error) {
          throw new Error('initialize 失败: ' + JSON.stringify(initRes && initRes.error));
        }
        // initialized 通知(无需响应)
        await this._post({
          jsonrpc: '2.0', method: 'notifications/initialized',
        }, { isNotification: true });
        const listRes = await this._post({
          jsonrpc: '2.0', id: ++this._idSeq, method: 'tools/list', params: {},
        });
        const tools = (listRes && listRes.result && listRes.result.tools) || [];
        this.tools = tools;
        this._buildToolMap();
        this._clientReady = true;
      })();
      return this._initPromise;
    }

    _buildToolMap() {
      const names = this.tools.map(t => t.name);
      const find = (...kw) => names.find(n => kw.every(k => n.toLowerCase().includes(k))) || null;
      this.toolMap = {
        search: find('search', 'compan') || find('search') || null,
        basic: find('basic', 'profil') || find('basic') || null,
        capabilities: find('capabilit') || null,
        callTool: find('call', 'tool') || find('call_tool') || null,
        riskInternal: 'get_risk_overview',
      };
    }

    _fillArgs(toolName, preferred) {
      const tool = this.tools.find(t => t.name === toolName);
      const props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
      const keys = Object.keys(props);
      const out = {};
      for (const [k, v] of Object.entries(preferred)) {
        if (keys.includes(k)) { out[k] = v; continue; }
        const alias = keys.find(kk => {
          const kkl = kk.toLowerCase();
          if (k === 'query' || k === 'company_name') return /(query|keyword|name|q|company)/.test(kkl);
          if (k === 'page') return kkl === 'page';
          if (k === 'page_size') return /page_?size/.test(kkl);
          return false;
        });
        if (alias) out[alias] = v;
      }
      if (keys.includes('page') && out.page == null) out.page = 1;
      if (keys.includes('page_size') && out.page_size == null) out.page_size = 10;
      return out;
    }

    async _call(toolName, args) {
      const res = await this._post({
        jsonrpc: '2.0', id: ++this._idSeq, method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
      const content = (res && res.result && res.result.content) || [];
      const text = (Array.isArray(content) ? content : []).map(c => (c && c.text) || '').join('\n');
      return text;
    }

    async searchCompany(name) {
      const tn = this.toolMap.search;
      if (!tn) throw new Error('天眼AI 未暴露搜索工具');
      const args = this._fillArgs(tn, { query: name, page: 1, page_size: 10 });
      const text = await this._call(tn, args);
      return parseSearch(text);
    }
    async getBasic(name) {
      const tn = this.toolMap.basic;
      if (!tn) throw new Error('天眼AI 未暴露工商档案工具');
      const args = this._fillArgs(tn, { company_name: name });
      return this._call(tn, args);
    }
    async getRiskOverview(name) {
      const tn = this.toolMap.callTool;
      if (!tn) return null;
      try {
        const args = this._fillArgs(tn, {
          company_name: name,
          tool_name: this.toolMap.riskInternal,
          arguments: { page: 1, page_size: 20 },
        });
        return await this._call(tn, args);
      } catch (e) {
        return null;
      }
    }

    // 主入口:返回标准化 companyRisk(失败返回 {fetchedAt,source,riskLevel:'unknown',note})
    async enrich(companyName, opts) {
      opts = opts || {};
      const fetchedAt = new Date().toISOString();
      const base = { fetchedAt, source: 'tyc-ai-direct' };
      try {
        await this._ensureSession();
        if (!companyName || !companyName.trim()) {
          return { ...base, riskLevel: 'unknown', note: '未提供公司名' };
        }
        const candidates = await this.searchCompany(companyName.trim());
        if (!candidates.length) {
          return { ...base, riskLevel: 'unknown', note: '天眼AI 未找到匹配企业: ' + companyName };
        }
        let top = candidates[0];
        if (opts.city) {
          const cityHit = candidates.find(c => c.name.includes(opts.city) || (c.city && c.city.includes(opts.city)));
          if (cityHit) top = cityHit;
        }
        const legalName = top.name;
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
        const riskText = await this.getRiskOverview(legalName);
        if (riskText && /空结果|未发现风险|未查询到风险/.test(riskText)) {
          companyRisk.judicialRisk = { caseCount: 0, types: [], level: 'low' };
        } else if (riskText) {
          companyRisk.judicialRisk = { caseCount: null, types: [], level: 'mid', note: '存在风险记录,建议人工复核' };
        } else {
          companyRisk.judicialRisk = { caseCount: 0, types: [], level: 'low' };
        }
        return companyRisk;
      } catch (e) {
        return { ...base, riskLevel: 'unknown', note: 'enrich 失败: ' + e.message };
      }
    }
  }

  // —— 扩展侧入口:自动读 chrome.storage 的 Key,单例复用会话 ——
  const JTTyc = (() => {
    let _singleton = null;
    function readKey() {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(['jt_tyc_api_key'], (res) => resolve((res && res.jt_tyc_api_key) || ''));
        } catch (e) { resolve(''); }
      });
    }
    function getClient(apiKey) {
      if (!_singleton) _singleton = new TianyanchaClient(TYC_ENDPOINT, apiKey);
      else _singleton.setApiKey(apiKey);
      return _singleton;
    }
    // enrich 返回:
    //   { skipped:true, reason:'no-key' | 'error', note }  → 调用方决定回退桥接/降级
    //   标准化 companyRisk 对象(可能无 unifiedCode,视为已查但无匹配) → 调用方转三态
    async function enrich(companyName, opts, apiKey) {
      const key = (apiKey && apiKey.trim()) || (await readKey());
      if (!key || !key.trim()) {
        return { skipped: true, reason: 'no-key', note: '未配置天眼查 Key(请在「企业分析(天眼查)」卡片填入)' };
      }
      try {
        const client = getClient(key.trim());
        return await client.enrich(companyName, opts);
      } catch (e) {
        return { skipped: true, reason: 'error', note: '天眼查直连失败: ' + e.message };
      }
    }
    // 仅供测试注入 mock 客户端
    function _setClientForTest(c) { _singleton = c; }
    return { enrich, TianyanchaClient, readKey, _setClientForTest };
  })();

  // 导出到全局(SW 用 self,页面用 window/self,node/jest 用 global)
  if (typeof self !== 'undefined') self.JTTyc = JTTyc;
  if (typeof window !== 'undefined' && window !== self) window.JTTyc = JTTyc;
  if (typeof global !== 'undefined') global.JTTyc = JTTyc;
})();
