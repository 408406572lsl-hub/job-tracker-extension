// ============================================================
// content.js — 内容脚本
// 提取岗位数据供 popup 手动记录,为列表页卡片注入匹配徽章
// 纯手动模式:不自动记录任何岗位,用户手动点击 popup 中的"记录此岗位"才入库
// ============================================================

(function () {
  'use strict';

  // 本地转义:防护浮层 innerHTML 拼接第三方网页内容(DOM XSS)
  // 来源如 BOSS 页面抓取的岗位标题/聊天消息/表单 class 等属不可信内容,必须转义后再拼 HTML
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 防止重复初始化
  if (window.__JT_CONTENT_LOADED__) return;
  window.__JT_CONTENT_LOADED__ = true;

  let currentFilters = null;
  let showBadges = true;
  let lastUrl = location.href;
  let urlChangeTimer = null;
  let contentObserver = null;
  let observerTimer = null;
  let resumeProfile = null;

  // ----------------------------------------------------------
  // 初始化
  // ----------------------------------------------------------
  function init() {
    chrome.storage.local.get(
      [JT_CONFIG.storageKeys.filters, JT_CONFIG.storageKeys.settings],
      (res) => {
        currentFilters = res[JT_CONFIG.storageKeys.filters] || JT_CONFIG.defaultFilters;
        const settings = res[JT_CONFIG.storageKeys.settings] || { showBadges: true };
        showBadges = settings.showBadges !== false;

        // 首次处理当前页(仅注入徽章和检测表单,不自动记录)
        handleCurrentPage();
      }
    );

    // 监听筛选条件 / 设置变化
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[JT_CONFIG.storageKeys.filters]) {
        currentFilters = changes[JT_CONFIG.storageKeys.filters].newValue || JT_CONFIG.defaultFilters;
        if (showBadges && JTParser.isPureListPage()) refreshBadges();
      }
      if (changes[JT_CONFIG.storageKeys.settings]) {
        const s = changes[JT_CONFIG.storageKeys.settings].newValue || {};
        showBadges = s.showBadges !== false;
      }
    });

    // 监听来自 popup/background 的消息
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'JT_GET_PAGE_JOB') {
        // popup 请求获取当前页岗位 —— 实时提取,不返回缓存
        const job = JTParser.getActiveJob();
        if (job) {
          const result = JTFilters.evaluate(job, currentFilters);
          // 附加 DOM 诊断信息(仅调试用)
          job._debug = JTParser.getDomDiagnostics ? JTParser.getDomDiagnostics() : null;
          sendResponse({
            job: { ...job, score: result.score, matchReasons: result.reasons },
            evaluation: result
          });
        } else {
          // 无法确定当前岗位(列表页无选中项,或非招聘页)
          const reason = JTParser.isPureListPage() ? 'list_page' : 'unknown';
          sendResponse({ job: null, reason });
        }
        return true;
      }
      // v1.5.3 调试后门:返回完整诊断报告(含选择器匹配详情 + 容器原始文本)
      if (msg.type === 'JT_GET_FULL_DIAG') {
        const job = JTParser.getActiveJob();
        const report = JTParser.getFullDiagnosticReport
          ? JTParser.getFullDiagnosticReport(job)
          : { error: 'getFullDiagnosticReport 不可用', _debug: job?._debug || null };
        sendResponse({ report });
        return true;
      }
      if (msg.type === 'JT_RESCAN') {
        handleCurrentPage();
        sendResponse({ ok: true });
        return true;
      }
      // —— 自动填表 ——
      if (msg.type === 'JT_FILL_FORM') {
        const result = JTFormFiller.fillForm(msg.profile || resumeProfile);
        sendResponse(result);
        return true;
      }
      // —— 检测页面表单 ——
      if (msg.type === 'JT_DETECT_FORM') {
        const forms = JTFormFiller.detectForms();
        sendResponse({
          found: forms.length,
          fields: forms.reduce((sum, f) => sum + f.fields.length, 0),
          details: forms.map(f => f.fields.map(fd => fd.label))
        });
        return true;
      }
      // —— 自动扫描:采集本页所有岗位卡片 ——
      if (msg.type === 'JT_COLLECT_LIST_REQ' || msg.type === 'JT_SCAN_PAGE') {
        try {
          const cards = JTParser.findJobCards();
          const jobs = cards.map(c => JTParser.parseJobFromCard(c)).filter(Boolean);
          sendResponse({ ok: true, jobs, count: jobs.length });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e), jobs: [] });
        }
        return true;
      }
      // —— 自动扫描:检查是否有下一页 ——
      if (msg.type === 'JT_SCAN_HAS_NEXT') {
        try {
          // BOSS 下一页按钮:常见选择器
          const nextBtn = document.querySelector('.ui-icon-arrow-right, a[class*="next"], button[class*="next"], [class*="next-page"]');
          const hasNext = !!(nextBtn && !nextBtn.classList.contains('disabled') && !nextBtn.hasAttribute('disabled'));
          sendResponse({ ok: true, hasNext });
        } catch (e) {
          sendResponse({ ok: true, hasNext: false });
        }
        return true;
      }
      // —— 自动扫描:跳到下一页 ——
      if (msg.type === 'JT_SCAN_NEXT_PAGE') {
        try {
          const nextBtn = document.querySelector('.ui-icon-arrow-right, a[class*="next"], button[class*="next"], [class*="next-page"]');
          if (nextBtn && !nextBtn.classList.contains('disabled') && !nextBtn.hasAttribute('disabled')) {
            nextBtn.click();
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'no next page' });
          }
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return true;
      }
      // —— 自动扫描:前端控制器请求启动扫描 ——
      if (msg.type === 'JT_SCAN_START') {
        // 在 BOSS 页面:直接采集当前页并发回
        try {
          const cards = JTParser.findJobCards();
          const jobs = cards.map(c => JTParser.parseJobFromCard(c)).filter(Boolean);
          sendResponse({ ok: true, jobs, count: jobs.length });
        } catch (e) {
          sendResponse({ ok: false, error: String(e), jobs: [] });
        }
        return true;
      }
      // —— 半自动回复:抓取聊天上下文(供 popup/MCP 远程调用) ——
      if (msg.type === 'JT_CHAT_GET_CONTEXT') {
        try {
          const ctx = JTChatHelper.extractChatContext(msg.maxMessages || 20);
          sendResponse({ ok: true, context: ctx });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        return true;
      }
      // —— 半自动回复:调试信息(供 popup/MCP 远程调用) ——
      if (msg.type === 'JT_CHAT_DEBUG') {
        try {
          const info = JTChatHelper.getChatDebugInfo();
          sendResponse({ ok: true, info });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        return true;
      }
    });

    // 监听 SPA URL 变化 —— 这是修复"不知道在访问哪个"的核心
    setupSpaUrlListener();
  }

  // ----------------------------------------------------------
  // SPA URL 变化监听
  // 拦截 history.pushState/replaceState + popstate + 轮询兜底
  // ----------------------------------------------------------
  function setupSpaUrlListener() {
    // 拦截 pushState / replaceState
    const wrap = (type) => {
      const orig = history[type];
      history[type] = function (...args) {
        const rv = orig.apply(this, args);
        window.dispatchEvent(new Event('jt_urlchange'));
        return rv;
      };
    };
    try { wrap('pushState'); } catch (e) {}
    try { wrap('replaceState'); } catch (e) {}
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('jt_urlchange')));

    window.addEventListener('jt_urlchange', onUrlChange);

    // 轮询兜底(某些站点用非标准方式改 URL)
    // 保存 interval ID,页面卸载时清理,避免 SPA 长驻页面累积定时器
    const pollTimer = setInterval(() => {
      if (location.href !== lastUrl) onUrlChange();
    }, 1000);
    window.addEventListener('pagehide', () => clearInterval(pollTimer));
  }

  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === lastUrl) return;
    lastUrl = newUrl;

    // 防抖:SPA 切换后内容异步加载,等 DOM 稳定再处理
    if (urlChangeTimer) clearTimeout(urlChangeTimer);
    urlChangeTimer = setTimeout(() => {
      handleCurrentPage();
    }, JT_CONFIG.timing.SPA_URL_DEBOUNCE);
  }

  // ----------------------------------------------------------
  // 处理当前页:仅在招聘网站注入徽章,表单填充在所有站点生效
  // 纯手动模式:不自动记录岗位
  // ----------------------------------------------------------
  function handleCurrentPage() {
    // 先清理上一页残留
    clearBadges();
    JTFormFiller.removeFillButton();
    if (contentObserver) { contentObserver.disconnect(); contentObserver = null; }

    // 非招聘网站:跳过岗位识别,仅检测表单
    if (!JTParser.isJobSite()) {
      checkAndInjectFillButton();
      return;
    }

    // 列表页:注入徽章
    if (showBadges && JTParser.isPureListPage()) {
      setTimeout(() => { injectBadges(); }, 500);
    }

    // 启动 DOM 变化监听(仅用于徽章刷新和表单检测)
    observeContentChanges();

    // 检测表单 → 注入填表按钮
    checkAndInjectFillButton();

    // BOSS 搜索/列表页:注入浮动扫描按钮
    injectScanButton();

    // BOSS 聊天页:注入 AI 半自动回复按钮
    injectChatReplyButton();
  }

  // ----------------------------------------------------------
  // 简历档案 → 检测表单并注入自动填表按钮
  // ----------------------------------------------------------
  function checkAndInjectFillButton() {
    // 从 background 获取档案
    chrome.runtime.sendMessage({ type: 'JT_GET_PROFILE' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok || !res.profile) return;
      if (!res.profile.name && !res.profile.phone) return; // 档案信息不足
      resumeProfile = res.profile;

      // 延迟检测(等页面表单加载完)
      setTimeout(() => {
        const forms = JTFormFiller.detectForms();
        if (forms.length > 0) {
          JTFormFiller.injectFillButton(resumeProfile, () => {
            const result = JTFormFiller.fillForm(resumeProfile);
            if (result.filled > 0) {
              showCaptureToast(`已自动填充 ${result.filled} 个字段,请检查后提交`, 'success');
            } else {
              showCaptureToast('未能自动填充任何字段', 'info');
            }
          });
        }
      }, JT_CONFIG.timing.FILL_BUTTON_DELAY);
    });
  }

  // ----------------------------------------------------------
  // 列表页徽章注入
  // ----------------------------------------------------------
  function injectBadges() {
    const cards = JTParser.findJobCards();
    cards.forEach(card => {
      if (card.querySelector('.jt-badge')) return; // 已注入
      const job = JTParser.parseJobFromCard(card);
      if (!job) return;
      const evalResult = JTFilters.evaluate(job, currentFilters);
      const level = JTFilters.getMatchLevel(evalResult.score);

      const badge = document.createElement('div');
      badge.className = `jt-badge jt-badge-${level}`;
      badge.innerHTML = `
        <span class="jt-badge-score">${evalResult.score}</span>
        <span class="jt-badge-label">${JTFilters.LEVEL_LABELS[level]}</span>
      `;
      badge.title = evalResult.reasons.join('\n');
      badge.dataset.jtUrl = job.url;

      // 点击徽章跳到详情
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 校验为 http/https,阻断 javascript:/data: 等伪协议(字体反爬下 link.href 可能是原始字符串)
        const safe = JT_Utils.normalizeUrl(job.url);
        if (safe) window.open(safe, '_blank');
      });

      // 插入到卡片内
      card.style.position = card.style.position || 'relative';
      card.appendChild(badge);

      // 高亮推荐岗位
      if (level === 'high') {
        card.classList.add('jt-highlight-high');
      }
    });
  }

  // 刷新徽章(筛选条件变化时)
  function refreshBadges() {
    clearBadges();
    injectBadges();
  }

  // 清理徽章
  function clearBadges() {
    document.querySelectorAll('.jt-badge').forEach(b => b.remove());
    document.querySelectorAll('.jt-highlight-high').forEach(c => c.classList.remove('jt-highlight-high'));
  }

  // ----------------------------------------------------------
  // 浮动扫描按钮(BOSS 搜索/列表页)
  // 用户点击后采集当前页所有卡片,自动翻页,批量入库
  // ----------------------------------------------------------
  function injectScanButton() {
    // 仅在 BOSS 直聘列表页注入
    if (!location.hostname.includes('zhipin.com')) return;
    if (!JTParser.isPureListPage()) return;
    // 已注入则跳过
    if (document.getElementById('jt-scan-fab')) return;

    const btn = document.createElement('button');
    btn.id = 'jt-scan-fab';
    btn.className = 'jt-scan-fab';
    btn.innerHTML = '<span class="jt-scan-fab-icon">🤖</span><span class="jt-scan-fab-text">扫描本轮</span>';
    btn.title = '采集本页及后续页面岗位,自动入库';

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.classList.add('jt-scan-fab-active');
      const textEl = btn.querySelector('.jt-scan-fab-text');
      let totalAdded = 0;
      let page = 1;
      const maxPages = 5;

      try {
        while (page <= maxPages) {
          textEl.textContent = `采集中(${page}页)…`;

          // 采集当前页
          const cards = JTParser.findJobCards();
          if (!cards || cards.length === 0) break;
          const jobs = cards.map(c => JTParser.parseJobFromCard(c)).filter(Boolean);
          if (!jobs.length) break;

          // 归一化 + 发给 background 去重保存
          const norm = JTAutoScan.normalizeCollected(jobs);
          const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'JT_SAVE_JOBS_BATCH', jobs: norm }, resolve);
          });
          if (res && res.ok) {
            totalAdded += res.added;
          }

          textEl.textContent = `第${page}页 +${res ? res.added : 0}(共+${totalAdded})`;

          // 翻页
          const nextBtn = document.querySelector('.ui-icon-arrow-right, a[class*="next"], button[class*="next"], [class*="next-page"]');
          if (!nextBtn || nextBtn.classList.contains('disabled') || nextBtn.hasAttribute('disabled')) break;
          nextBtn.click();
          // 等待页面渲染
          await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
          page++;
        }

        textEl.textContent = `完成!新增${totalAdded}个`;
        showCaptureToast(`扫描完成,本轮新增 ${totalAdded} 个岗位`, 'success');
      } catch (e) {
        textEl.textContent = '扫描出错';
        showCaptureToast('扫描出错:' + (e.message || e), 'info');
      } finally {
        btn.classList.remove('jt-scan-fab-active');
        setTimeout(() => {
          btn.disabled = false;
          textEl.textContent = '扫描本轮';
        }, 3000);
      }
    });

    document.body.appendChild(btn);
  }

  // ----------------------------------------------------------
  // AI 半自动回复按钮(BOSS 聊天页)
  // 点击后:抓取聊天上下文 → 调用 LLM 生成回复 → 展示选项 → 填充到输入框
  // 发送动作由用户手动完成
  // ----------------------------------------------------------
  function injectChatReplyButton() {
    // 仅在 BOSS 聊天页注入
    if (!JTChatHelper.isBossChatPage()) return;
    // 已注入则跳过
    if (document.getElementById('jt-chat-reply-fab')) return;

    const btn = document.createElement('button');
    btn.id = 'jt-chat-reply-fab';
    btn.className = 'jt-chat-reply-fab';
    btn.innerHTML = '<span class="jt-chat-reply-icon">💬</span><span class="jt-chat-reply-text">AI 回复</span>';
    btn.title = '读取聊天上下文,综合岗位+简历信息生成回复';

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const textEl = btn.querySelector('.jt-chat-reply-text');
      const origText = textEl.textContent;

      try {
        // 步骤1:直接调用 JTChatHelper 抓取聊天上下文(岗位详情由 background 从岗位库匹配)
        textEl.textContent = '读取聊天…';
        const ctx = JTChatHelper.extractChatContext(20);

        if (!ctx || (!ctx.allMessages.length && !ctx.latestHrMessage)) {
          showCaptureToast('未读取到聊天消息,请确认当前在聊天页且已选中对话', 'info');
          return;
        }

        // 步骤2:调用 background 生成回复(这一步需要 LLM,必须经过 background)
        textEl.textContent = '生成回复中…';
        const replyRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'JT_LLM_SMART_REPLY',
            context: ctx
          }, resolve);
        });

        if (!replyRes || !replyRes.ok) {
          if (replyRes && replyRes.needSettings) {
            showCaptureToast('请先在设置页配置 API Key 和简历', 'info');
          } else {
            showCaptureToast('生成回复失败: ' + (replyRes?.error || '未知错误'), 'info');
          }
          return;
        }

        // 步骤3:展示回复选项面板(含岗位匹配报告)
        showReplyPanel(replyRes.versions, ctx, replyRes.matchReport);
      } catch (e) {
        showCaptureToast('AI 回复出错: ' + (e.message || e), 'info');
      } finally {
        btn.disabled = false;
        textEl.textContent = origText;
      }
    });

    document.body.appendChild(btn);

    // 注入调试按钮(紧邻 AI 回复按钮)
    injectChatDebugButton();
  }

  // ----------------------------------------------------------
  // 聊天页调试按钮 — 点击后直接在页面上展示 DOM 检测信息
  // ----------------------------------------------------------
  function injectChatDebugButton() {
    if (document.getElementById('jt-chat-debug-fab')) return;

    const btn = document.createElement('button');
    btn.id = 'jt-chat-debug-fab';
    btn.className = 'jt-chat-debug-fab';
    btn.innerHTML = '<span class="jt-chat-debug-icon">🔧</span><span class="jt-chat-debug-text">调试</span>';
    btn.title = '检测聊天页 DOM 结构,输出调试信息(用于选择器调整)';

    btn.addEventListener('click', () => {
      const info = JTChatHelper.getChatDebugInfo();
      const chatCtx = JTChatHelper.extractChatContext(20);
      showDebugPanel(info, chatCtx);
    });

    document.body.appendChild(btn);
  }

  // ----------------------------------------------------------
  // 调试信息面板 — 展示 DOM 检测结果和候选元素
  // ----------------------------------------------------------
  function showDebugPanel(info, chatCtx) {
    const existing = document.getElementById('jt-debug-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'jt-debug-panel';
    panel.className = 'jt-reply-panel';

    const header = document.createElement('div');
    header.className = 'jt-reply-panel-header';
    header.innerHTML = `
      <span class="jt-reply-panel-title">聊天页调试信息</span>
      <span class="jt-reply-panel-close">✕</span>
    `;
    panel.appendChild(header);

    const list = document.createElement('div');
    list.className = 'jt-reply-panel-list';

    // ---- 当前岗位标题 ----
    const jobItem = document.createElement('div');
    jobItem.className = 'jt-reply-version' + (info.jobTitle ? ' jt-reply-version-recommended' : '');
    if (info.jobTitle) {
      jobItem.innerHTML = `
        <div class="jt-reply-version-label">📋 当前岗位标题</div>
        <div class="jt-reply-version-text">${escapeHtml(info.jobTitle)}</div>
        <div class="jt-reply-version-text" style="margin-top:4px;color:#6b7280;font-size:11px;">AI 回复时会用此标题去后台岗位库匹配完整信息</div>
      `;
    } else {
      jobItem.innerHTML = `
        <div class="jt-reply-version-label">❌ 未检测到岗位标题</div>
        <div class="jt-reply-version-text">请确认当前在 BOSS 聊天页且已选中对话</div>
      `;
    }
    list.appendChild(jobItem);

    // ---- 聊天消息内容(核心) ----
    const chatItem = document.createElement('div');
    chatItem.className = 'jt-reply-version';
    if (chatCtx && chatCtx.allMessages && chatCtx.allMessages.length > 0) {
      const hrCount = chatCtx.allMessages.filter(m => m.role === 'hr').length;
      const selfCount = chatCtx.allMessages.length - hrCount;
      const parts = [
        `<div class="jt-reply-version-label">💬 聊天消息(共${chatCtx.allMessages.length}条 | HR ${hrCount}条 | 我 ${selfCount}条)</div>`
      ];

      // 展示最近 10 条消息(含 class 诊断)
      const recent = chatCtx.allMessages.slice(-10);
      const msgParts = [];
      recent.forEach((m, i) => {
        const prefix = m.role === 'hr' ? '[HR]' : '[我]';
        const text = m.text.length > 100 ? m.text.substring(0, 100) + '…' : m.text;
        msgParts.push(`${prefix} ${escapeHtml(text)}`);
      });
      parts.push('<div class="jt-reply-version-text">' + msgParts.join('\n') + '</div>');

      // HR/Self 计数诊断
      if (hrCount === 0) {
        parts.push('<div class="jt-reply-version-text" style="margin-top:6px;color:#dc2626;">⚠️ 未识别到任何 HR 消息!所有消息都被标记为"我"。</div>');
        parts.push('<div class="jt-reply-version-text" style="margin-top:4px;color:#6b7280;font-size:11px;">可能原因: BOSS 的消息 class 是随机化的,且左右对齐启发式失效。请把下方"消息项 class 诊断"信息发给开发者。</div>');
      } else if (selfCount === 0) {
        parts.push('<div class="jt-reply-version-text" style="margin-top:6px;color:#dc2626;">⚠️ 所有消息都被标记为 HR!没有识别到"我"发的消息。</div>');
      }

      if (chatCtx.latestHrMessage) {
        const latestText = chatCtx.latestHrMessage.length > 200
          ? chatCtx.latestHrMessage.substring(0, 200) + '…'
          : chatCtx.latestHrMessage;
        parts.push('<div class="jt-reply-version-text" style="margin-top:6px;border-top:1px dashed #ddd;padding-top:6px;color:#059669;">HR 最新消息: ' + escapeHtml(latestText) + '</div>');
      } else {
        parts.push('<div class="jt-reply-version-text" style="margin-top:6px;color:#dc2626;">未检测到 HR 消息</div>');
      }

      // 消息项 class 诊断(用于调试 isOtherMessage 判断逻辑)
      parts.push('<div class="jt-reply-version-text" style="margin-top:8px;border-top:1px dashed #ccc;padding-top:8px;color:#6b7280;font-size:11px;">--- 消息项 class 诊断(前5条) ---</div>');
      const debugMsgs = JTChatHelper.getMessageDebugInfo(5);
      debugMsgs.forEach((d, i) => {
        parts.push('<div class="jt-reply-version-text" style="font-size:11px;color:#6b7280;">');
        parts.push(`#${i} 判定=${d.classifiedAs} | 位置=${d.position}`);
        parts.push(`  class: ${escapeHtml(d.className.substring(0, 100))}`);
        parts.push(`  父class: ${escapeHtml(d.parentClassName.substring(0, 80))}`);
        parts.push(`  子class: ${escapeHtml(d.childClasses.substring(0, 100))}`);
        parts.push('</div>');
      });

      chatItem.innerHTML = parts.join('\n');
    } else {
      chatItem.innerHTML = `
        <div class="jt-reply-version-label">❌ 未抓取到聊天消息</div>
        <div class="jt-reply-version-text">可能原因:
1. 未选中对话(请点击左侧某个对话)
2. 消息列表容器选择器不匹配(见下方"消息列表检测结果")
3. 消息项选择器不匹配(DOM 结构有变化)</div>
      `;
    }
    list.appendChild(chatItem);

    // ---- 基本信息 ----
    const basicItem = document.createElement('div');
    basicItem.className = 'jt-reply-version';
    basicItem.innerHTML = `
      <div class="jt-reply-version-label">基本信息</div>
      <div class="jt-reply-version-text">URL: ${escapeHtml(info.url)}
URL 匹配聊天页: ${info.isChatUrl}
尝试的输入框选择器数: ${info.inputSelectorsTried}
尝试的消息列表选择器数: ${info.listSelectorsTried}</div>
    `;
    list.appendChild(basicItem);

    // ---- 输入框检测结果 ----
    const inputItem = document.createElement('div');
    inputItem.className = 'jt-reply-version';
    if (info.inputElement) {
      inputItem.innerHTML = `
        <div class="jt-reply-version-label">✅ 输入框已检测到</div>
        <div class="jt-reply-version-text">标签: ${escapeHtml(info.inputElement.tag)}
class: ${escapeHtml(info.inputElement.className)}
contenteditable: ${escapeHtml(info.inputElement.contenteditable)}
placeholder: ${escapeHtml(info.inputElement.placeholder || '(无)')}
role: ${escapeHtml(info.inputElement.role || '(无)')}</div>
      `;
    } else {
      inputItem.innerHTML = `<div class="jt-reply-version-label">❌ 输入框未检测到</div>`;
    }
    list.appendChild(inputItem);

    // ---- 消息列表检测结果 ----
    const listResultItem = document.createElement('div');
    listResultItem.className = 'jt-reply-version';
    if (info.messageListContainer) {
      listResultItem.innerHTML = `
        <div class="jt-reply-version-label">✅ 消息列表容器已检测到</div>
        <div class="jt-reply-version-text">标签: ${escapeHtml(info.messageListContainer.tag)}
class: ${escapeHtml(info.messageListContainer.className)}
子元素数: ${info.messageListContainer.childCount}
消息项数: ${info.messageCount}</div>
      `;
    } else {
      listResultItem.innerHTML = `<div class="jt-reply-version-label">❌ 消息列表容器未检测到</div>`;
    }
    list.appendChild(listResultItem);

    // ---- 候选元素(如果没找到关键元素) ----
    if (info.candidates) {
      const candItem = document.createElement('div');
      candItem.className = 'jt-reply-version';
      const parts = ['<div class="jt-reply-version-label">候选元素(用于调整选择器)</div>'];

      if (info.candidates.editableDivs.length > 0) {
        parts.push('<div class="jt-reply-version-text">Contenteditable Div:');
        info.candidates.editableDivs.forEach(e => {
          parts.push(`  class="${escapeHtml(e.className)}" ${e.rect}`);
        });
        parts.push('</div>');
      }

      if (info.candidates.textareas.length > 0) {
        parts.push('<div class="jt-reply-version-text">Textarea:');
        info.candidates.textareas.forEach(e => {
          parts.push(`  class="${escapeHtml(e.className)}" placeholder="${escapeHtml(e.placeholder || '')}" ${e.rect}`);
        });
        parts.push('</div>');
      }

      if (info.candidates.possibleMessageContainers.length > 0) {
        parts.push('<div class="jt-reply-version-text">可能的聊天容器:');
        info.candidates.possibleMessageContainers.forEach(e => {
          parts.push(`  <${escapeHtml(e.tag)}> class="${escapeHtml(e.className)}" 子元素=${e.childCount} ${e.rect}`);
        });
        parts.push('</div>');
      }

      if (info.candidates.editableDivs.length === 0 &&
          info.candidates.textareas.length === 0 &&
          info.candidates.possibleMessageContainers.length === 0) {
        parts.push('<div class="jt-reply-version-text">未找到任何候选元素</div>');
      }

      candItem.innerHTML = parts.join('\n');
      list.appendChild(candItem);
    }

    // ---- 复制按钮 ----
    const actions = document.createElement('div');
    actions.className = 'jt-reply-version-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'jt-reply-btn-copy';
    copyBtn.textContent = '复制完整信息';
    const fullInfo = { ...info, chatContext: chatCtx };
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(JSON.stringify(fullInfo, null, 2)).then(() => {
        copyBtn.textContent = '已复制 ✓';
        setTimeout(() => { copyBtn.textContent = '复制完整信息'; }, 1500);
      });
    });
    actions.appendChild(copyBtn);
    list.appendChild(actions);

    panel.appendChild(list);

    header.querySelector('.jt-reply-panel-close').addEventListener('click', () => panel.remove());

    document.body.appendChild(panel);
  }

  // ----------------------------------------------------------
  // 回复选项面板(展示 LLM 生成的多版本回复,用户选择后填充到输入框)
  // ----------------------------------------------------------
  function showReplyPanel(versions, context, matchReport) {
    // 移除已有面板
    const existing = document.getElementById('jt-reply-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'jt-reply-panel';
    panel.className = 'jt-reply-panel';

    const header = document.createElement('div');
    header.className = 'jt-reply-panel-header';
    header.innerHTML = `
      <span class="jt-reply-panel-title">AI 回复建议</span>
      <span class="jt-reply-panel-close">✕</span>
    `;
    panel.appendChild(header);

    // 上下文摘要 + 岗位匹配报告
    if (context.jobTitle || matchReport) {
      const ctxInfo = document.createElement('div');
      ctxInfo.className = 'jt-reply-panel-ctx';

      const parts = [];
      if (context.jobTitle) {
        parts.push('当前岗位: ' + context.jobTitle);
      }

      if (matchReport) {
        if (matchReport.matched) {
          parts.push('✅ 后台匹配: ' + (matchReport.matchedJobTitle || ''));
          if (matchReport.matchedJobCompany) {
            parts.push('  公司: ' + matchReport.matchedJobCompany);
          }
          parts.push('  匹配方式: ' + matchReport.matchMethod);
          parts.push('  岗位描述: ' + (matchReport.hasDescription ? '有' : '无'));
          parts.push('  任职要求: ' + (matchReport.hasRequirement ? '有' : '无'));
        } else if (matchReport.savedJobsCount > 0) {
          parts.push('⚠️ 后台岗位库(' + matchReport.savedJobsCount + '条)未匹配到该岗位');
          if (matchReport.candidates && matchReport.candidates.length > 0) {
            parts.push('  最接近的候选:');
            matchReport.candidates.slice(0, 3).forEach(c => {
              parts.push('    ' + c.title + ' (' + c.score + '%)');
            });
          }
          parts.push('  → 建议先在岗位列表页采集该岗位');
        } else {
          parts.push('⚠️ 后台岗位库为空,建议先采集岗位');
        }
      }

      ctxInfo.textContent = parts.join('\n');
      ctxInfo.style.whiteSpace = 'pre-wrap';
      panel.appendChild(ctxInfo);
    }

    // 回复版本列表
    const list = document.createElement('div');
    list.className = 'jt-reply-panel-list';

    versions.forEach((text, idx) => {
      const item = document.createElement('div');
      item.className = 'jt-reply-version' + (idx === 0 ? ' jt-reply-version-recommended' : '');

      const label = document.createElement('div');
      label.className = 'jt-reply-version-label';
      label.textContent = idx === 0 ? '推荐版本' : `备选 ${idx}`;
      item.appendChild(label);

      const content = document.createElement('div');
      content.className = 'jt-reply-version-text';
      content.textContent = text;
      item.appendChild(content);

      const actions = document.createElement('div');
      actions.className = 'jt-reply-version-actions';

      // 填充按钮
      const fillBtn = document.createElement('button');
      fillBtn.className = 'jt-reply-btn-fill';
      fillBtn.textContent = '填入输入框';
      fillBtn.addEventListener('click', () => {
        const res = JTChatHelper.fillChatInput(text);
        if (res.ok) {
          showCaptureToast('已填入输入框,请检查后发送', 'success');
          panel.remove();
        } else {
          showCaptureToast('填充失败: ' + (res.error || '未知错误'), 'info');
        }
      });
      actions.appendChild(fillBtn);

      // 复制按钮
      const copyBtn = document.createElement('button');
      copyBtn.className = 'jt-reply-btn-copy';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = '已复制 ✓';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
        });
      });
      actions.appendChild(copyBtn);

      item.appendChild(actions);
      list.appendChild(item);
    });

    panel.appendChild(list);

    // 关闭按钮
    header.querySelector('.jt-reply-panel-close').addEventListener('click', () => panel.remove());

    document.body.appendChild(panel);
  }

  // ----------------------------------------------------------
  // DOM 变化监听(MutationObserver)
  // 仅用于:列表页无限滚动新卡片加载时的徽章注入 + 表单检测
  // 性能优化:列表页只监听列表容器(而非整个 body),降低大型 SPA 上的回调开销
  // 纯手动模式:不再自动检测岗位切换并入库
  // ----------------------------------------------------------
  function observeContentChanges() {
    if (contentObserver) contentObserver.disconnect();

    // 尝试定位列表容器,缩小监听范围;找不到则退回 body
    const listRoot = findListContainer() || document.body;

    contentObserver = new MutationObserver(() => {
      if (observerTimer) clearTimeout(observerTimer);
      observerTimer = setTimeout(() => {
        // 列表页:为新加载卡片注入徽章
        if (JTParser.isJobSite() && showBadges && JTParser.isPureListPage()) {
          JTParser.invalidateCardsCache(); // 使缓存失效,确保无限滚动新卡片被识别
          injectBadges();
        }
        // 表单检测:所有站点生效
        if (resumeProfile && !document.getElementById('jt-fill-btn')) {
          const forms = JTFormFiller.detectForms();
          if (forms.length > 0) {
            JTFormFiller.injectFillButton(resumeProfile, () => {
              const result = JTFormFiller.fillForm(resumeProfile);
              if (result.filled > 0) {
                showCaptureToast(`已自动填充 ${result.filled} 个字段,请检查后提交`, 'success');
              } else {
                showCaptureToast('未能自动填充任何字段', 'info');
              }
            });
          }
        }
      }, JT_CONFIG.timing.MUTATION_DEBOUNCE);
    });

    contentObserver.observe(listRoot, {
      childList: true,
      subtree: true
    });
  }

  // 定位列表页的岗位列表容器(用于缩小 MutationObserver 监听范围)
  // 优先用站点配置的卡片选择器向上找最近公共祖先;找不到返回 null
  function findListContainer() {
    const site = JTParser.getSiteConfig ? JTParser.getSiteConfig() : null;
    const cardSel = (site && site.cardSelector) || '.job-card-wrap, [class*="job-card"], [class*="job-list"]';
    let cards = [];
    try { cards = document.querySelectorAll(cardSel); } catch (e) { cards = []; }
    if (cards.length === 0) return null;
    // 取前几个卡片的最近公共祖先
    let container = cards[0].parentElement;
    for (let i = 1; i < Math.min(cards.length, 5); i++) {
      while (container && !container.contains(cards[i])) {
        container = container.parentElement;
      }
      if (!container) return null;
    }
    return container;
  }

  // ----------------------------------------------------------
  // 页面右下角浮动提示
  // ----------------------------------------------------------
  function showCaptureToast(text, type) {
    const toast = document.createElement('div');
    toast.className = `jt-toast jt-toast-${type || 'info'}`;
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('jt-toast-show'), 10);
    setTimeout(() => {
      toast.classList.remove('jt-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ----------------------------------------------------------
  // 启动
  // ----------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
