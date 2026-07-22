// ============================================================
// background.js — Service Worker
// 消息中枢 + 自动入库 + 右键菜单 + 大模型调用(LLM)
// LLM 调用在 service worker 中执行,绕过页面 CORS 限制
// ============================================================

// 加载共享库(service worker 全局作用域)
// v1.5.44: 新增 mcp-connector.js(MCP 桥接连接器,connectNative 到本地 MCP server)
importScripts('lib/config.js', 'lib/prompts.js', 'lib/autoscan.js', 'lib/mcp-connector.js', 'lib/tianyancha-client.js');

// 右键菜单:保存当前页岗位
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'jt-save-current',
    title: '岗位猎手:记录当前页岗位',
    contexts: ['page']
  });
  updateBadge();
  ensureAutoScanAlarm();
});

// 右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'jt-save-current') {
    chrome.tabs.sendMessage(tab.id, { type: 'JT_GET_PAGE_JOB' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.job) return;
      chrome.runtime.sendMessage({ type: 'JT_AUTO_SAVE', job: res.job });
      showNotification('已记录岗位', res.job.title || '未知岗位');
    });
  }
});

// 消息中枢
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // —— 自动保存(content / popup 发来)——
  if (msg.type === 'JT_AUTO_SAVE' && msg.job) {
    saveJobDedup(msg.job).then((result) => {
      sendResponse(result);
      updateBadge();
    });
    return true;
  }
  if (msg.type === 'JT_SAVE_PAGE_JOB' && msg.job) {
    saveJobDedup(msg.job).then((result) => {
      sendResponse(result);
      updateBadge();
      if (result.action === 'added') showNotification('已记录岗位', result.job.title);
    });
    return true;
  }

  // —— 统计 ——
  if (msg.type === 'JT_GET_STATS') {
    chrome.storage.local.get([JT_CONFIG.storageKeys.jobs], (res) => {
      sendResponse({ total: (res[JT_CONFIG.storageKeys.jobs] || []).length });
    });
    return true;
  }

  // —— LLM:岗位适配度 + 避坑分析 ——
  if (msg.type === 'JT_LLM_ANALYZE' && msg.job) {
    analyzeJob(msg.job, !!msg.force).then(sendResponse).catch(e => {
      console.error('[JT] analyzeJob failed:', e);
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  // —— 自动扫描:立即执行一轮(改为唤醒前端)——
  if (msg.type === 'JT_RUN_AUTOSCAN_NOW') {
    wakeFrontendToScan().then((res) => sendResponse({ ok: true, ...res })).catch(e => {
      console.error('[JT] wakeFrontendToScan failed:', e);
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  // —— 自动扫描:批量保存岗位(浮动按钮用)——
  if (msg.type === 'JT_SAVE_JOBS_BATCH' && msg.jobs) {
    saveJobsBatch(msg.jobs).then((res) => {
      sendResponse(res);
      updateBadge();
    });
    return true;
  }

  // —— 通知(前端控制器调用,SW 有 notifications 权限)——
  if (msg.type === 'JT_NOTIFY' && msg.title) {
    showNotification(msg.title, msg.message || '');
    sendResponse({ ok: true });
    return true;
  }

  // —— 自动扫描:状态查询 ——
  if (msg.type === 'JT_GET_AUTOSCAN_STATUS') {
    getAutoScanStatus().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // —— LLM:HR 回复生成 ——
  if (msg.type === 'JT_LLM_REPLY' && msg.hrMessage != null) {
    handleReply(msg.hrMessage, msg.intent, msg.style, msg.context || {})
      .then(sendResponse).catch(e => {
        console.error('[JT] handleReply failed:', e);
        sendResponse({ ok: false, error: String(e) });
      });
    return true;
  }

  // —— LLM:半自动智能回复(综合岗位+简历+聊天历史) ——
  if (msg.type === 'JT_LLM_SMART_REPLY' && msg.context) {
    handleSmartReply(msg.context)
      .then(sendResponse).catch(e => {
        console.error('[JT] handleSmartReply failed:', e);
        sendResponse({ ok: false, error: String(e) });
      });
    return true;
  }

  // —— LLM:测试连接 ——
  if (msg.type === 'JT_LLM_TEST') {
    handleTest().then(sendResponse).catch(e => {
      console.error('[JT] handleTest failed:', e);
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  // —— LLM:简历智能分析 ——
  if (msg.type === 'JT_LLM_RESUME' && msg.resumeText != null) {
    handleResumeAnalysis(msg.resumeText, msg.jobIntent || '')
      .then(sendResponse).catch(e => {
        console.error('[JT] handleResumeAnalysis failed:', e);
        sendResponse({ ok: false, error: String(e) });
      });
    return true;
  }

  // —— 简历档案读取(content script 用)——
  if (msg.type === 'JT_GET_PROFILE') {
    chrome.storage.local.get([JT_CONFIG.storageKeys.profile], (res) => {
      sendResponse({ ok: true, profile: res[JT_CONFIG.storageKeys.profile] || null });
    });
    return true;
  }

  // 未识别的消息类型:快速失败返回,避免调用方无限等待
  sendResponse({ ok: false, error: '未知消息类型: ' + (msg && msg.type) });
  return false;
});

// ----------------------------------------------------------
// LLM 处理:适配度 + 避坑(供 popup / dashboard / 自动扫描共用)
// ----------------------------------------------------------
async function analyzeJob(job, force) {
  const settings = await getAiSettings();
  if (!settings.apiKey) {
    return { ok: false, error: '尚未配置 API Key,请到设置页填写后再使用 AI 分析。', needSettings: true };
  }

  // 预查企业工商/风险(天眼AI),作为 AI 分析的上下文。
  // companyRiskMeta 为三态对象(见 fetchCompanyRiskForJob),供前端明确提示用户。
  // 降级:桥接未连 / 查询失败 → companyRiskMeta 为 null,照常只分析岗位。
  const companyRiskMeta = await fetchCompanyRiskForJob(job);
  // 喂给 LLM 的 risk(仅查到企业且有数据时注入;查了但无数据 / 没查 → 不注入)
  const companyRiskForLLM = (companyRiskMeta && companyRiskMeta.found) ? companyRiskMeta.risk : null;

  // 缓存层:同一岗位 + 简历 + 意向 组合在 TTL 内只调一次 AI,消除漂移
  // force=true 时跳过缓存,强制重新分析
  const cacheKey = getAiCacheKey(job, settings.resumeText, settings.jobIntent);
  if (!force) {
    const cached = await readAiCache(cacheKey);
    if (cached) {
      // 缓存命中:若本次已取到企业信息,合并进返回结果(保证卡片也能展示)
      if (companyRiskMeta && companyRiskMeta.found) {
        try { await persistCompanyRisk(job, companyRiskMeta.risk); } catch (e) { /* 静默 */ }
      }
      return {
        ok: true,
        analysis: cached,
        cached: true,
        companyRisk: (companyRiskMeta && companyRiskMeta.found) ? companyRiskMeta.risk : undefined,
        companyRiskMeta: companyRiskMeta || undefined,
      };
    }
  }

  const messages = JTPrompts.buildAnalyzeMessages(job, settings.resumeText, settings.jobIntent, companyRiskForLLM);
  let llmRes = await callLLM(settings, messages, true);
  if (!llmRes.ok) return llmRes;

  // 解析 JSON —— content 优先,reasoning 兜底(完整 → 宽松)
  let parsed = parseAnalysisResult(llmRes);

  // 推理模型 content 为空 + reasoning 提取失败 → 自动关思考重试一次
  // (关思考后模型直接在 content 输出最终 JSON,绕过"答案藏在思考里"的问题)
  if (!parsed && llmRes._isReasoning && !settings.disableReasoning) {
    console.warn('[JT] 推理模型 content 为空且 reasoning 提取失败(_finishReason=' + llmRes._finishReason + '),自动关思考重试一次');
    const retrySettings = { ...settings, disableReasoning: true };
    const retryRes = await callLLM(retrySettings, messages, true);
    if (retryRes.ok) {
      llmRes = retryRes;
      parsed = parseAnalysisResult(llmRes);
    }
  }

  if (parsed) {
    writeAiCache(cacheKey, parsed);
    await persistAiScore(job, parsed);
    // 企业信息随分析结果一并写回(供岗位详情卡片展示,且下次可直接复用)
    if (companyRiskMeta && companyRiskMeta.found) {
      try { await persistCompanyRisk(job, companyRiskMeta.risk); } catch (e) { /* 静默 */ }
    }
    return {
      ok: true,
      analysis: parsed,
      companyRisk: (companyRiskMeta && companyRiskMeta.found) ? companyRiskMeta.risk : undefined,
      companyRiskMeta: companyRiskMeta || undefined,
    };
  }

  // content 无法解析为有效 JSON → 明确报错,绝不解析 reasoning 来凑数(避免假 100 分)
  // 诊断透明化:推理模型把内容放在 reasoning,把 reasoning 预览一并发出,便于定位模型真实返回。
  let raw = (llmRes.content || '').slice(0, JT_CONFIG.limits.RAW_ERROR_PREVIEW);
  if (llmRes._isReasoning && llmRes.reasoningRaw) {
    raw = '【推理模型:content 为空,以下为 reasoning(思考过程)前 ' + JT_CONFIG.limits.RAW_ERROR_PREVIEW + ' 字符,供排查答案到底在哪】\n' +
      llmRes.reasoningRaw.slice(0, JT_CONFIG.limits.RAW_ERROR_PREVIEW);
  }
  // 增强诊断:若 finish_reason=length,明确提示 token 不足
  const lengthHint = (llmRes._finishReason === 'length')
    ? '（finish_reason=length:思考过程用尽了 max_tokens,模型没来得及输出最终答案。已在 v1.5.23 增大推理模型 token 上限,若仍出现此问题请改用非推理模型。）'
    : '';
  const reasoningNote = llmRes._isReasoning
    ? '（当前为推理模型,其答案在 reasoning(思考过程)中、content 为空。本插件已自动尝试从思考过程提取完整 JSON 并自动关思考重试;若仍失败,请二选一:①在 AI 设置勾选「关闭思考过程」(部分网关支持,可让模型直接在 content 输出答案);②改用非推理模型如 openai/gpt-4o-mini / deepseek/deepseek-chat。JSON 分析任务不建议用推理模型。）' + lengthHint
    : lengthHint;
  return {
    ok: false,
    error: '模型未返回可用的 JSON 结果。' + reasoningNote,
    raw
  };
}

// 把 AI 适配度分写回岗位记录(以 AI 分为管理面板主评分)
// 注意:background 是 service worker,未 import storage.js,JTStorage 不在作用域。
// 这里直接用 chrome.storage.local 读写(与 saveJobDedup 同模式),不依赖 JTStorage。
function persistAiScore(job, analysis) {
  if (!analysis || !job) return Promise.resolve(null);
  // 仅接受有穷数字,字符串/NaN/Infinity 一律视为无效(防被篡改响应写入异常分)
  const fitScore = (typeof analysis.fitScore === 'number' && Number.isFinite(analysis.fitScore)) ? analysis.fitScore : null;
  return new Promise((resolve) => {
    chrome.storage.local.get([JT_CONFIG.storageKeys.jobs], (res) => {
      const jobs = res[JT_CONFIG.storageKeys.jobs] || [];
      // 优先按 id 命中,否则按去重键(URL / 标题)命中已存记录
      let idx = (job.id != null) ? jobs.findIndex(j => j.id === job.id) : -1;
      if (idx < 0) idx = JT_Utils.findDuplicate(jobs, job);
      if (idx < 0) { resolve(null); return; }
      if (fitScore != null) jobs[idx].aiFitScore = fitScore;
      jobs[idx].aiAnalysis = analysis || null;
      jobs[idx].aiAnalyzedAt = Date.now();
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.jobs]: jobs }, () => resolve(jobs[idx]));
    });
  }).catch(err => { console.error('[JT] 持久化 AI 分析失败:', err); });
}

// 预查企业工商/风险(天眼AI),供 AI 深度分析作为上下文。
// 链路(方案 A,直连优先):
//   ① 扩展直连天眼查(JTTyc,Key 来自设置页本地存储,不依赖 bridge)
//   ② 直连失败/未配 Key → 桥接兜底(mcp-bridge 仍在跑时)
// 复用:若岗位已存一份 24h 内、同企业的 companyRisk,直接复用。
// 返回语义(三态,供前端明确提示用户):
//   { queried:true, found:true, risk }  → 查到企业,有完整数据
//   { queried:true, found:false, note } → 查了天眼查但无匹配企业/无风险记录
//   null                                 → 根本没查(直连与桥接都不可用)
async function fetchCompanyRiskForJob(job) {
  if (!job || !job.company) return null;
  // 复用近期已查到的企业信息(避免每次分析都打天眼查)
  try {
    if (job.analysis && job.analysis.companyRisk && job.analysis.companyRisk.fetchedAt) {
      const age = Date.now() - new Date(job.analysis.companyRisk.fetchedAt).getTime();
      if (age >= 0 && age < 24 * 3600 * 1000) {
        return { queried: true, found: true, risk: job.analysis.companyRisk };
      }
    }
  } catch (e) { /* 解析失败则忽略,走实时查询 */ }

  const companyName = job.company;
  const city = job.city || job.location || '';
  const jobIndustry = /康复|医疗|治疗|理疗|中医/.test(job.title || job.category || '') ? (job.title || job.category || '') : '';
  const opts = { city, jobIndustry };

  // ① 直连天眼查(Key 在设置页本地存储,不依赖 8765 端口/bridge)
  try {
    const direct = await JTTyc.enrich(companyName, opts);
    if (direct && !direct.skipped) {
      // 查到(有/无 unifiedCode 都算已查)→ 直接转三态返回
      if (direct.unifiedCode) return { queried: true, found: true, risk: direct };
      return { queried: true, found: false, note: direct.note || '天眼查未返回该企业工商数据' };
    }
    if (direct && direct.reason === 'error') {
      console.warn('[JT] 天眼查直连失败,尝试桥接兜底:', direct.note);
    }
    // reason==='no-key' 或 'error' → 进入桥接兜底
  } catch (e) {
    console.warn('[JT] 天眼查直连异常,尝试桥接兜底:', e.message);
  }

  // ② 桥接兜底(仅当已连接)
  if (typeof JTMcpConnector !== 'undefined' && JTMcpConnector.isConnected()) {
    try {
      const raw = await JTMcpConnector.getCompanyRisk(job);
      if (!raw) return null;
      if (raw.queried != null) return raw; // 已是三态
      if (raw.unifiedCode) return { queried: true, found: true, risk: raw };
      return { queried: true, found: false, note: raw.note || '天眼查未返回该企业工商数据' };
    } catch (e) {
      console.warn('[JT] 桥接查询也失败:', e.message);
    }
  }

  return null; // 直连与桥接都不可用
}

// 把企业风险写回岗位记录(供岗位详情卡片展示),与 persistAiScore 同模式
function persistCompanyRisk(job, companyRisk) {
  if (!companyRisk || !job) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.storage.local.get([JT_CONFIG.storageKeys.jobs], (res) => {
      const jobs = res[JT_CONFIG.storageKeys.jobs] || [];
      let idx = (job.id != null) ? jobs.findIndex(j => j.id === job.id) : -1;
      if (idx < 0) idx = JT_Utils.findDuplicate(jobs, job);
      if (idx < 0) { resolve(null); return; }
      jobs[idx].analysis = jobs[idx].analysis || {};
      jobs[idx].analysis.companyRisk = companyRisk;
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.jobs]: jobs }, () => resolve(jobs[idx]));
    });
  }).catch(err => { console.error('[JT] 持久化企业风险失败:', err); });
}

