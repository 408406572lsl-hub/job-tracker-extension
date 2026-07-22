// ============================================================
// mcp-connector.js — Chrome 扩展侧 MCP 桥接连接器(WebSocket 版)
// 在 background.js (Service Worker) 中加载
// 职责:
//   1. 作为 WebSocket 客户端连接 MCP 桥接进程(统一端口 8765)
//   2. 接收桥接的 {action, params} 请求,用 chrome.storage.local 执行后返回结果
//   3. 每个端口独立维护连接,断线自动重连
//
// 端口约定:统一使用 8765(8766 已废弃,不再使用)。每个 AI 助手各自启动一个
//   server.js 进程,但都连接扩展的同一 8765 端口(同时只运行一个桥接进程)。
//   数据一致性由 chrome.storage.local 保证。
//
// 注意:background.js 不加载 storage.js(架构约束),所以这里直接用
//   chrome.storage.local + JT_CONFIG.storageKeys 读写数据。
// ============================================================

(function () {
  'use strict';

  // MCP 桥接端口:统一 8765(8766 已废弃)。保持单连接,避免桥接进程未启动时刷屏
  const WS_PORTS = [8765];
  const RECONNECT_DELAY_INITIAL = 5000; // 初始重连间隔
  const RECONNECT_DELAY_MAX = 60000; // 最大重连间隔(60秒上限)
  const INITIAL_DELAY = 2000; // SW 启动后初始连接延迟

  // 每个端口的连接状态
  const connections = {}; // port → { ws, connected, reconnectTimer, failCount }
  const pendingLocal = new Map(); // 扩展主动请求的 pending: localId → {resolve, reject, timer}
  let nextLocalId = 1;

  // —— 城市名 ↔ BOSS 数字城市码映射 ——
  // 与 settings/autoscan.js 同源(SW 不能 import 页面脚本,故内联)。
  // BOSS 搜索 URL 的 city 参数只认数字码,中文会被忽略导致 0 结果。
  const CITY_NAME_TO_CODE = {
    '北京': '100010000', '上海': '101020100', '广州': '101280100',
    '深圳': '101280600', '南宁': '101300100', '长沙': '101270100',
    '杭州': '101210100', '武汉': '101200100', '成都': '101110100',
    '南京': '101190100', '佛山': '101280700', '苏州': '101230100',
    '重庆': '101040100', '西安': '101110200', '天津': '101030100',
    '郑州': '101180100', '青岛': '101200200', '东莞': '101281600',
    '昆明': '101290100', '合肥': '101220100', '厦门': '101230200',
    '南昌': '101240100', '福州': '101230300', '贵阳': '101260100',
    '海口': '101310100', '桂林': '101300200', '柳州': '101300300'
  };
  const CITY_CODE_TO_NAME = Object.keys(CITY_NAME_TO_CODE).reduce((m, n) => {
    m[CITY_NAME_TO_CODE[n]] = n; return m;
  }, {});
  // 将用户输入(城市名/城市码/空)归一为 {cityCode, cityName}。
  // 已是数字码则原样保留;城市名则查表转码;查不到也原样保留(留作 BOSS 未来扩展)。
  function resolveCity(raw) {
    if (!raw) return { cityCode: '', cityName: '' };
    const v = String(raw).trim();
    if (/^\d{6,}$/.test(v)) return { cityCode: v, cityName: CITY_CODE_TO_NAME[v] || '' };
    const code = CITY_NAME_TO_CODE[v];
    if (code) return { cityCode: code, cityName: v };
    return { cityCode: v, cityName: '' }; // 未知城市名,原样保留(可能 BOSS 新增)
  }

  // —— 存储读写(直接用 chrome.storage.local,不依赖 JTStorage) ——
  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (res) => resolve(res[key]));
    });
  }
  function storageSet(key, val) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: val }, () => resolve(val));
    });
  }

  // MCP 删除也必须写入墓碑,否则下一轮自动扫描会把已删除岗位重新收录。
  async function addDeletedJobKeys(jobs) {
    const keys = (jobs || []).map(job => JT_Utils.jobKey(job)).filter(Boolean);
    if (keys.length === 0) return [];
    const current = await storageGet(JT_CONFIG.storageKeys.deletedJobs) || [];
    const merged = [...new Set([...current, ...keys])];
    await storageSet(JT_CONFIG.storageKeys.deletedJobs, merged);
    return merged;
  }

  // 与 dashboard 保持一致:AI 分析分优先,无 AI 分时才使用规则分。
  function getEffectiveScore(job) {
    return typeof job.aiFitScore === 'number' ? job.aiFitScore : (job.score || 0);
  }

  // —— 聊天页 tab 查找与消息发送 ——
  // 查找 BOSS 直聘聊天页 tab
  function findChatTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const chatTab = tabs.find(t =>
          t.url && /zhipin\.com.*\/chat/i.test(t.url)
        );
        resolve(chatTab || null);
      });
    });
  }

  // 向指定 tab 的 content script 发消息(带超时)
  function sendToTab(tabId, msg, timeoutMs = 10000) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: '向页面发消息超时' });
        }
      }, timeoutMs);

      try {
        chrome.tabs.sendMessage(tabId, msg, (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(res || { ok: false, error: '页面未响应(可能需要刷新页面)' });
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: String(e) });
        }
      }
    });
  }

  // 连接到指定端口的 MCP 桥接进程
  function connect(port) {
    const conn = connections[port];
    if (!conn) return;
    // 已连接或正在连接,不重复发起
    if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) return;

    const url = 'ws://127.0.0.1:' + port;
    try {
      conn.ws = new WebSocket(url);

      conn.ws.onopen = () => {
        conn.connected = true;
        // 握手:通知桥接扩展已就绪,并携带使用者自填的天眼查 Key(若存在)
        const handshake = { type: 'JT_MCP_CONNECTED' };
        chrome.storage.local.get([JT_CONFIG.storageKeys.tycApiKey], (res) => {
          const tycKey = (res && res[JT_CONFIG.storageKeys.tycApiKey]) || '';
          if (tycKey) handshake.tycApiKey = tycKey;
          try { conn.ws.send(JSON.stringify(handshake)); } catch (e) { console.error('[JT MCP] 握手发送失败:', e); }
        });
        console.log('[JT MCP] 已连接到 MCP 桥接进程(端口 ' + port + ')');
        conn.failCount = 0; // 连接成功,重置退避计数
      };

      conn.ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          onMessage(event.data, port);
        } else if (event.data instanceof Blob) {
          event.data.text().then(t => onMessage(t, port)).catch(e => console.error('[JT MCP] 解析消息失败:', e));
        }
      };

      conn.ws.onclose = () => {
        const wasConnected = conn.connected;
        conn.ws = null;
        conn.connected = false;
        if (wasConnected) {
          console.log('[JT MCP] 桥接断开(端口 ' + port + '),将自动重连');
        } else {
          // 从未连上(桥接进程未启动):静默重连,避免刷屏
          console.debug('[JT MCP] 端口 ' + port + ' 未连接,静默重连中');
        }
        scheduleReconnect(port);
      };

      conn.ws.onerror = () => {
        // 静默:错误日志会和 onclose 重复,不单独打印
      };
    } catch (e) {
      console.error('[JT MCP] 连接失败(端口 ' + port + '):', e);
      conn.ws = null;
      conn.connected = false;
      scheduleReconnect(port);
    }
  }

  function scheduleReconnect(port) {
    const conn = connections[port];
    if (!conn || conn.reconnectTimer) return;
    // 指数退避:5s → 10s → 20s → 40s → 60s(上限)
    conn.failCount = (conn.failCount || 0) + 1;
    const delay = Math.min(RECONNECT_DELAY_INITIAL * Math.pow(2, conn.failCount - 1), RECONNECT_DELAY_MAX);
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      connect(port);
    }, delay);
  }

  // 向桥接主动发请求(扩展→server,等待响应)
  function requestToBridge(action, params = {}, timeout = 15000) {
    // 找一个已连接端口
    const port = WS_PORTS.find(p => connections[p] && connections[p].connected && connections[p].ws);
    if (!port) return Promise.reject(new Error('MCP 桥接未连接'));
    const id = 'L' + (nextLocalId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingLocal.delete(id);
        reject(new Error('桥接响应超时(' + action + ')'));
      }, timeout);
      pendingLocal.set(id, { resolve, reject, timer });
      connections[port].ws.send(JSON.stringify({ _reqId: id, action, params }));
    });
  }

  // 处理桥接发来的请求
  async function onMessage(text, port) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      console.error('[JT MCP] 解析桥接消息失败:', e);
      return;
    }
    if (!msg) return;

    // 扩展主动请求的响应(带本地 _reqId 且 pending 中存在)
    if (msg._reqId && pendingLocal.has(msg._reqId)) {
      const p = pendingLocal.get(msg._reqId);
      pendingLocal.delete(msg._reqId);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }

    // 桥接(server)主动发来的请求(带 action)→ 执行并回复
    if (!msg._reqId || msg.action) {
      let result, error;
      try {
        result = await handleAction(msg.action, msg.params || {});
      } catch (e) {
        error = e.message || String(e);
      }
      const conn = connections[port];
      if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ _reqId: msg._reqId, result, error }));
      }
    }
  }

  // 分析完成后自动做公司 enrichment:抽公司名/城市/行业 → 经 mcp-bridge 调天眼AI → 写回 analysis.companyRisk
  // 失败静默(不影响主分析)
  async function enrichJobCompany(job, jobs) {
    try {
      const companyName = job.company || (job.title ? job.title.split(/[\s·\-—|]/)[0] : '');
      if (!companyName) return;
      const city = job.city || '';
      const jobIndustry = /康复|医疗|治疗|理疗|中医/.test(job.title || job.category || '') ? (job.title || job.category || '') : '';
      const er = await requestToBridge('enrichCompany', { companyName, city, jobIndustry });
      if (er && er.unifiedCode) {
        const idx = jobs.findIndex(j => j.id === job.id);
        if (idx >= 0) {
          jobs[idx].analysis = jobs[idx].analysis || {};
          jobs[idx].analysis.companyRisk = er;
          await storageSet(JT_CONFIG.storageKeys.jobs, jobs);
          console.log('[JT MCP] 公司 enrichment 完成:', companyName, er.riskLevel);
        }
      }
    } catch (e) {
      console.warn('[JT MCP] 公司 enrichment 跳过:', e.message);
    }
  }

  // 仅取企业风险(天眼AI),不写回存储,供 AI 深度分析时作为上下文注入 prompt。
  // 桥接未连接时 requestToBridge 会抛错,由调用方降级(照常只分析岗位)。
  // 返回语义(关键:区分"查不到企业"与"根本没查",前端据此给用户明确提示):
  //   { queried:true, found:true,  risk }  → 查到企业,有完整工商/风险数据
  //   { queried:true, found:false, note }  → 查了天眼查,但无匹配企业/无风险记录(如 note 说明)
  //   null                                  → 根本没查(桥接未连 / key 未配 / 异常)
  async function fetchCompanyRisk(job) {
    const companyName = job.company || (job.title ? job.title.split(/[\s·\-—|]/)[0] : '');
    if (!companyName) return null;
    const city = job.city || job.location || '';
    const jobIndustry = /康复|医疗|治疗|理疗|中医/.test(job.title || job.category || '') ? (job.title || job.category || '') : '';
    const er = await requestToBridge('enrichCompany', { companyName, city, jobIndustry });
    if (!er) return null; // 桥接未连 / 异常 → 根本没查
    if (er.unifiedCode) return { queried: true, found: true, risk: er };
    // 有返回但无 unifiedCode:天眼查查到了响应但无匹配企业(如 note 描述),仍视为"已查"
    return { queried: true, found: false, note: er.note || '天眼查未返回该企业工商数据' };
  }
  async function handleAction(action, params) {
    const SK = JT_CONFIG.storageKeys;
    switch (action) {
      case 'getJobs':
        return await storageGet(SK.jobs) || [];

      case 'getStats': {
        const jobs = await storageGet(SK.jobs) || [];
        const total = jobs.length;
        const byStatus = {};
        let matched = 0;
        jobs.forEach(j => {
          byStatus[j.status || 'unseen'] = (byStatus[j.status || 'unseen'] || 0) + 1;
          if (getEffectiveScore(j) >= 40) matched++;
        });
        return { total, matched, byStatus };
      }

      case 'getFilters':
        return await storageGet(SK.filters) || {};

      case 'getAutoScan':
        return await storageGet(SK.autoScan) || {};

      case 'updateAutoScan': {
        // 修改自动扫描配置(合并到现有配置,只改传入的字段)
        // 可改: keywords, city, maxJobsPerRun, autoAnalyze, analyzePerDay, enrichDetails, intervalMin
        const current = await storageGet(SK.autoScan) || {};
        const updated = Object.assign({}, current, params);
        // 城市名→码转换: BOSS 搜索 URL 只认数字城市码,中文会被 BOSS 忽略导致 0 结果。
        // 设置页 settings/autoscan.js 有同样的映射表,这里内联一份(SW 不能 import 页面脚本)。
        if (params.city != null) {
          const { cityCode, cityName } = resolveCity(params.city);
          updated.city = cityCode;
          updated.cityName = cityName; // 同步城市名(含空值,保证字段一致)
        }
        await storageSet(SK.autoScan, updated);
        return { ok: true, config: updated };
      }

      case 'searchJobs':
        return await searchJobs(params);

      case 'getJobDetail':
        return await getJobDetail(params);

      case 'updateStatus': {
        const jobs = await storageGet(SK.jobs) || [];
        const idx = jobs.findIndex(j => j.id === params.jobId);
        if (idx < 0) throw new Error('岗位不存在: ' + params.jobId);
        jobs[idx].status = params.status;
        await storageSet(SK.jobs, jobs);
        return { ok: true, jobId: params.jobId, status: params.status };
      }

      case 'exportJobs':
        return await exportJobs(params);

      // —— 写操作增强 ——
      case 'deleteJob': {
        const jobs = await storageGet(SK.jobs) || [];
        const idx = jobs.findIndex(j => j.id === params.jobId);
        if (idx < 0) throw new Error('岗位不存在: ' + params.jobId);
        const removed = jobs.splice(idx, 1);
        await addDeletedJobKeys(removed);
        await storageSet(SK.jobs, jobs);
        return { ok: true, jobId: params.jobId, remaining: jobs.length };
      }

      case 'deleteJobs': {
        const jobs = await storageGet(SK.jobs) || [];
        const idSet = new Set(params.jobIds || []);
        const removed = jobs.filter(j => idSet.has(j.id));
        const filtered = jobs.filter(j => !idSet.has(j.id));
        await addDeletedJobKeys(removed);
        await storageSet(SK.jobs, filtered);
        return { ok: true, deleted: removed.length, remaining: filtered.length };
      }

      case 'updateNotes': {
        const jobs = await storageGet(SK.jobs) || [];
        const idx = jobs.findIndex(j => j.id === params.jobId);
        if (idx < 0) throw new Error('岗位不存在: ' + params.jobId);
        jobs[idx].notes = params.notes || '';
        await storageSet(SK.jobs, jobs);
        return { ok: true, jobId: params.jobId, notes: jobs[idx].notes };
      }

      case 'batchUpdateStatus': {
        const jobs = await storageGet(SK.jobs) || [];
        const idSet = new Set(params.jobIds || []);
        let changed = 0;
        jobs.forEach(j => {
          if (idSet.has(j.id)) { j.status = params.status; changed++; }
        });
        await storageSet(SK.jobs, jobs);
        return { ok: true, changed, status: params.status };
      }

      // —— AI 分析触发 ——
      case 'triggerAnalyze': {
        const jobs = await storageGet(SK.jobs) || [];
        const job = jobs.find(j => j.id === params.jobId);
        if (!job) throw new Error('岗位不存在: ' + params.jobId);
        // 直接调用 SW 的 analyzeJob(共享全局作用域,无需 sendMessage)
        const res = await analyzeJob(job, !!params.force);
        if (!res.ok) throw new Error(res.error || 'AI 分析失败');
        // 分析完成后自动做公司 enrichment(直连天眼AI,经 mcp-bridge)
        await enrichJobCompany(job, jobs);
        return { ok: true, jobId: params.jobId, analysis: res.analysis, cached: !!res.cached };
      }

      // —— 写回公司风险(由 mcp-bridge 的 enrich_company tool 调用) ——
      case 'saveCompanyRisk': {
        const jobs = await storageGet(SK.jobs) || [];
        const idx = jobs.findIndex(j => j.id === params.jobId);
        if (idx < 0) throw new Error('岗位不存在: ' + params.jobId);
        jobs[idx].analysis = jobs[idx].analysis || {};
        jobs[idx].analysis.companyRisk = params.companyRisk || null;
        await storageSet(SK.jobs, jobs);
        return { ok: true, jobId: params.jobId, hasRisk: !!(params.companyRisk && params.companyRisk.unifiedCode) };
      }

      case 'batchAnalyze': {
        // 批量分析(异步执行,立即返回,避免 MCP 超时)
        // 分析结果写回岗位的 aiFitScore / aiAnalysis 字段,用 search_jobs 可查
        const jobs = await storageGet(SK.jobs) || [];
        const pending = params.force
          ? jobs.slice()
          : jobs.filter(j => j.aiFitScore == null);
        const limit = Math.min(params.limit || 5, 10);
        const targets = pending.slice(0, limit);
        if (targets.length === 0) {
          return { ok: true, message: '没有需要分析的岗位(所有岗位已有 AI 分数)', analyzed: 0 };
        }
        // 异步串行执行,不等待
        (async () => {
          for (const job of targets) {
            try {
              await analyzeJob(job, !!params.force);
              console.log('[JT MCP] 批量分析完成:', job.title);
            } catch (e) {
              console.error('[JT MCP] 批量分析失败:', job.title, e);
            }
          }
          console.log('[JT MCP] 批量分析全部结束,共', targets.length, '个');
        })();
        return {
          ok: true,
          message: '已开始后台分析 ' + targets.length + ' 个岗位,请稍后用 search_jobs 查看结果',
          pending: targets.map(j => ({ jobId: j.id, title: j.title }))
        };
      }

      // —— 自动扫描控制 ——
      case 'runAutoScan': {
        // 触发一轮自动扫描(唤醒前端执行)
        // 直接调用 SW 的 wakeFrontendToScan(共享全局作用域)
        const res = await wakeFrontendToScan();
        return {
          ok: true,
          via: res.via,
          message: res.via === 'new_dashboard'
            ? '已打开 dashboard 页面并开始扫描,请查看该页面(扫描在前端执行,需要该页面保持打开)'
            : '已唤醒已打开的 dashboard 开始扫描,请查看该页面'
        };
      }

      case 'getAutoScanStatus': {
        // 直接调用 SW 的 getAutoScanStatus
        return await getAutoScanStatus();
      }

      // —— HR 回复 + 简历 ——
      case 'generateReply': {
        if (!params.hrMessage) throw new Error('需要 hrMessage 参数');
        // 直接调用 SW 的 handleReply
        const res = await handleReply(
          params.hrMessage,
          params.intent || 'interested',
          params.style || 'professional',
          params.context || {}
        );
        if (!res.ok) throw new Error(res.error || '生成回复失败');
        return { ok: true, versions: res.versions };
      }

      // —— 聊天半自动回复 ——
      case 'chatGetContext': {
        // 查找 BOSS 聊天页 tab,向其 content script 发消息
        const tab = await findChatTab();
        if (!tab) throw new Error('未找到 BOSS 聊天页,请先在浏览器中打开 BOSS 直聘聊天页');
        const res = await sendToTab(tab.id, { type: 'JT_CHAT_GET_CONTEXT', maxMessages: params.maxMessages || 20 });
        if (!res || !res.ok) throw new Error(res?.error || '读取聊天上下文失败');
        return { ok: true, context: res.context };
      }

      case 'chatGetDebug': {
        const tab = await findChatTab();
        if (!tab) throw new Error('未找到 BOSS 聊天页,请先在浏览器中打开 BOSS 直聘聊天页');
        const res = await sendToTab(tab.id, { type: 'JT_CHAT_DEBUG' });
        if (!res || !res.ok) throw new Error(res?.error || '获取调试信息失败');
        return { ok: true, info: res.info };
      }

      case 'chatSmartReply': {
        // 步骤1:查找聊天页并抓取上下文
        const tab = await findChatTab();
        if (!tab) throw new Error('未找到 BOSS 聊天页,请先在浏览器中打开 BOSS 直聘聊天页');
        const ctxRes = await sendToTab(tab.id, { type: 'JT_CHAT_GET_CONTEXT', maxMessages: params.maxMessages || 20 });
        if (!ctxRes || !ctxRes.ok) throw new Error(ctxRes?.error || '读取聊天上下文失败');

        // 步骤2:调用 SW 的 handleSmartReply 综合上下文生成回复
        const res = await handleSmartReply(ctxRes.context);
        if (!res.ok) throw new Error(res.error || '生成回复失败');
        return { ok: true, versions: res.versions, context: ctxRes.context };
      }

      case 'getProfile': {
        const profile = await storageGet(SK.profile);
        return { ok: true, profile: profile || null };
      }

      default:
        throw new Error('未知 action: ' + action);
    }
  }

  // 搜索/筛选岗位
  async function searchJobs(params) {
    const SK = JT_CONFIG.storageKeys;
    const jobs = await storageGet(SK.jobs) || [];
    let result = [...jobs];

    if (params.keyword) {
      const kw = params.keyword.toLowerCase();
      result = result.filter(j =>
        (j.title || '').toLowerCase().includes(kw) ||
        (j.company || '').toLowerCase().includes(kw)
      );
    }
    if (params.city) {
      const c = params.city.toLowerCase();
      result = result.filter(j => (j.location || '').toLowerCase().includes(c));
    }
    if (params.status) {
      result = result.filter(j => j.status === params.status);
    }
    if (typeof params.minScore === 'number') {
      result = result.filter(j => getEffectiveScore(j) >= params.minScore);
    }

    // 排序
    const sortBy = params.sortBy || 'score';
    result.sort((a, b) => {
      if (sortBy === 'score') return getEffectiveScore(b) - getEffectiveScore(a);
      if (sortBy === 'capturedAt') return (b.capturedAt || 0) - (a.capturedAt || 0);
      if (sortBy === 'salaryMax') return (b.salaryMax || 0) - (a.salaryMax || 0);
      if (sortBy === 'title') return (a.title || '').localeCompare(b.title || '', 'zh-CN');
      return 0;
    });

    const limit = params.limit || 50;
    return {
      total: result.length,
      jobs: result.slice(0, limit).map(j => ({
        id: j.id,
        title: j.title,
        company: j.company,
        location: j.location,
        salaryRaw: j.salaryRaw,
        salaryMin: j.salaryMin,
        salaryMax: j.salaryMax,
        score: getEffectiveScore(j),
        scoreSource: typeof j.aiFitScore === 'number' ? 'ai' : (j.scoreSource || 'rule'),
        aiFitScore: j.aiFitScore,
        status: j.status,
        url: j.url,
        capturedAt: j.capturedAt,
        matchReasons: (j.matchReasons || []).slice(0, 3),
      })),
    };
  }

  // 获取单个岗位的完整详情(含 AI 分析全文、岗位描述、任职要求、笔记等)
  async function getJobDetail(params) {
    const SK = JT_CONFIG.storageKeys;
    const jobs = await storageGet(SK.jobs) || [];
    const job = jobs.find(j => j.id === params.jobId);
    if (!job) throw new Error('岗位不存在: ' + params.jobId);
    return {
      ok: true,
      job: {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        salaryRaw: job.salaryRaw,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        description: job.description || '',
        requirement: job.requirement || '',
        score: job.score,
        scoreSource: job.scoreSource,
        aiFitScore: job.aiFitScore,
        aiAnalysis: job.aiAnalysis || null,
        aiAnalyzedAt: job.aiAnalyzedAt || null,
        status: job.status,
        url: job.url,
        notes: job.notes || '',
        capturedAt: job.capturedAt,
        matchReasons: job.matchReasons || [],
        _meta: job._meta || null
      }
    };
  }

  // 导出岗位
  async function exportJobs(params) {
    const SK = JT_CONFIG.storageKeys;
    const jobs = await storageGet(SK.jobs) || [];
    let filtered = [...jobs];

    if (params.filter) {
      const f = params.filter;
      if (f.keyword) {
        const kw = f.keyword.toLowerCase();
        filtered = filtered.filter(j =>
          (j.title || '').toLowerCase().includes(kw) ||
          (j.company || '').toLowerCase().includes(kw)
        );
      }
      if (f.status) filtered = filtered.filter(j => j.status === f.status);
      if (typeof f.minScore === 'number') filtered = filtered.filter(j => getEffectiveScore(j) >= f.minScore);
    }

    const format = params.format || 'json';
    if (format === 'csv') {
      const headers = ['标题', '公司', '地点', '薪资', '最低月薪', '最高月薪', '来源', '匹配分', '状态', '链接', '记录时间'];
      const rows = filtered.map(j => [
        j.title || '', j.company || '', j.location || '', j.salaryRaw || '',
        j.salaryMin || 0, j.salaryMax || 0, j.site || '',
        getEffectiveScore(j), j.status || 'unseen', j.url || '',
        j.capturedAt ? new Date(j.capturedAt).toLocaleString('zh-CN') : ''
      ].map(v => {
        let cell = String(v);
        if (/^[=+\-@]/.test(cell)) cell = "'" + cell;
        return '"' + cell.replace(/"/g, '""') + '"';
      }).join(','));
      return headers.join(',') + '\n' + rows.join('\n');
    }
    return JSON.stringify(filtered, null, 2);
  }

  // 初始化所有端口连接
  function connectAll() {
    WS_PORTS.forEach(port => {
      if (!connections[port]) {
        connections[port] = { ws: null, connected: false, reconnectTimer: null };
      }
      connect(port);
    });
  }

  // 暴露给外部(可选,用于 dashboard 查看连接状态 / background AI 分析预查企业)
  const JTMcpConnector = {
    isConnected: () => Object.values(connections).some(c => c.connected),
    isPortConnected: (port) => !!(connections[port] && connections[port].connected),
    getPorts: () => WS_PORTS.slice(),
    connect: connectAll,
    // 供 background.analyzeJob 在 AI 分析前预查企业工商/风险(桥接未连则调用方降级)
    getCompanyRisk: fetchCompanyRisk,
  };

  // 初始连接(延迟 2s,等 SW 其他初始化完成)
  setTimeout(connectAll, INITIAL_DELAY);

  // SW 被唤醒时,如果未连接则立即尝试连接(避免 SW 休眠后无法恢复)
  chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => {
    setTimeout(connectAll, INITIAL_DELAY);
  });

  // 导出到 SW 全局
  if (typeof self !== 'undefined') self.JTMcpConnector = JTMcpConnector;
})();
