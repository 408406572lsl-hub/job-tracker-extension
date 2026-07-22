// ============================================================
// diagnostic.js — 岗位提取诊断工具(调试用)
// 从 parser.js 提取,作为 JTParser 的扩展模块
// 加载顺序:必须在 parser.js 之后(依赖 JTParser 公开 API)
//
// 依赖的 JTParser 公开方法:
//   - getDetailContainer()  获取详情容器
//   - getSiteConfig()       获取站点配置
//   - cleanText(text)       清理文本
// ============================================================

(function () {
  'use strict';

  // 守卫:如果 JTParser 未定义(如非 content script 环境),直接返回
  if (typeof JTParser === 'undefined') return;

  // 与 parser.js 保持一致的文本提取:innerText 为空时回退 textContent(BOSS 字体反爬)
  // 诊断报告使用页面真实可提取文本,便于对照 parser 的实际行为
  function getText(el) {
    if (!el) return '';
    const t = (el.innerText || '').trim();
    if (t) return t;
    const tc = (el.textContent || '').trim();
    return tc;
  }

  // ----------------------------------------------------------
  // getDomDiagnostics:轻量级 DOM 诊断
  // 返回当前页面的容器信息、站点配置、选择器匹配情况
  // 用于调试"为什么提取不到岗位信息"
  // ----------------------------------------------------------
  JTParser.getDomDiagnostics = function () {
    const container = JTParser.getDetailContainer();
    const site = JTParser.getSiteConfig();
    const diag = {
      // 容器信息
      containerTag: container ? container.tagName : 'null',
      containerClass: container ? (container.className || '').toString().substring(0, 120) : '',
      containerId: container ? (container.id || '') : '',
      isBody: container === document.body,
      // 容器文本量(用于判断是否太窄)
      containerTextLen: container ? getText(container).length : 0,
      // 站点配置
      siteName: site ? site.name : '未知',
      sectionEnabled: !!(site && site.selectors && site.selectors.sectionBasedExtraction),
      contentSelector: (site && site.selectors && site.selectors.description && site.selectors.description[0]) || '(无)',
      // 选择器匹配结果
      secTextCount: 0,
      secTextPreview: '',
    };

    if (container && container !== document.body) {
      const sel = (site && site.selectors && site.selectors.description && site.selectors.description[0]) || '.job-sec-text';
      try {
        const blocks = container.querySelectorAll(sel);
        diag.secTextCount = blocks.length;
        if (blocks.length > 0) {
          diag.secTextPreview = JTParser.cleanText(getText(blocks[0])).substring(0, 80);
        }
      } catch (e) { /* skip */ }

      // 容器全文预览（v1.5.15: 解除 300 字限制，用户反馈截断导致信息不全）
      diag.containerPreview = JTParser.cleanText(getText(container));

      // v1.4.7:检测容器是否含正文 section 标题(用于诊断是否选到了纯头部)
      const bodyKw = /职位描述|任职要求|工作内容|岗位要求|招聘要求/i;
      diag.hasBodySection = bodyKw.test(getText(container));
    }

    return diag;
  };

  // ----------------------------------------------------------
  // getFullDiagnosticReport:完整诊断报告(调试后门用)
  // 包含所有提取中间结果和原始文本,可通过 popup 按钮一键复制
  //   或写入 storage 供 AI 直接读取
  // ----------------------------------------------------------
  JTParser.getFullDiagnosticReport = function (job) {
    const container = JTParser.getDetailContainer();
    const site = JTParser.getSiteConfig();
    // v1.5.14:报告真实版本号(优先读 manifest,避免一直显示旧的 v1.5.10 误导)
    let realVersion = 'v1.5.29';
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        realVersion = 'v' + (chrome.runtime.getManifest().version || '1.5.29');
      }
    } catch (e) { /* 非扩展环境回退 */ }
    const report = {
      _meta: {
        url: location.href,
        timestamp: new Date().toISOString(),
        version: realVersion,
      },
      // 站点和容器信息
      siteName: site ? site.name : '未知',
      hostname: location.hostname,
      container: {
        tag: container ? container.tagName : 'null',
        class: container ? (container.className || '').toString().substring(0, 200) : '',
        id: container ? (container.id || '') : '',
        isBody: container === document.body,
        textLen: container ? getText(container).length : 0,
      },
      // 选择器匹配详情
      selectors: {},
      // 容器原始全文(调试用,尽量完整;v1.5.14 起不再截断到 1500,避免"信息不全"误判)
      rawContainerText: container ? JTParser.cleanText(getText(container)) : '',
      // body 全文长度(用于判断正文是否在 body 其他位置)
      bodyTextLen: document.body ? getText(document.body).length : 0,
      // v1.5.4:候选职位正文容器(在 body 中含职位关键词的区块,供精准加选择器用)
      candidateContainers: (function () {
        const jobKw = /职位描述|岗位描述|工作内容|岗位职责|任职要求|岗位要求|招聘要求|任职资格|具体要求|我们需要你|你需要|岗位说明|职位说明|岗位详情|职位详情|职位信息|招聘信息/i;
        const navKw = /招聘职位|联系我们|单位简介|首页|登录|注册|工商信息|法定代表人|注册资金|成立日期|企业类型|本单位职位/i;
        const list = [];
        const nodes = document.body ? document.body.querySelectorAll('div, section, article, td, li, dd, p, tr') : [];
        for (const el of nodes) {
          const t = getText(el);
          if (t.length < 80 || !jobKw.test(t) || navKw.test(t)) continue;
          list.push({
            tag: el.tagName,
            class: (el.className || '').toString().substring(0, 120),
            id: el.id || '',
            textLen: t.length,
            preview: t.substring(0, 400),
          });
          if (list.length >= 6) break;
        }
        // 按文本量降序,最可能是完整职位区块的排前面
        return list.sort((a, b) => b.textLen - a.textLen);
      })(),
      // 提取结果
      extractionResult: job ? {
        title: job.title || '',
        company: job.company || '',
        salary: job.salaryRaw || '',
        salaryRaw: job.salaryRaw || '',
        salaryMin: job.salaryMin || 0,
        salaryMax: job.salaryMax || 0,
        location: job.location || '',
        description: (job.description || '').substring(0, 2000),
        descriptionLen: (job.description || '').length,
        requirement: (job.requirement || '').substring(0, 2000),
        requirementLen: (job.requirement || '').length,
      } : null,
    };

    // 测试每个关键选择器的匹配情况
    if (site && site.selectors) {
      const keysToTest = ['title', 'company', 'salary', 'location', 'description', 'requirement'];
      for (const key of keysToTest) {
        const sels = site.selectors[key];
        if (sels && sels.length > 0) {
          report.selectors[key] = {};
          for (const sel of sels) {
            try {
              const el = (container || document.body).querySelector(sel);
              report.selectors[key][sel] = el ? {
                matched: true,
                tag: el.tagName,
                textPreview: JTParser.cleanText(getText(el)).substring(0, 200),
                textLen: getText(el).length,
              } : { matched: false };
            } catch (e) {
              report.selectors[key][sel] = { matched: false, error: e.message };
            }
          }
        }
      }
    }

    return report;
  };
})();