// ----------------------------------------------------------
// AI 分析缓存(按 岗位身份 + 简历 + 意向 维度,24h TTL)
// ----------------------------------------------------------
function hashStr(s) {
  let h = 0;
  s = String(s == null ? '' : s);
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36);
}

function getAiCacheKey(job, resumeText, jobIntent) {
  const j = job || {};
  // 关键修复:不能只靠 job.url —— 在不换 URL 的 SPA 站点上,切换岗位时 url 不变会导致缓存键碰撞、串岗。
  // 改取岗位自身特征(URL + 标题 + 公司 + 地点)拼接,确保不同岗位即便同 URL 也得到不同键。
  // 去掉 salaryRaw(易波动,导致同岗缓存失效);缓存版本随分析 Schema 升级,避免复用旧版康复强耦合结果。
  const identity = [j.url, j.title, j.company, j.location]
    .map(v => String(v == null ? '' : v))
    .join('|');
  return 'v3:general-fit:' + hashStr(identity) + ':' + hashStr(resumeText) + ':' + hashStr(jobIntent);
}

function readAiCache(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([JT_CONFIG.storageKeys.aiCache], (res) => {
      const map = res[JT_CONFIG.storageKeys.aiCache] || {};
      const item = map[key];
      if (item && typeof item.ts === 'number' && (Date.now() - item.ts) < JT_CONFIG.llm.aiCacheTtlMs) {
        resolve(item.analysis);
      } else {
        resolve(null);
      }
    });
  });
}

