// ============================================================
// chat-helper.js — BOSS 直聘聊天页半自动回复辅助工具
// 功能:
//   1. 检测当前页是否为 BOSS 聊天页
//   2. 抓取聊天上下文(HR 消息历史 + 当前岗位标题)
//   3. 填充回复文本到聊天输入框(contenteditable div / textarea)
//   4. 提供调试信息,方便在真实环境中调整选择器
//
// 设计说明:
//   - BOSS 聊天页 DOM 结构可能随版本变化,选择器采用"通用 + 配置化"方案
//   - 优先按 class 关键词匹配,回退到 role/placeholder 等属性
//   - 若选择器全部失效,可通过 getChatDebugInfo() 输出页面结构辅助调试
// ============================================================

const JTChatHelper = (() => {

  // ---- BOSS 聊天页 URL 特征 ----
  const CHAT_URL_PATTERNS = [
    /zhipin\.com\/web\/geek\/chat/i,
    /zhipin\.com\/chat/i,
    /zhipin\.com.*\/chat\b/i
  ];

  // ---- 输入框选择器(按优先级) ----
  // BOSS 聊天输入框可能是 contenteditable div 或 textarea
  const INPUT_SELECTORS = [
    'div[contenteditable="true"]',
    'textarea[placeholder*="回复"]',
    'textarea[placeholder*="输入"]',
    'textarea[placeholder*="消息"]',
    'div[role="textbox"]',
    '[class*="chat-input"]',
    '[class*="message-input"]',
    '[class*="input-area"] textarea',
    '[class*="input-area"] [contenteditable]',
    '[class*="edit-area"]',
    'textarea[class*="input"]'
  ];

  // ---- 消息列表容器选择器 ----
  const MESSAGE_LIST_SELECTORS = [
    '[class*="chat-message"]',
    '[class*="message-list"]',
    '[class*="msg-list"]',
    '[class*="chat-content"]',
    '[class*="chat-body"]',
    '[class*="message-container"]',
    '[class*="chat-record"]',
    '[class*="conversation"]'
  ];

  // ---- 单条消息项选择器 ----
  const MESSAGE_ITEM_SELECTORS = [
    '[class*="message-item"]',
    '[class*="msg-item"]',
    '[class*="chat-item"]',
    '[class*="bubble"]',
    '[class*="message-content"]',
    '[class*="msg-content"]',
    'li[class*="message"]',
    'div[class*="message"]'
  ];

  // ---- 区分"对方消息"与"自己消息"的 class 关键词 ----
  // 对方(HR)消息通常含: other/left/boss/they/you/friend(BOSS直聘用)
  // 自己消息通常含: mine/right/self/me/geek/myself(BOSS直聘用)/send
  const OTHER_MARKERS = ['other', 'left', 'boss', 'they', 'you', 'from', 'friend', 'them'];
  const SELF_MARKERS = ['mine', 'right', 'self', 'me', 'geek', 'send', 'myself', 'owner'];

  // ---- 岗位标题选择器(聊天页侧边栏通常显示当前岗位) ----
  const JOB_TITLE_SELECTORS = [
    '[class*="job-name"]',
    '[class*="position-name"]',
    '[class*="job-title"]',
    '[class*="chat-job"] [class*="name"]',
    '[class*="current-job"]',
    '.job-name',
    'h3[class*="title"]'
  ];

  // ============================================================
  // 页面检测
  // ============================================================

  function isBossChatPage() {
    const url = location.href;
    return CHAT_URL_PATTERNS.some(p => p.test(url));
  }

  // 通过 DOM 特征进一步确认(URL 可能匹配但实际不是聊天页)
  function detectChatElements() {
    return !!findInputElement() || !!findMessageListContainer();
  }

  // ============================================================
  // 元素查找工具
  // ============================================================

  function findInputElement() {
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function findMessageListContainer() {
    for (const sel of MESSAGE_LIST_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function findJobTitle() {
    for (const sel of JOB_TITLE_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.textContent || '').trim();
        if (text && text.length < 100) return text;
      }
    }
    return '';
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 判断消息项是对方(HR)还是自己
  // 多层级检查:当前元素 + 父元素 + 子元素 的 class
  // 并结合 DOM 位置启发式(左对齐=对方,右对齐=自己)
  function isOtherMessage(el) {
    // 收集当前元素、父元素、子元素的 class
    const classes = new Set();
    const collectClass = (node) => {
      if (!node) return;
      const cls = typeof node.className === 'string' ? node.className.toLowerCase() : '';
      if (cls) cls.split(/[\s]+/).forEach(c => { if (c) classes.add(c); });
    };

    collectClass(el);
    collectClass(el.parentElement);
    // 检查子元素(只看直接子元素,避免过深)
    if (el.children) {
      for (let i = 0; i < Math.min(el.children.length, 5); i++) {
        collectClass(el.children[i]);
      }
    }

    // 分段匹配:检查 class token 是否等于标记,或在连字符/下划线后包含标记
    // 例如 "item-friend" 匹配 "friend",但 "message-item" 不匹配 "me"
    function classMatchesMarker(cls, marker) {
      return cls === marker ||
        cls.endsWith('-' + marker) ||
        cls.endsWith('_' + marker) ||
        cls.includes(marker + '-') ||
        cls.includes(marker + '_');
    }

    // 优先检查 self 标记
    for (const cls of classes) {
      if (SELF_MARKERS.some(m => classMatchesMarker(cls, m))) return false;
    }
    // 再检查 other 标记
    for (const cls of classes) {
      if (OTHER_MARKERS.some(m => classMatchesMarker(cls, m))) return true;
    }

    // class 都没命中,用 DOM 位置启发式:检查消息内容在容器内的水平位置
    // 对方(HR)消息通常左对齐,自己消息通常右对齐
    return isLeftAligned(el);
  }

  // 通过 DOM 位置判断消息是否左对齐(对方消息)
  function isLeftAligned(el) {
    try {
      const container = el.parentElement;
      if (!container) return false;
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (elRect.width <= 0 || containerRect.width <= 0) return false;

      // 计算消息元素的左边缘相对于容器的偏移比例
      const leftOffset = (elRect.left - containerRect.left) / containerRect.width;
      const rightOffset = (containerRect.right - elRect.right) / containerRect.width;

      // 左对齐: leftOffset < rightOffset (消息靠左)
      // 右对齐: rightOffset < leftOffset (消息靠右)
      // 只有差距比较明显时才判断(避免居中情况)
      const diff = rightOffset - leftOffset;
      return diff > 0.1; // 左边缘比右边缘更靠近容器左边
    } catch (e) {
      return false;
    }
  }

  // ============================================================
  // 岗位详情抓取
  // ============================================================

  // "查看岗位"按钮的关键词
  const VIEW_JOB_KEYWORDS = ['查看岗位', '查看职位', '查看详情', '岗位详情', '职位详情', '查看Job', 'view job', '岗位', '职位', '查看'];

  // 岗位详情弹窗/面板选择器
  const JOB_DETAIL_PANEL_SELECTORS = [
    '[class*="job-detail"]',
    '[class*="position-detail"]',
    '[class*="job-info"]',
    '[class*="job-card-detail"]',
    '[class*="detail-modal"]',
    '[class*="job-modal"]',
    '[class*="popup"] [class*="job"]',
    '[role="dialog"]'
  ];

  // 岗位描述/要求的关键词标题(用于在详情面板中拆分文本)
  const DESC_HEADERS = ['岗位职责', '工作内容', '职位描述', '岗位描述', '工作职责', '职责描述'];
  const REQ_HEADERS = ['任职要求', '岗位要求', '招聘要求', '任职资格', '职位要求'];
  const SALARY_HEADERS = ['薪资', '薪酬', '待遇', '月薪', '年薪'];

  // 查找"查看岗位"按钮
  function findViewJobButton() {
    // 方案1: 查找指向岗位详情页的链接(最可靠)
    const jobLinks = document.querySelectorAll('a[href*="job_detail"], a[href*="/job/"]');
    for (const el of jobLinks) {
      if (!isVisible(el)) continue;
      return el;
    }

    // 方案2: 按文本内容查找(精确匹配优先)
    const candidates = document.querySelectorAll('a, button, span, div');
    // 先找精确匹配
    const exactKeywords = ['查看岗位', '查看职位', '查看详情', '岗位详情', '职位详情'];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (text.length > 20) continue;
      if (exactKeywords.some(kw => text === kw || text.includes(kw))) {
        return el;
      }
    }
    // 再找宽泛匹配
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (text.length > 20) continue;
      if (VIEW_JOB_KEYWORDS.some(kw => text.includes(kw))) {
        return el;
      }
    }

    // 方案3: 按 class 关键词查找
    const classSelectors = [
      '[class*="view-job"]',
      '[class*="job-link"]',
      '[class*="position-link"]',
      '[class*="view-position"]',
      '[class*="job-detail-link"]',
      '[class*="job-card"]',
      '[class*="job-info"]'
    ];
    for (const sel of classSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  // 查找岗位详情面板(弹窗或侧边栏)
  function findJobDetailPanel() {
    for (const sel of JOB_DETAIL_PANEL_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  // 从详情面板提取岗位信息
  function extractJobFromPanel(panel) {
    const job = {};

    // 标题
    const titleSelectors = ['h1', 'h2', 'h3', '[class*="job-name"]', '[class*="job-title"]', '[class*="position-name"]', '[class*="title"]'];
    for (const sel of titleSelectors) {
      const el = panel.querySelector(sel);
      if (el) {
        const text = (el.textContent || '').trim();
        if (text && text.length < 100) {
          job.title = text;
          break;
        }
      }
    }

    // 薪资
    const salarySelectors = ['[class*="salary"]', '[class*="money"]', '[class*="wage"]', '[class*="pay"]'];
    for (const sel of salarySelectors) {
      const el = panel.querySelector(sel);
      if (el) {
        const text = (el.textContent || '').trim();
        if (text && text.length < 50) {
          job.salaryRaw = text;
          break;
        }
      }
    }

    // 公司名
    const companySelectors = ['[class*="company-name"]', '[class*="company"]', '[class*="ent-name"]', '[class*="co-name"]'];
    for (const sel of companySelectors) {
      const el = panel.querySelector(sel);
      if (el) {
        const text = (el.textContent || '').trim();
        if (text && text.length < 100) {
          job.company = text;
          break;
        }
      }
    }

    // 地点
    const locationSelectors = ['[class*="location"]', '[class*="area"]', '[class*="city"]'];
    for (const sel of locationSelectors) {
      const el = panel.querySelector(sel);
      if (el) {
        const text = (el.textContent || '').trim();
        if (text && text.length < 50) {
          job.location = text;
          break;
        }
      }
    }

    // 从面板全文提取描述和要求(按标题关键词拆分)
    const fullText = (panel.textContent || '').trim();
    if (fullText) {
      // 提取描述
      for (const header of DESC_HEADERS) {
        const idx = fullText.indexOf(header);
        if (idx >= 0) {
          const afterHeader = fullText.substring(idx + header.length).trim();
          // 找到下一个标题关键词作为结束位置
          let endPos = afterHeader.length;
          for (const reqHeader of REQ_HEADERS) {
            const reqIdx = afterHeader.indexOf(reqHeader);
            if (reqIdx >= 0 && reqIdx < endPos) endPos = reqIdx;
          }
          for (const salHeader of SALARY_HEADERS) {
            const salIdx = afterHeader.indexOf(salHeader);
            if (salIdx >= 0 && salIdx < endPos) endPos = salIdx;
          }
          job.description = afterHeader.substring(0, endPos).trim();
          break;
        }
      }

      // 提取任职要求
      for (const header of REQ_HEADERS) {
        const idx = fullText.indexOf(header);
        if (idx >= 0) {
          const afterHeader = fullText.substring(idx + header.length).trim();
          // 找到下一个标题关键词作为结束位置
          let endPos = afterHeader.length;
          const allHeaders = [...DESC_HEADERS, ...SALARY_HEADERS, ['福利', '五险', '联系方式', '公司介绍']];
          for (const otherHeader of allHeaders.flat()) {
            const otherIdx = afterHeader.indexOf(otherHeader);
            if (otherIdx >= 0 && otherIdx < endPos) endPos = otherIdx;
          }
          job.requirement = afterHeader.substring(0, endPos).trim();
          break;
        }
      }

      // 如果没按标题拆分成功,把全文作为 description
      if (!job.description && !job.requirement) {
        job.description = fullText.substring(0, 2000);
      }
    }

    return job;
  }

  // 自动获取岗位详情
  // 策略:
  //   1. 先从聊天页侧边栏/岗位卡片直接提取(无需点击)
  //   2. 如果信息不完整,查找"查看岗位"链接 → 如果是 href 链接,用 fetch 获取详情页 HTML 解析
  //   3. 如果不是链接而是按钮,点击后等待弹窗
  async function extractJobInfo() {
    // 步骤1: 尝试从聊天页已有的岗位卡片/侧边栏提取
    const cardJob = extractJobFromChatCard();
    if (cardJob && (cardJob.title || cardJob.description)) {
      cardJob.source = 'chat_card';
      return cardJob;
    }

    // 步骤2: 检查 DOM 中是否已有可见的岗位详情面板
    let panel = findJobDetailPanel();
    if (panel) {
      const job = extractJobFromPanel(panel);
      if (job.title || job.description) {
        job.source = 'panel';
        return job;
      }
    }

    // 步骤3: 查找"查看岗位"按钮/链接
    const viewBtn = findViewJobButton();
    if (!viewBtn) {
      const title = findJobTitle();
      return { title, source: 'no_button', debug: collectJobDebugCandidates() };
    }

    // 步骤3a: 如果是链接(a 标签且有 href),尝试用 fetch 获取详情页
    if (viewBtn.tagName === 'A' && viewBtn.href) {
      try {
        const job = await fetchJobDetailFromUrl(viewBtn.href);
        if (job && (job.title || job.description)) {
          job.source = 'fetched';
          return job;
        }
      } catch (e) {
        // fetch 失败,继续尝试点击方式
      }
    }

    // 步骤3b: 点击按钮,等待弹窗
    try {
      viewBtn.click();
    } catch (e) {
      return { title: findJobTitle(), source: 'click_failed', error: e.message };
    }

    panel = await waitForElement(JOB_DETAIL_PANEL_SELECTORS, 3000);
    if (!panel) {
      const title = findJobTitle();
      return { title, source: 'no_panel_after_click', debug: collectJobDebugCandidates() };
    }

    const job = extractJobFromPanel(panel);
    closeDetailPanel(panel);
    job.source = 'clicked';
    return job;
  }

  // 从聊天页侧边栏/岗位卡片提取信息(无需点击)
  // BOSS 聊天页通常在消息区上方或侧边显示当前岗位卡片
  function extractJobFromChatCard() {
    // 查找可能的岗位卡片容器
    const cardSelectors = [
      '[class*="job-card"]',
      '[class*="job-info"]',
      '[class*="position-card"]',
      '[class*="chat-job"]',
      '[class*="current-job"]',
      '[class*="job-header"]',
      '[class*="job-banner"]'
    ];

    for (const sel of cardSelectors) {
      const el = document.querySelector(sel);
      if (!el || !isVisible(el)) continue;

      const job = {};
      const text = (el.textContent || '').trim();

      // 尝试从卡片内提取各字段
      const titleEl = el.querySelector('[class*="name"], [class*="title"], h1, h2, h3');
      if (titleEl) job.title = (titleEl.textContent || '').trim();

      const salaryEl = el.querySelector('[class*="salary"], [class*="money"], [class*="pay"]');
      if (salaryEl) job.salaryRaw = (salaryEl.textContent || '').trim();

      const companyEl = el.querySelector('[class*="company"], [class*="ent-name"]');
      if (companyEl) job.company = (companyEl.textContent || '').trim();

      const locationEl = el.querySelector('[class*="location"], [class*="area"], [class*="city"]');
      if (locationEl) job.location = (locationEl.textContent || '').trim();

      // 如果卡片文本中包含描述/要求关键词,尝试提取
      if (text.length > 50) {
        for (const header of DESC_HEADERS) {
          const idx = text.indexOf(header);
          if (idx >= 0) {
            const after = text.substring(idx + header.length).trim();
            let end = after.length;
            for (const reqH of REQ_HEADERS) {
              const rIdx = after.indexOf(reqH);
              if (rIdx >= 0 && rIdx < end) end = rIdx;
            }
            job.description = after.substring(0, end).trim();
            break;
          }
        }
        for (const header of REQ_HEADERS) {
          const idx = text.indexOf(header);
          if (idx >= 0) {
            const after = text.substring(idx + header.length).trim();
            let end = after.length;
            for (const dH of DESC_HEADERS) {
              const dIdx = after.indexOf(dH);
              if (dIdx >= 0 && dIdx < end) end = dIdx;
            }
            job.requirement = after.substring(0, end).trim();
            break;
          }
        }
      }

      if (job.title || job.description || text.length > 30) {
        if (!job.title) job.title = text.substring(0, 50);
        return job;
      }
    }

    return null;
  }

  // 用 fetch 获取岗位详情页 HTML 并解析
  async function fetchJobDetailFromUrl(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return null;
    const html = await resp.text();

    // 解析 HTML(用 DOMParser)
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const job = {};

    // 标题
    const titleEl = doc.querySelector('h1, .job-name, .job-title, .position-name, [class*="job-name"]');
    if (titleEl) job.title = (titleEl.textContent || '').trim();

    // 薪资
    const salaryEl = doc.querySelector('.salary, .job-salary, [class*="salary"], [class*="money"]');
    if (salaryEl) job.salaryRaw = (salaryEl.textContent || '').trim();

    // 公司
    const companyEl = doc.querySelector('.company-name, .boss-name, [class*="company"], [class*="ent-name"]');
    if (companyEl) job.company = (companyEl.textContent || '').trim();

    // 地点
    const locationEl = doc.querySelector('.job-area, .location, [class*="location"], [class*="area"]');
    if (locationEl) job.location = (locationEl.textContent || '').trim();

    // 描述(BOSS 直聘详情页通常有 .job-sec-text 区块)
    const descSections = doc.querySelectorAll('.job-sec-text, .job-detail-section .desc, [class*="job-sec-text"]');
    const descParts = [];
    const reqParts = [];
    descSections.forEach(sec => {
      const text = (sec.textContent || '').trim();
      const sectionTitle = sec.previousElementSibling ? (sec.previousElementSibling.textContent || '').trim() : '';
      if (sectionTitle.includes('任职') || sectionTitle.includes('要求') || text.includes('任职要求')) {
        reqParts.push(text);
      } else {
        descParts.push(text);
      }
    });

    if (descParts.length > 0) job.description = descParts.join('\n');
    if (reqParts.length > 0) job.requirement = reqParts.join('\n');

    // 回退:从全文按标题关键词拆分
    if (!job.description && !job.requirement) {
      const fullText = (doc.body.textContent || '').trim();
      for (const header of DESC_HEADERS) {
        const idx = fullText.indexOf(header);
        if (idx >= 0) {
          const after = fullText.substring(idx + header.length).trim();
          let end = after.length;
          for (const reqH of REQ_HEADERS) {
            const rIdx = after.indexOf(reqH);
            if (rIdx >= 0 && rIdx < end) end = rIdx;
          }
          job.description = after.substring(0, Math.min(end, 2000)).trim();
          break;
        }
      }
      for (const header of REQ_HEADERS) {
        const idx = fullText.indexOf(header);
        if (idx >= 0) {
          const after = fullText.substring(idx + header.length).trim();
          job.requirement = after.substring(0, 2000).trim();
          break;
        }
      }
    }

    return job;
  }

  // 收集岗位相关的调试候选元素(用于诊断"查看岗位"按钮找不到的情况)
  function collectJobDebugCandidates() {
    const result = {
      jobLinks: [],
      buttonsWithJobKeyword: [],
      elementsWithJobClass: []
    };

    // 所有指向 job_detail 的链接
    document.querySelectorAll('a[href*="job_detail"], a[href*="/job/"]').forEach(el => {
      if (isVisible(el)) {
        result.jobLinks.push({
          href: el.href,
          text: (el.textContent || '').trim().substring(0, 50),
          className: (el.className || '').substring(0, 80)
        });
      }
    });

    // 包含"岗位"/"职位"/"查看"关键词的可点击元素
    const clickables = document.querySelectorAll('a, button, [role="button"], [class*="btn"]');
    clickables.forEach(el => {
      if (!isVisible(el)) return;
      const text = (el.textContent || '').trim();
      if (text.length > 30) return;
      if (['岗位', '职位', '查看', '详情'].some(kw => text.includes(kw))) {
        result.buttonsWithJobKeyword.push({
          tag: el.tagName,
          text: text.substring(0, 50),
          className: (el.className || '').substring(0, 80),
          href: el.href || ''
        });
      }
    });

    // 带 job class 的元素
    document.querySelectorAll('[class*="job"], [class*="position"]').forEach(el => {
      if (!isVisible(el)) return;
      const cls = (el.className || '').substring(0, 80);
      // 去重
      if (result.elementsWithJobClass.some(e => e.className === cls)) return;
      result.elementsWithJobClass.push({
        tag: el.tagName,
        className: cls,
        text: (el.textContent || '').trim().substring(0, 100),
        childCount: el.children.length
      });
    });

    return result;
  }

  // 等待元素出现(轮询)
  function waitForElement(selectors, timeoutMs) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      function check() {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && isVisible(el)) {
            resolve(el);
            return;
          }
        }
        if (Date.now() - startTime >= timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(check, 200);
      }
      check();
    });
  }

  // 关闭详情面板
  function closeDetailPanel(panel) {
    // 方案1: 在面板内找关闭按钮
    const closeSelectors = ['[class*="close"]', '[class*="dismiss"]', 'button[aria-label*="close"]', '.close', '✕'];
    for (const sel of closeSelectors) {
      const btn = panel.querySelector(sel);
      if (btn) {
        try { btn.click(); return; } catch (e) { /* 忽略 */ }
      }
    }
    // 方案2: 在面板外查找关闭按钮(有些弹窗的关闭按钮在 panel 外层)
    const outerClose = document.querySelector('[class*="modal"] [class*="close"], [class*="overlay"] [class*="close"]');
    if (outerClose) {
      try { outerClose.click(); return; } catch (e) { /* 忽略 */ }
    }
    // 方案3: 按 Esc 键
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) { /* 忽略 */ }
  }

  // ============================================================
  // 聊天上下文抓取
  // ============================================================

  // 提取聊天上下文(仅聊天消息 + 岗位标题,岗位详情由 background 从岗位库匹配)
  // 返回: { hrMessages, allMessages, jobTitle, latestHrMessage }
  function extractChatContext(maxMessages = 20) {
    const container = findMessageListContainer();
    const jobTitle = findJobTitle();

    if (!container) {
      return { hrMessages: [], allMessages: [], jobTitle, latestHrMessage: '', debug: '未找到消息列表容器' };
    }

    // 收集所有消息项
    const items = collectMessageItems(container);
    const allMessages = [];
    const hrMessages = [];

    items.slice(-maxMessages).forEach((item, idx) => {
      const text = extractMessageText(item);
      if (!text) return;

      const isOther = isOtherMessage(item);
      const msg = {
        role: isOther ? 'hr' : 'self',
        text,
        index: idx
      };
      allMessages.push(msg);
      if (isOther) hrMessages.push(msg);
    });

    const latestHrMessage = hrMessages.length > 0 ? hrMessages[hrMessages.length - 1].text : '';

    return { hrMessages, allMessages, jobTitle, latestHrMessage };
  }

  // 从容器中收集消息项元素
  function collectMessageItems(container) {
    let items = [];

    // 尝试各消息项选择器
    for (const sel of MESSAGE_ITEM_SELECTORS) {
      const found = container.querySelectorAll(sel);
      if (found.length > 0) {
        items = Array.from(found);
        break;
      }
    }

    // 回退:取容器的直接子元素(有些聊天 UI 每条消息是一个直接子 div)
    if (items.length === 0) {
      const children = container.children;
      if (children.length > 0) {
        items = Array.from(children).filter(el => {
          const text = (el.textContent || '').trim();
          return text.length > 0;
        });
      }
    }

    return items;
  }

  // 提取单条消息的文本
  function extractMessageText(item) {
    // 优先取文本节点,排除时间戳/昵称等噪声
    const clone = item.cloneNode(true);
    // 移除时间戳、头像等非正文元素
    clone.querySelectorAll('[class*="time"], [class*="avatar"], [class*="name"], [class*="date"]').forEach(e => e.remove());
    const text = (clone.textContent || '').trim();
    // 过滤过短的噪声(如"已读"、时间戳)
    return text.length >= 2 ? text : '';
  }

  // 获取消息项的调试信息(用于诊断 isOtherMessage 判断是否正确)
  function getMessageDebugInfo(maxCount = 5) {
    const container = findMessageListContainer();
    if (!container) return [];

    const items = collectMessageItems(container);
    const result = [];

    items.slice(0, maxCount).forEach((el, i) => {
      const isOther = isOtherMessage(el);
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const leftOffset = containerRect.width > 0 ? ((elRect.left - containerRect.left) / containerRect.width * 100).toFixed(0) : '?';
      const rightOffset = containerRect.width > 0 ? ((containerRect.right - elRect.right) / containerRect.width * 100).toFixed(0) : '?';

      // 收集子元素 class
      const childClasses = [];
      if (el.children) {
        for (let j = 0; j < Math.min(el.children.length, 3); j++) {
          const c = el.children[j];
          const cls = typeof c.className === 'string' ? c.className : '';
          if (cls) childClasses.push(cls);
        }
      }

      result.push({
        index: i,
        classifiedAs: isOther ? 'HR' : '我',
        position: `左${leftOffset}% 右${rightOffset}%`,
        className: (el.className || '').toString(),
        parentClassName: (el.parentElement && el.parentElement.className || '').toString(),
        childClasses: childClasses.join(' | '),
        textPreview: (el.textContent || '').trim().substring(0, 50)
      });
    });

    return result;
  }

  // ============================================================
  // 输入框填充
  // ============================================================

  // 将回复文本填充到聊天输入框
  // 返回: { ok: true } 或 { ok: false, error: '...' }
  function fillChatInput(text) {
    if (!text) return { ok: false, error: '回复内容为空' };

    const input = findInputElement();
    if (!input) return { ok: false, error: '未找到聊天输入框' };

    try {
      // 聚焦输入框
      input.focus();

      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        // textarea/input: 用原生 setter + 触发事件
        return fillTextarea(input, text);
      }

      if (input.getAttribute('contenteditable') === 'true' || input.isContentEditable) {
        // contenteditable div: 用 execCommand
        return fillContentEditable(input, text);
      }

      return { ok: false, error: '不支持的输入框类型: ' + input.tagName };
    } catch (e) {
      return { ok: false, error: '填充输入框异常: ' + e.message };
    }
  }

  // 填充 textarea/input
  function fillTextarea(el, text) {
    // 清空现有内容
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const nativeInputValueSetterInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const setter = el.tagName === 'TEXTAREA' ? nativeInputValueSetter : nativeInputValueSetterInput;
    setter.call(el, text);

    // 触发 input 事件让框架感知到值变化
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  // 填充 contenteditable div
  function fillContentEditable(el, text) {
    // 清空现有内容
    el.innerHTML = '';

    // 方案1: execCommand(兼容性最好,触发框架事件)
    el.focus();
    const ok = document.execCommand('insertText', false, text);

    if (ok && el.textContent.trim() === text.trim()) {
      return { ok: true };
    }

    // 方案2: 直接设置 textContent + 触发 input 事件
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));

    return { ok: true };
  }

  // ============================================================
  // 调试信息(辅助选择器调整)
  // ============================================================

  function getChatDebugInfo() {
    const info = {
      url: location.href,
      isChatUrl: isBossChatPage(),
      inputElement: null,
      messageListContainer: null,
      jobTitle: findJobTitle(),
      messageCount: 0,
      inputSelectorsTried: INPUT_SELECTORS.length,
      listSelectorsTried: MESSAGE_LIST_SELECTORS.length
    };

    const input = findInputElement();
    if (input) {
      info.inputElement = {
        tag: input.tagName,
        className: (input.className || '').substring(0, 200),
        contenteditable: input.getAttribute('contenteditable'),
        placeholder: input.getAttribute('placeholder'),
        role: input.getAttribute('role')
      };
    }

    const container = findMessageListContainer();
    if (container) {
      info.messageListContainer = {
        tag: container.tagName,
        className: (container.className || '').substring(0, 200),
        childCount: container.children.length
      };
      info.messageCount = collectMessageItems(container).length;
    }

    // 如果没找到关键元素,收集页面上可能的候选元素
    if (!input || !container) {
      info.candidates = collectDebugCandidates();
    }

    return info;
  }

  // 收集页面上可能是输入框或消息列表的元素(调试用)
  function collectDebugCandidates() {
    const candidates = {
      editableDivs: [],
      textareas: [],
      possibleMessageContainers: []
    };

    document.querySelectorAll('[contenteditable="true"]').forEach(el => {
      if (isVisible(el)) {
        candidates.editableDivs.push({
          className: (el.className || '').substring(0, 100),
          rect: formatRect(el)
        });
      }
    });

    document.querySelectorAll('textarea').forEach(el => {
      if (isVisible(el)) {
        candidates.textareas.push({
          className: (el.className || '').substring(0, 100),
          placeholder: el.getAttribute('placeholder'),
          rect: formatRect(el)
        });
      }
    });

    // 找含有多个子元素且子元素含文本的容器(可能是消息列表)
    document.querySelectorAll('div[class], ul[class], section[class]').forEach(el => {
      if (!isVisible(el) || el.children.length < 3) return;
      const cls = (el.className || '').toLowerCase();
      if (cls.includes('message') || cls.includes('chat') || cls.includes('msg') || cls.includes('conversation')) {
        candidates.possibleMessageContainers.push({
          tag: el.tagName,
          className: el.className.substring(0, 100),
          childCount: el.children.length,
          rect: formatRect(el)
        });
      }
    });

    return candidates;
  }

  function formatRect(el) {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.top)},${Math.round(r.left)}`;
  }

  return {
    isBossChatPage,
    detectChatElements,
    extractChatContext,
    fillChatInput,
    getChatDebugInfo,
    getMessageDebugInfo
  };
})();