function writeAiCache(key, analysis) {
  chrome.storage.local.get([JT_CONFIG.storageKeys.aiCache], (res) => {
    const map = res[JT_CONFIG.storageKeys.aiCache] || {};
    map[key] = { analysis, ts: Date.now() };
    chrome.storage.local.set({ [JT_CONFIG.storageKeys.aiCache]: map });
  });
}

// ----------------------------------------------------------
// LLM 处理:HR 回复
// ----------------------------------------------------------
async function handleReply(hrMessage, intent, style, context) {
  const settings = await getAiSettings();
  if (!settings.apiKey) {
    return { ok: false, error: '尚未配置 API Key,请到设置页填写后再使用 HR 回复助手。', needSettings: true };
  }
  const ctx = {
    resume: settings.resumeText,
    jobIntent: settings.jobIntent,
    jobTitle: context.jobTitle || '',
    extraNotes: settings.extraNotes || ''
  };
  const messages = JTPrompts.buildReplyMessages(hrMessage, intent, style, ctx);
  const llmRes = await callLLM(settings, messages, false);
  if (!llmRes.ok) return llmRes;
  // 推理模型可能把最终回复放在 reasoning 思考里(content 为空或含思考)。取最干净的正文:
  // 优先 content;若 content 来自 reasoning(空壳回退),则取 reasoning 最后一段非空文本作为回复正文。
  let replyText = (llmRes.content && llmRes.content.trim()) || '';
  if (!replyText && llmRes.reasoningRaw) {
    // 推理模型可能把最终回复放在思考里(content 为空):取思考最后一段非空文本作为回复正文
    const parts = llmRes.reasoningRaw.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
    replyText = parts.length ? parts[parts.length - 1] : '';
  }
  if (!replyText) replyText = (llmRes.reasoningRaw || '').trim();
  // 按 === 分隔成多个版本
  const versions = replyText.split(/^===\s*$/m).map(s => s.trim()).filter(Boolean);
  return { ok: true, versions: versions.length ? versions : [replyText] };
}

// ----------------------------------------------------------
// LLM 处理:半自动智能回复(综合岗位+简历+求职意向+聊天历史)
// context 来自 content script 的 JTChatHelper.extractChatContext
// ----------------------------------------------------------
async function handleSmartReply(context) {
  const settings = await getAiSettings();
  if (!settings.apiKey) {
    return { ok: false, error: '尚未配置 API Key,请到设置页填写后再使用 AI 回复助手。', needSettings: true };
  }

  // ---- 从后台岗位库匹配当前岗位 ----
  // 聊天页只提供岗位标题,完整岗位信息(JD/要求/薪资)从已保存的岗位库中匹配
  const chatJobTitle = context.jobTitle || '';
  let matchedJob = null;
  let matchReport = {
    chatJobTitle,
    matched: false,
    matchMethod: 'none',
    savedJobsCount: 0,
    matchedJobTitle: '',
    matchedJobCompany: '',
    hasDescription: false,
    hasRequirement: false,
    candidates: []
  };

  if (chatJobTitle) {
    try {
      const jobsRes = await new Promise((resolve) => {
        chrome.storage.local.get([JT_CONFIG.storageKeys.jobs], (res) => {
          resolve(res[JT_CONFIG.storageKeys.jobs] || []);
        });
      });
      matchReport.savedJobsCount = jobsRes.length;

      // 多级匹配策略:
      // 1. 精确匹配(标题完全相同)
      // 2. 聊天标题包含在已保存标题中(已保存的更长)
      // 3. 已保存标题包含在聊天标题中(聊天的更长)
      // 4. 关键词交集匹配(分词后计算重叠度)
      const titleNorm = chatJobTitle.normalize('NFKC').toLowerCase().trim();

      // 策略1: 精确匹配
      matchedJob = jobsRes.find(j => j.title && j.title.normalize('NFKC').toLowerCase().trim() === titleNorm);
      if (matchedJob) matchReport.matchMethod = 'exact';

      // 策略2: 聊天标题是已保存标题的子串
      if (!matchedJob) {
        matchedJob = jobsRes.find(j => j.title && j.title.normalize('NFKC').toLowerCase().includes(titleNorm));
        if (matchedJob) matchReport.matchMethod = 'chat_substring_of_saved';
      }

      // 策略3: 已保存标题是聊天标题的子串
      if (!matchedJob) {
        matchedJob = jobsRes.find(j => j.title && titleNorm.includes(j.title.normalize('NFKC').toLowerCase()));
        if (matchedJob) matchReport.matchMethod = 'saved_substring_of_chat';
      }

      // 策略4: 关键词重叠匹配(取重叠度最高的)
      if (!matchedJob && jobsRes.length > 0) {
        const chatKeywords = extractKeywords(titleNorm);
        if (chatKeywords.length > 0) {
          let bestScore = 0;
          let bestJob = null;
          const scoredCandidates = [];
          jobsRes.forEach(j => {
            if (!j.title) return;
            const savedKeywords = extractKeywords(j.title.normalize('NFKC').toLowerCase());
            const overlap = chatKeywords.filter(k => savedKeywords.includes(k));
            const score = overlap.length / Math.max(chatKeywords.length, savedKeywords.length);
            scoredCandidates.push({ title: j.title, score: Math.round(score * 100) });
            if (score > bestScore) {
              bestScore = score;
              bestJob = j;
            }
          });
          // 只有重叠度 >= 50% 才算匹配
          if (bestJob && bestScore >= 0.5) {
            matchedJob = bestJob;
            matchReport.matchMethod = 'keyword_overlap_' + Math.round(bestScore * 100) + '%';
          }
          // 记录前 5 个候选(用于调试)
          matchReport.candidates = scoredCandidates
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
        }
      }

      if (matchedJob) {
        matchReport.matched = true;
        matchReport.matchedJobTitle = matchedJob.title || '';
        matchReport.matchedJobCompany = matchedJob.company || '';
        matchReport.hasDescription = !!(matchedJob.description && matchedJob.description.trim());
        matchReport.hasRequirement = !!(matchedJob.requirement && matchedJob.requirement.trim());
      }
    } catch (e) {
      matchReport.matchMethod = 'error: ' + (e.message || e);
    }
  }

  // ---- 构建综合上下文 ----
  const mergedJob = matchedJob || {};
  const ctx = {
    resume: settings.resumeText,
    jobIntent: settings.jobIntent,
    extraNotes: settings.extraNotes || '',
    jobTitle: chatJobTitle || (matchedJob ? matchedJob.title : ''),
    jobDescription: mergedJob.description || '',
    jobRequirement: mergedJob.requirement || '',
    jobSalary: mergedJob.salaryRaw || '',
    chatHistory: context.allMessages || [],
    hrMessage: context.latestHrMessage || '',
    intent: 'other',
    style: settings.chatStyle || 'formal'
  };

  const messages = JTPrompts.buildSmartReplyMessages(ctx);
  const llmRes = await callLLM(settings, messages, false);
  if (!llmRes.ok) return llmRes;

  // 提取回复正文(与 handleReply 相同的推理模型适配逻辑)
  let replyText = (llmRes.content && llmRes.content.trim()) || '';
  if (!replyText && llmRes.reasoningRaw) {
    const parts = llmRes.reasoningRaw.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
    replyText = parts.length ? parts[parts.length - 1] : '';
  }
  if (!replyText) replyText = (llmRes.reasoningRaw || '').trim();

  const versions = replyText.split(/^===\s*$/m).map(s => s.trim()).filter(Boolean);
  return { ok: true, versions: versions.length ? versions : [replyText], matchReport };
}

// 从标题中提取关键词(用于模糊匹配)
function extractKeywords(title) {
  if (!title) return [];
  // 移除常见无意义后缀
  const cleaned = title.replace(/(师|员|工|岗|职位|岗位|实习|全职|兼职|急招|招聘|资深|高级|初级|中级)/g, ' ');
  // 按非字母数字汉字字符分割
  const words = cleaned.split(/[\s\-_\/（）()【】\[\]·,，、;；:：.]+/).filter(w => w.length >= 2);
  return [...new Set(words)];
}

// ----------------------------------------------------------
// LLM 处理:测试连接
// ----------------------------------------------------------
async function handleTest() {
  const settings = await getAiSettings();
  if (!settings.apiKey) return { ok: false, error: '请先填写 API Key' };
  const messages = [
    { role: 'system', content: '你是一个测试助手。' },
    { role: 'user', content: '请回复"连接成功"四个字。' }
  ];
  const llmRes = await callLLM(settings, messages, false);
  if (llmRes.ok) return { ok: true, reply: llmRes.content.slice(0, 50) };
  return llmRes;
}

// ----------------------------------------------------------
// LLM 处理:简历智能分析
// ----------------------------------------------------------
async function handleResumeAnalysis(resumeText, jobIntent) {
  const settings = await getAiSettings();
  if (!settings.apiKey) {
    return { ok: false, error: '尚未配置 API Key,请先在 AI 设置页填写。', needSettings: true };
  }
  if (!resumeText || resumeText.trim().length < 20) {
    return { ok: false, error: '简历文本内容太少,无法分析。请确认文件解析成功。' };
  }
  const messages = JTPrompts.buildResumeAnalysisMessages(resumeText, jobIntent || settings.jobIntent);
  let llmRes = await callLLM(settings, messages, true);
  if (!llmRes.ok) return llmRes;

  // 解析 JSON —— content 优先,reasoning 兜底
  let profile = parseResumeResult(llmRes);

  // 推理模型 content 为空 + reasoning 提取失败 → 自动关思考重试一次
  if (!isCompleteResume(profile) && llmRes._isReasoning && !settings.disableReasoning) {
    console.warn('[JT] 简历分析:推理模型提取失败,自动关思考重试一次');
    const retrySettings = { ...settings, disableReasoning: true };
    const retryRes = await callLLM(retrySettings, messages, true);
    if (retryRes.ok) {
      llmRes = retryRes;
      profile = parseResumeResult(llmRes);
    }
  }

  if (isCompleteResume(profile)) {
    profile = { ...profile, resumeText: resumeText.substring(0, JT_CONFIG.limits.RESUME_TEXT_MAX) };
    return { ok: true, profile };
  }

  // content 无法解析为完整档案 → 明确报错,不解析 reasoning
  let raw = (llmRes.content || '').slice(0, JT_CONFIG.limits.RAW_ERROR_PREVIEW);
  if (llmRes._isReasoning && llmRes.reasoningRaw) {
    raw = '【推理模型:content 为空,以下为 reasoning(思考过程)前 ' + JT_CONFIG.limits.RAW_ERROR_PREVIEW + ' 字符】\n' +
      llmRes.reasoningRaw.slice(0, JT_CONFIG.limits.RAW_ERROR_PREVIEW);
  }
  const lengthHint = (llmRes._finishReason === 'length')
    ? '（finish_reason=length:思考过程用尽了 max_tokens。已在 v1.5.23 增大推理模型 token 上限,若仍出现请改用非推理模型。）'
    : '';
  const reasoningNote = llmRes._isReasoning
    ? '（当前为推理模型,其答案在 reasoning(思考过程)中、content 为空。本插件已自动尝试从思考过程提取完整档案 JSON 并自动关思考重试;若仍失败,请勾选「关闭思考过程」或改用非推理模型如 openai/gpt-4o-mini / deepseek/deepseek-chat。）' + lengthHint
    : lengthHint;
  return {
    ok: false,
    error: '简历解析未返回可用的 JSON 结果。' + reasoningNote,
    raw
  };
}

// 统一解析简历 LLM 返回:content 优先,reasoning 兜底
function parseResumeResult(llmRes) {
  let profile = null;
  try { profile = JSON.parse(llmRes.content); } catch (e) {}
  if (!isCompleteResume(profile)) profile = tryExtractJSON(llmRes.content);
  if (!isCompleteResume(profile) && llmRes.reasoningRaw) {
    const r = extractCompleteFromText(llmRes.reasoningRaw, isCompleteResume);
    if (isCompleteResume(r)) profile = r;
  }
  return profile;
}

// ----------------------------------------------------------
// 核心:调用 OpenAI 兼容接口
// ----------------------------------------------------------
async function callLLM(settings, messages, jsonMode) {
  const provider = JT_CONFIG.llm.providers[settings.provider] || JT_CONFIG.llm.providers.deepseek;
  const baseUrl = (settings.baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
  const model = settings.model || provider.defaultModel;
  // 安全策略:不在代码中内置任何 API Key,必须由用户在设置页填写。
  const apiKey = settings.apiKey || '';
  if (!baseUrl) return { ok: false, error: '未配置 API Base URL' };
  // 安全策略:baseUrl 必须 https,防止 Authorization: Bearer <API Key> 经明文 HTTP 被中间人窃听
  if (!/^https:\/\//i.test(baseUrl)) return { ok: false, error: 'API Base URL 必须使用 HTTPS(' + baseUrl + '),明文 HTTP 会泄露 API Key,请改用 https 地址' };
  if (!model) return { ok: false, error: '未选择模型' };
  if (!apiKey) return { ok: false, error: '未填写 API Key,请到设置页填写后再使用 AI 功能。' };

  // 推理模型(DeepSeek-R1 / OpenAI o1 / Qwen QwQ / 智谱 GLM-5 等):多数不支持/不推荐 response_format=json_object,
  // 且思考内容会挤占 content。改为跳过 JSON 模式,完全依赖提示词约束"只输出 JSON"。
  const isReasoning = JT_CONFIG.llm.isReasoningModel(model);
  // 关闭思考过程(disableReasoning):让用户对"思考模型"主动关掉思维链,模型直接在 content 输出最终答案(通常为标准 JSON)。
  // 此时也跳过 JSON 模式,纯靠提示词约束(避免 response_format 与"关思考"在某些网关冲突)。
  const disableReasoning = !!settings.disableReasoning;
  const useJsonMode = jsonMode && !isReasoning && !disableReasoning;

  const url = baseUrl + '/chat/completions';
  // 推理模型需要更大的 max_tokens:思考过程会消耗大量 token,默认 1200 远不够
  // (GLM-5.2 等会因 token 用尽导致 finish_reason=length、content 为空)
  const maxTokens = isReasoning
    ? (JT_CONFIG.llm.reasoningMaxTokens || 8000)
    : JT_CONFIG.llm.maxTokens;
  const baseBody = {
    model,
    messages,
    temperature: JT_CONFIG.llm.temperature,
    top_p: JT_CONFIG.llm.top_p,
    max_tokens: maxTokens,
    stream: false
  };
  // 关闭思考过程:向网关发送"关思考"指令。不同网关参数名不同,这里同时携带两种常见形式;
  // 不支持的网关会忽略未知字段(多数 OpenAI 兼容网关不报错),若真报 400/422,doFetch 会自动去掉这些参数重试(见 callLLM 重试分支)。
  //  - reasoning.enabled=false :OpenRouter 及部分 OpenAI 兼容网关(混元 tokenhub 等)
  //  - thinking.type=disabled  :智谱/混元风格(如托管的 GLM 系列思考模型)
  if (disableReasoning) {
    baseBody.reasoning = { enabled: false };
    baseBody.thinking = { type: 'disabled' };
  }

  // 第一次尝试:带 response_format(如果 useJsonMode;推理/关思考模型为 false)
  let result = await doFetch(url, baseBody, apiKey, useJsonMode);

  // 429 限流 / 5xx 服务器错误:指数退避重试(最多2次)
  // 批量分析场景下,单次 429 不应中断整批,等待后重试可恢复
  if (!result.ok && result._retryOnStatus) {
    const retryBody = { ...baseBody };
    delete retryBody.response_format;
    delete retryBody.reasoning;
    delete retryBody.thinking;
    for (let attempt = 0; attempt < 2; attempt++) {
      const waitMs = (attempt + 1) * 5000; // 5s, 10s
      await new Promise(r => setTimeout(r, waitMs));
      result = await doFetch(url, retryBody, apiKey, false);
      if (result.ok || !result._retryOnStatus) break;
    }
    return result;
  }

  // 400/422 重试兜底:可能是 response_format 或 reasoning/thinking 参数不被网关支持 → 去掉这些参数重试一次
  if (!result.ok && result._retryable) {
    const retryBody = { ...baseBody };
    delete retryBody.response_format;
    delete retryBody.reasoning;
    delete retryBody.thinking;
    const retry = await doFetch(url, retryBody, apiKey, false);
    if (retry.ok || !retry._retryable) return retry;
    return result;
  }

  return result;
}

// 实际 fetch 封装
async function doFetch(url, body, apiKey, useJsonMode) {
  const finalBody = { ...body };
  if (useJsonMode) {
    finalBody.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JT_CONFIG.llm.timeout);

  try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(finalBody),
        signal: controller.signal
      });
    clearTimeout(timer);

    if (!res.ok) {
      // 防御:个别非标准响应可能无 text() 方法,避免同步抛错中断重试逻辑
      const errText = (typeof res.text === 'function') ? await res.text().catch(() => '') : '';
      // 400/422 通常是 response_format 或 reasoning/thinking 参数不被支持 → 标记可重试(callLLM 会去掉这些参数重试)
      const retryable = (res.status === 400 || res.status === 422);
      if (res.status === 401) return { ok: false, error: 'API Key 无效或已过期(401)' };
      if (res.status === 429) return { ok: false, error: '请求过于频繁或额度不足(429),正在自动重试...', _retryOnStatus: true };
      if (res.status === 404) return { ok: false, error: '接口地址或模型名错误(404),请检查 Base URL 和模型' };
      // 5xx 服务器临时错误:可退避重试
      if (res.status >= 500) return { ok: false, error: `服务器错误(${res.status}),正在自动重试...`, _retryOnStatus: true };
      const errMsg = `请求失败(${res.status}): ${errText.slice(0, 200)}`;
      return retryable ? { ok: false, error: errMsg, _retryable: true } : { ok: false, error: errMsg };
    }

    const data = await res.json();
    // 诊断:保存最近一次原始响应(截断,避免撑爆 storage),供设置页"查看上次 AI 原始响应"排查推理模型返回结构
    try {
      chrome.storage.local.set({
        [JT_CONFIG.storageKeys.aiDebug]: JSON.stringify(data).slice(0, 2000)
      });
    } catch (e) {}
    const choice = data && data.choices && data.choices[0];
    const msg = choice && choice.message;
    // content = 模型的最终答案(推理模型也应放在这里);reasoningRaw = 思考过程(自由文本,仅供参考)。
    // 二者严格分离:绝不用 reasoning 覆盖 content,否则会把思考过程当答案(JSON 任务会解析出 100 分空壳)。
    let content = (msg && msg.content) || '';
    const reasoningRaw = (msg && (msg.reasoning_content || msg.reasoning)) || '';
    if (!content) {
      const diag = {
        finishReason: choice && choice.finish_reason,
        messageKeys: msg ? Object.keys(msg) : [],
        hasReasoning: !!reasoningRaw,
        choicesLen: (data && data.choices && data.choices.length) || 0
      };
      console.error('[JT] 模型返回 content 为空,诊断:', JSON.stringify(diag), 'raw:', JSON.stringify(data).slice(0, 600));
      // content 为空但 reasoning 字段有内容:这是推理模型的典型表现(答案在 reasoning 中,content 为空)。
      // 不再直接报错,而是把 reasoning 交下游校验(analyzeJob / handleResumeAnalysis 的 isComplete* 完整度门禁)。
      // 这样 glm-5.2 等任意网关上的推理模型也能输出可用 JSON,无需预先知道各网关的"关闭思考"参数名。
      // ⚠️ 完整度门禁会拦截"只有思考过程、无结论"的空壳,杜绝 v1.5.29 那样的 100 分空壳(见 v1.5.37 教训)。
      if (reasoningRaw) {
        return { ok: true, content: '', reasoningRaw: reasoningRaw, _fromReasoning: true, _isReasoning: true, _finishReason: choice && choice.finish_reason };
      }
      return { ok: false, error: '模型返回内容为空。（请检查模型是否支持该请求,或先在 AI 设置页点“测试连接”验证连通性。）', diag };
    }
    return {
      ok: true,
      content: content.trim(),
      reasoningRaw: reasoningRaw,
      _isReasoning: JT_CONFIG.llm.isReasoningModel(body.model)
    };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { ok: false, error: '请求超时,请检查网络或代理设置' };
    return { ok: false, error: '网络错误: ' + (e.message || String(e)) + '(可能是代理/网络未通或域名未在权限内)' };
  }
}

// 从可能含杂质文本中提取 JSON(多策略尝试)
function tryExtractJSON(text) {
  if (!text) return null;

  // 去掉 markdown 代码块标记
  let t = text.replace(/```(?:json|JSON)?\s*/gi, '').replace(/```\s*/g, '').trim();

  // 定位最外层 { ... }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let jsonStr = t.substring(start, end + 1);

  // 策略1: 直接解析
  try { return JSON.parse(jsonStr); } catch (e) {}

  // 策略2: 去掉 JS 注释 (// 行注释 和 /* 块注释 */)
  let s2 = jsonStr.replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  try { return JSON.parse(s2); } catch (e) {}

  // 策略3: 去尾逗号 (,] 或 ,})
  let s3 = s2.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s3); } catch (e) {}

  // 策略4: 中文引号 → 英文引号
  let s4 = s3.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  try { return JSON.parse(s4); } catch (e) {}

  // 策略5: 单引号 → 双引号(简单替换,覆盖 key 和 value)
  let s5 = s4.replace(/'/g, '"');
  try { return JSON.parse(s5); } catch (e) {}

  // 策略6: 修复字符串内未转义换行(把 "..." 内的裸 \n 替换为 \\n)
  let s6 = s5.replace(/"([^"\\]*)"/g, (match) => {
    return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  });
  try { return JSON.parse(s6); } catch (e) {}

  return null;
}

// 从"混杂自由文本"中提取所有完整 {...} 块(括号平衡扫描,支持嵌套),逐个用容错解析,
// 再用 validator 校验,返回第一个通过的对象。
// 用于推理模型把"完整 JSON 答案"藏在 reasoning 多段文本(草稿在前、真答案在后)时的兜底提取。
function extractCompleteFromText(text, validator) {
  if (!text || typeof validator !== 'function') return null;
  // 去掉 markdown 代码块标记,避免 ``` 干扰括号计数
  const t = text.replace(/```(?:json|JSON)?\s*/gi, '').replace(/```\s*/g, '');
  const blocks = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; }
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) { blocks.push(t.substring(start, i + 1)); start = -1; }
    }
  }
  // 兜底:若上面的扫描没产出(如花括号不匹配),退回最外层 { ... } 区间
  if (blocks.length === 0) {
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s >= 0 && e > s) blocks.push(t.substring(s, e + 1));
  }
  for (const b of blocks) {
    const obj = tryExtractJSON(b);
    if (obj && validator(obj)) return obj;
  }
  return null;
}

// 最终兜底:用正则从纯文本中提取关键字段
function extractFieldsFallback(text) {
  if (!text) return null;
  const result = { _fallback: true, fitReasons: [], gaps: [], suggestions: [], risks: [] };

  let found = false;

  // fitScore: 匹配 "fitScore": 75 或 适配度: 75 或 评分：75
  const scoreMatch = text.match(/(?:fitScore|"fitScore"|适配度|匹配度|评分)[^\d]*(\d{1,3})/i);
  if (scoreMatch) { result.fitScore = Math.min(100, parseInt(scoreMatch[1])); found = true; }

  // overallRisk
  const riskMatch = text.match(/(?:overallRisk|整体风险|风险等级)[^高高中低]*(高|中|低)/i);
  if (riskMatch) { result.overallRisk = riskMatch[1]; found = true; }

  // summary
  const summaryMatch = text.match(/(?:summary|"summary"|总体评价|总结)[：:]\s*([^\n}{]+)/i);
  if (summaryMatch) { result.summary = summaryMatch[1].trim().replace(/["'，。]$/, ''); found = true; }

  if (!found) return null;
  if (!result.summary) result.summary = '(模型返回格式不标准,仅提取到部分信息,建议重试或换模型)';
  return result;
}

// ----------------------------------------------------------
// 解析健壮性:完整度校验
// 目的:杜绝把推理模型的"思考过程草稿"(常含 fitScore:100 但无结论)当作有效分析结果。
// ----------------------------------------------------------

// 统一分析结果形状:保留旧字段,为通用岗位分析新增字段补安全默认值。
// 旧版历史结果不强制迁移,仍可渲染；新分析结果通过 analysisVersion=2 标识。
function normalizeAnalysisResult(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const normalized = { ...obj };
  ['fitReasons', 'transferableStrengths', 'entryBarriers', 'gaps', 'suggestions', 'risks'].forEach((key) => {
    if (!Array.isArray(normalized[key])) normalized[key] = [];
  });
  if (!Number.isInteger(normalized.analysisVersion)) normalized.analysisVersion = 1;
  return normalized;
}

// 岗位分析 JSON 是否完整(0-100 分数 + 结论 + 至少 1 个有效要点数组)
// 同时兼容旧版字段和通用岗位分析 v2 新字段。
function isCompleteAnalysis(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const hasScore = typeof obj.fitScore === 'number' && Number.isFinite(obj.fitScore)
    && obj.fitScore >= 0 && obj.fitScore <= 100;
  const hasSummary = typeof obj.summary === 'string' && obj.summary.trim().length > 0
    && obj.summary.indexOf('仅提取到部分信息') < 0;
  if (!hasScore || !hasSummary) return false;

  const arrayFields = [
    obj.fitReasons,
    obj.transferableStrengths,
    obj.entryBarriers,
    obj.gaps,
    obj.suggestions,
    obj.risks
  ];

  // v2 使用严格 Schema 校验；数组允许为空，避免把“未发现风险”误判为解析失败。
  if (obj.analysisVersion === 2) {
    const relationTypes = ['直接匹配', '相邻转岗', '跨行可迁移', '关系较弱', '基本不匹配', '信息不足'];
    const recommendations = ['优先投递', '可以投递', '谨慎投递', '不建议投递', '补充信息后再判断'];
    const riskLevels = ['高', '中', '低', '信息不足'];
    return Number.isInteger(obj.fitScore)
      && relationTypes.includes(obj.relationType)
      && typeof obj.relationSummary === 'string' && obj.relationSummary.trim().length > 0
      && recommendations.includes(obj.recommendation)
      && riskLevels.includes(obj.overallRisk)
      && arrayFields.every(Array.isArray);
  }

  // 兼容 v1 历史结果：至少有一个非空要点数组，继续防止“分数+总结”草稿被误收。
  return arrayFields.some(v => Array.isArray(v) && v.length > 0);
}

// 宽松校验:推理模型可能因 max_tokens 截断只输出了 fitScore + summary(无数组)。
// 仅用于 reasoning 兜底提取,接受降级结果(有分数和结论即可),并在结果上标记 _partial。
function isPartialAnalysis(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const hasScore = typeof obj.fitScore === 'number' && Number.isFinite(obj.fitScore)
    && obj.fitScore >= 0 && obj.fitScore <= 100;
  const hasSummary = typeof obj.summary === 'string' && obj.summary.trim().length > 0
    && obj.summary.indexOf('仅提取到部分信息') < 0;
  return hasScore && hasSummary;
}

// 统一解析 LLM 返回:先从 content 解析,再从 reasoning 完整提取,最后宽松提取。
// 返回解析后的对象(可能带 _partial 标记)或 null。
function parseAnalysisResult(llmRes) {
  let parsed = safeParseAnalysis(llmRes.content);
  if (!parsed && llmRes.reasoningRaw) {
    // 1. 完整提取(分数 + 结论 + 至少 1 个要点数组)
    const r = extractCompleteFromText(llmRes.reasoningRaw, isCompleteAnalysis);
    if (r) return normalizeAnalysisResult(r);
    // 2. 宽松提取:推理模型可能因 token 截断只输出了部分字段(fitScore + summary)
    const r2 = extractCompleteFromText(llmRes.reasoningRaw, isPartialAnalysis);
    if (r2) {
      r2._partial = true; // 标记为降级结果(缺要点数组)
      // 补齐空数组,避免下游渲染 undefined
      return normalizeAnalysisResult(r2);
    }
  }
  return parsed;
}

// 简历档案 JSON 是否完整(姓名 + 至少一项其他信息)
function isCompleteResume(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (typeof obj.name !== 'string' || !obj.name.trim()) return false;
  const hasArr = (arr) => Array.isArray(arr) && arr.length > 0;
  const extras = [
    obj.phone, obj.education, obj.school, obj.major, obj.email,
    hasArr(obj.certifications), hasArr(obj.skills)
  ];
  return extras.some(v => (typeof v === 'string' && v.trim()) || v === true);
}

// 从 content 安全解析分析 JSON:仅接受完整结果,否则返回 null(不静默产出假数据)
function safeParseAnalysis(text) {
  if (!text) return null;
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) {}
  if (!obj) obj = tryExtractJSON(text);
  return isCompleteAnalysis(obj) ? normalizeAnalysisResult(obj) : null;
}

// ----------------------------------------------------------
// AI 设置读取(background 用,不复用 storage.js)
// ----------------------------------------------------------
function getAiSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([JT_CONFIG.storageKeys.aiSettings, JT_CONFIG.storageKeys.aiKeys], (res) => {
      // 默认值统一从 config.js 引用，保持与 storage.js 同步
      const stored = res[JT_CONFIG.storageKeys.aiSettings] || {};
      const merged = { ...JT_CONFIG.defaultAiSettings, ...stored };
      const providerKeys = res[JT_CONFIG.storageKeys.aiKeys] || {};

      // v1.5.55 通用化迁移:只清理精确等于历史内置默认值的康复意向。
      // 用户主动填写的任何求职意向（包括康复方向）都必须保留。
      const legacyJobIntent = '求职意向示例：前端开发岗位，一线城市优先，接受应届生';
      if (stored.jobIntent === legacyJobIntent) {
        merged.jobIntent = JT_CONFIG.defaultAiSettings.jobIntent;
      }

      // 迁移:旧的单一 apiKey -> 按服务商存入 providerKeys(仅一次)
      if (merged.apiKey && merged.provider) {
        if (!providerKeys[merged.provider]) providerKeys[merged.provider] = merged.apiKey;
        const toSet = { [JT_CONFIG.storageKeys.aiKeys]: providerKeys };
        delete merged.apiKey;
        toSet[JT_CONFIG.storageKeys.aiSettings] = merged;
        chrome.storage.local.set(toSet);
      }

      // 按当前服务商解析 Key:仅使用用户已保存的 Key。安全策略:不使用内置默认 Key。
      if (!merged.apiKey) {
        merged.apiKey = providerKeys[merged.provider] || '';
      }
      resolve(merged);
    });
  });
}

// ----------------------------------------------------------
// 岗位去重保存
// 统一使用 JT_Utils.jobKey 做去重(background 与 storage 共用同一逻辑)
// 支持墓碑机制:已被用户删除的岗位不会被重新加入(防止"删了又回来")
// ----------------------------------------------------------
async function saveJobDedup(job) {
  return new Promise((resolve) => {
    if (!job || (!job.url && !job.title)) { resolve({ action: 'error', error: '岗位信息不完整，无法去重保存' }); return; }
    // content/parser 正常会生成 id；MCP/导入等边界输入缺 id 时在入库口统一补齐。
    if (!job.id) {
      job.id = 'jt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
    }
    chrome.storage.local.get([JT_CONFIG.storageKeys.jobs, JT_CONFIG.storageKeys.deletedJobs], (res) => {
      const jobs = res[JT_CONFIG.storageKeys.jobs] || [];
      const deletedKeys = res[JT_CONFIG.storageKeys.deletedJobs] || [];

      // 墓碑检查:该岗位已被用户删除 → 不复活,返回 skipped
      const jobKey = JT_Utils.jobKey(job);
      if (jobKey && deletedKeys.includes(jobKey)) {
        resolve({ action: 'skipped', reason: 'tombstone' });
        return;
      }

      const existIdx = JT_Utils.findDuplicate(jobs, job);
      if (existIdx >= 0) {
        // 已存在:更新岗位字段但保留用户手动设置的 status/notes/id/capturedAt
        // 以及既有 AI 分析结果(aiFitScore/aiAnalysis/aiAnalyzedAt),避免更新时丢失 AI 分
        jobs[existIdx] = JT_Utils.mergeJobForUpdate(jobs[existIdx], job);
        chrome.storage.local.set({ [JT_CONFIG.storageKeys.jobs]: jobs }, () => {
          resolve({ action: 'updated', job: jobs[existIdx] });
        });
      } else {
        jobs.unshift(job);
        chrome.storage.local.set({ [JT_CONFIG.storageKeys.jobs]: jobs }, () => {
          resolve({ action: 'added', job });
        });
      }
    });
  });
}

// ==========================================================
// 自动扫描:SW 最小职责(仅定时唤醒 + 配置/状态查询 + 薄封装)
// v1.5.20:扫描执行逻辑已迁移到前端 lib/scan-controller.js
//   SW 不再跑长循环 / 开 tab / 等延迟(MV3 SW 会被杀,导致静默死亡)
// ==========================================================

// 自动扫描配置读取(SW 直接用 chrome.storage,无 JTStorage)
function getAutoScan() {
  return new Promise((resolve) => {
    chrome.storage.local.get([JT_CONFIG.storageKeys.autoScan], (res) => {
      const stored = res[JT_CONFIG.storageKeys.autoScan] || {};
      const merged = JTAutoScan.merge(stored);
      // 与前端迁移一致：历史内置康复关键词在 SW 中按行业中立空值处理。
      // SW 不回写，避免与设置页并发保存产生跨上下文覆盖。
      if (stored.keywords === '康复 推拿') merged.keywords = JT_CONFIG.defaultAutoScan.keywords;
      resolve(merged);
    });
  });
}

// 批量去重保存(薄封装,供浮动扫描按钮 / 前端控制器调用)
async function saveJobsBatch(jobs) {
  let added = 0, updated = 0;
  for (const job of jobs) {
    const r = await saveJobDedup(job);
    if (r.action === 'added') added++;
    else if (r.action === 'updated') updated++;
  }
  return { ok: true, added, updated };
}

// 查找已打开的 dashboard / BOSS 页面,唤醒前端执行扫描
async function wakeFrontendToScan() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      // 优先找已打开的 dashboard
      const dashTab = tabs.find(t => t.url && t.url.includes('dashboard/dashboard.html'));
      if (dashTab) {
        // 发消息唤醒 dashboard 扫描,不等其 sendResponse(扫描是耗时操作,等响应会挂起)
        chrome.tabs.sendMessage(dashTab.id, { type: 'JT_SCAN_START_FROM_ALARM' }, () => {
          // 忽略 lastError:dashboard 可能未加载 scan-controller,或正在扫描中
          void chrome.runtime.lastError;
        });
        // 立即返回,不阻塞(扫描在前端异步执行)
        resolve({ ok: true, via: 'existing_dashboard' });
        return;
      }
      // 没找到 dashboard,打开一个可见的 dashboard tab
      chrome.tabs.create({ url: 'dashboard/dashboard.html#autoscan', active: true }, () => {
        resolve({ ok: true, via: 'new_dashboard' });
      });
    });
  });
}

// 确保闹钟与配置一致
// 注意:v1.5.30 起「定时自动扫描」已停用,扫描只支持手动触发(立即扫描一轮 / 列表页浮动按钮)。
// 因此这里只负责清除可能由旧版本残留的定时闹钟,绝不再创建新的自动扫描闹钟。
async function ensureAutoScanAlarm() {
  await new Promise(r => chrome.alarms.clear('jt_auto_scan', r));
}

// 状态查询(给 dashboard / 设置页)
async function getAutoScanStatus() {
  const cfg = await getAutoScan();
  let nextFireTime = 0;
  try {
    const a = await new Promise(r => chrome.alarms.get('jt_auto_scan', r));
    nextFireTime = (a && a.scheduledTime) || 0;
  } catch (e) {}
  return {
    ok: true,
    enabled: !!cfg.enabled,
    lastScanAt: cfg.lastScanAt || 0,
    nextFireTime,
    totalCollected: cfg.totalCollected || 0,
    analyzedToday: cfg.analyzedToday || 0,
    analyzePerDay: cfg.analyzePerDay || 0,
    lastScanAdded: cfg.lastScanAdded || 0,
    intervalMin: cfg.intervalMin || 0,
    maxJobsPerRun: cfg.maxJobsPerRun || 0
  };
}

// 闹钟触发 → 唤醒前端执行扫描(不自己跑)
// v1.5.30 起定时自动扫描已停用,此处仅作为兜底:即便存在残留闹钟也直接忽略,绝不自动扫描。
if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'jt_auto_scan') {
      console.log('[JT] 定时自动扫描已停用,忽略自动闹钟(仅手动触发扫描)');
    }
  });
}

// 自动扫描配置变化 → 重建闹钟
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[JT_CONFIG.storageKeys.autoScan]) ensureAutoScanAlarm();
  });
}

// 图标角标
function updateBadge() {
  chrome.storage.local.get([JT_CONFIG.storageKeys.jobs], (res) => {
    const count = (res[JT_CONFIG.storageKeys.jobs] || []).length;
    const text = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  });
}

function showNotification(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png', title, message: message || '', priority: 1
    });
  } catch (e) { /* 忽略 */ }
}
