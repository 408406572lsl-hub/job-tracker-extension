// ============================================================
// popup.js — 弹窗逻辑
// ============================================================

(function () {
  'use strict';

  let currentPageJob = null;

  document.addEventListener('DOMContentLoaded', async () => {
    await loadStats();
    await loadCurrentPageJob();
    await loadFiltersToggle();
    bindEvents();
  });

  // 加载统计
  async function loadStats() {
    const jobs = await JTStorage.getJobs();
    document.getElementById('statTotal').textContent = jobs.length;
    const matched = jobs.filter(j => (j.score || 0) >= 40).length;
    const unseen = jobs.filter(j => j.status === JT_STATUS.UNSEEN).length;
    document.getElementById('statMatch').textContent = matched;
    document.getElementById('statUnseen').textContent = unseen;
  }

  // 加载当前页岗位预览
  async function loadCurrentPageJob() {
    const preview = document.getElementById('pageJobPreview');
    const actions = document.getElementById('pageJobActions');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) return;

      // 尝试向 content script 请求当前页岗位
      chrome.tabs.sendMessage(tab.id, { type: 'JT_GET_PAGE_JOB' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.job) {
          // 根据 reason 区分:列表页 vs 非招聘网站
          const reason = res && res.reason;
          if (reason === 'list_page') {
            preview.innerHTML = '<div class="empty-hint">当前是岗位列表页。<br>点击列表里某个岗位进入详情页,这里会显示该岗位的匹配信息;列表页卡片上也会自动出现匹配分徽章。</div>';
          } else {
            preview.innerHTML = '<div class="empty-hint">当前页面不是招聘网站,或无法识别岗位信息。<br>支持的网站:康强医疗人才网、智联招聘、前程无忧、BOSS直聘等。</div>';
          }
          actions.style.display = 'none';
          return;
        }

        currentPageJob = res.job;
        renderJobPreview(res.job, res.evaluation);
        actions.style.display = 'flex';
        renderDebugData(res.job);
      });
    });
  }

  // 渲染岗位预览
  function renderJobPreview(job, evaluation) {
    const preview = document.getElementById('pageJobPreview');
    const level = JTFilters.getMatchLevel(evaluation.score);

    const reasonsHtml = (job.matchReasons || []).length
      ? `<div class="match-reasons">${job.matchReasons.map(r => '• ' + JTUi.escapeHtml(r)).join('<br>')}</div>`
      : '';

    const salaryUnknown = !job.salaryRaw || job.salaryRaw === '薪资面议' || job.salaryRaw === '面议';
    preview.innerHTML = `
      <div class="job-title-main">${JTUi.escapeHtml(job.title || '未知岗位')}</div>
      <div class="job-field">
        <span class="job-field-label">公司:</span>
        <span class="job-field-value">${JTUi.escapeHtml(job.company || '未知')}</span>
      </div>
      <div class="job-field">
        <span class="job-field-label">地点:</span>
        <span class="job-field-value">${JTUi.escapeHtml(job.location || '未知')}</span>
        <span class="job-field-label" style="margin-left:12px">薪资:</span>
        <span class="job-field-value ${salaryUnknown ? 'salary-unknown' : ''}" id="salaryDisplay">${JTUi.escapeHtml(job.salaryRaw || '薪资面议')}</span>
        <span class="salary-edit-btn" id="salaryEditBtn" style="font-size:11px;color:#1677ff;cursor:pointer;margin-left:6px">${salaryUnknown ? '填写薪资' : '修改'}</span>
      </div>
      <div class="job-field">
        <span class="job-field-label">来源:</span>
        <span class="job-field-value">${JTUi.escapeHtml(job.site || '')}</span>
      </div>
      <div class="score-badge score-${level}">匹配 ${evaluation.score} 分 · ${JTUi.LEVEL_LABELS[level]}</div>
      ${reasonsHtml}
    `;
    // 绑定手动填写薪资事件
    document.getElementById('salaryEditBtn').addEventListener('click', async () => {
      const val = prompt('手动填写薪资(如:5-8K、月薪5000-8000):', job.salaryRaw === '薪资面议' || job.salaryRaw === '面议' ? '' : job.salaryRaw);
      if (val !== null && val.trim()) {
        job.salaryRaw = val.trim();
        const parsed = JTParser.parseSalary(val.trim());
        job.salaryMin = parsed.min;
        job.salaryMax = parsed.max;
        await JTStorage.saveJob(job);
        renderJobPreview(job, evaluation);
      }
    });
  }

  // 加载筛选开关状态
  async function loadFiltersToggle() {
    const filters = await JTStorage.getFilters();
    document.getElementById('toggleCert').checked = !!filters.excludeCertRequired;
    document.getElementById('toggleExp').checked = !!filters.excludeExpRequired;
  }

  // 绑定事件
  function bindEvents() {
    // 保存当前页岗位
    document.getElementById('btnSave').addEventListener('click', async () => {
      if (!currentPageJob) return;
      const btn = document.getElementById('btnSave');
      btn.textContent = '保存中…';
      btn.disabled = true;

      const result = await JTStorage.saveJob(currentPageJob);
      btn.textContent = result.action === 'added' ? '已记录 ✓' : '已更新 ✓';
      await loadStats();
      setTimeout(() => {
        btn.textContent = '记录此岗位';
        btn.disabled = false;
      }, 1500);

      // 保存即自动分析(受 autoAnalyze 开关 + analyzePerDay 日上限约束,失败静默)
      // 异步执行,不阻塞 UI;background 的 persistAiScore 会把 AI 分写回存储
      if (result.action === 'added') {
        JTAnalyzeHelper.maybeAutoAnalyze(result.job).then((r) => {
          if (r.analyzed && r.analysis) {
            // 分析成功,更新内存中的岗位预览(以便用户点「AI 深度分析」能看到缓存结果)
            currentPageJob.aiFitScore = r.analysis.fitScore;
            currentPageJob.aiAnalysis = r.analysis;
            currentPageJob.aiAnalyzedAt = Date.now();
          }
        }).catch(() => { /* 静默 */ });
      }
    });

    // 打开 dashboard
    document.getElementById('btnDashboard').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    });

    // 编辑筛选条件 → 打开 dashboard 的筛选区
    document.getElementById('btnEditFilters').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#filters') });
    });

    // 重新扫描
    document.getElementById('btnRescan').addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'JT_RESCAN' }, () => {
          window.close();
        });
      });
    });

    // 筛选开关变化
    document.getElementById('toggleCert').addEventListener('change', async (e) => {
      const filters = await JTStorage.getFilters();
      filters.excludeCertRequired = e.target.checked;
      await JTStorage.saveFilters(filters);
    });

    document.getElementById('toggleExp').addEventListener('change', async (e) => {
      const filters = await JTStorage.getFilters();
      filters.excludeExpRequired = e.target.checked;
      await JTStorage.saveFilters(filters);
    });

    // AI 深度分析
    document.getElementById('btnAnalyze').addEventListener('click', () => runAnalyze());

    // AI 设置
    document.getElementById('btnAiSettings').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
    });

    // HR 回复助手 → 打开 dashboard 的 HR 回复标签
    document.getElementById('btnHrReply').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#hr') });
    });
  }

  // ----------------------------------------------------------
  // AI 深度分析(适配度 + 避坑)
  // ----------------------------------------------------------
  async function runAnalyze(force) {
    const resultEl = document.getElementById('aiResult');
    const btn = document.getElementById('btnAnalyze');
    if (!currentPageJob) return;

    btn.disabled = true;
    btn.textContent = '分析中…';
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<div class="ai-loading">正在调用大模型分析,约需 10-30 秒</div>';

    chrome.runtime.sendMessage({ type: 'JT_LLM_ANALYZE', job: currentPageJob, force: !!force }, (res) => {
      btn.disabled = false;
      btn.textContent = 'AI 深度分析';
      if (chrome.runtime.lastError || !res) {
        resultEl.innerHTML = '<div class="ai-error">分析失败:无法连接到插件后台</div>';
        return;
      }
      if (!res.ok) {
        if (res.needSettings) {
          resultEl.innerHTML = `<div class="ai-error">${JTUi.escapeHtml(res.error)} <a href="#" id="aiGoSettings">前往设置 →</a></div>`;
          document.getElementById('aiGoSettings').addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
          });
        } else {
          let html = `<div class="ai-error">${JTUi.escapeHtml(res.error || '分析失败')}</div>`;
          if (res.raw) {
            html += `<details class="ai-raw-details"><summary>查看模型原始返回</summary><pre class="ai-raw-pre">${JTUi.escapeHtml(res.raw)}</pre></details>`;
          }
          resultEl.innerHTML = html;
        }
        return;
      }
      // 计算本地规则匹配分,与 AI 分并列展示
      JTStorage.getFilters().then((filters) => {
        const localEval = JTFilters.evaluate(currentPageJob, filters);
        renderAiResult(res, localEval.score);
      }).catch(() => {
        renderAiResult(res, null);
      });
    });
  }

  function renderAiResult(res, localScore) {
    const resultEl = document.getElementById('aiResult');
    const a = res.analysis || {};
    let html = JTUi.renderAiAnalysisHtml(a, localScore);
    // 企业信息状态提示(三态,始终可见,让用户明确知道"查没查 / 查到什么")
    html += renderCompanyRiskBadge(res.companyRisk, res.companyRiskMeta);
    html += '<div class="ai-reanalyze">';
    if (res.cached) html += '<span class="ai-cache-hint">（缓存结果,24h 内复用）</span>';
    html += '<button id="btnReanalyze" class="btn btn-secondary">↻ 重新分析</button></div>';
    resultEl.innerHTML = html;
    const rb = document.getElementById('btnReanalyze');
    if (rb) rb.addEventListener('click', () => runAnalyze(true));
  }

  // 企业信息状态徽标(三态可见):已结合 / 已查但无数据 / 未结合(含原因)
  function renderCompanyRiskBadge(companyRisk, meta) {
    if (companyRisk && companyRisk.legalName) {
      // 查到企业:绿色卡片
      const r = companyRisk;
      const riskTxt = (r.riskLevel === 'low') ? '低风险' : (r.riskLevel === 'high') ? '高风险' : '未知';
      const jud = r.judicialRisk && r.judicialRisk.level ? ('司法风险:' + (r.judicialRisk.level === 'low' ? '低' : r.judicialRisk.level === 'mid' ? '中' : r.judicialRisk.level)) : '';
      return '<div class="cr-badge cr-ok" style="margin-top:10px">✅ 已结合企业信息分析：' +
        JTUi.escapeHtml(r.legalName) + ' · ' + JTUi.escapeHtml(r.legalStatus || '状态未知') +
        (r.insuredCount != null ? ' · 参保' + r.insuredCount + '人' : '') +
        ' · ' + riskTxt + (jud ? ' · ' + jud : '') + '</div>';
    }
    if (meta && meta.queried && !meta.found) {
      // 查了天眼查但无匹配企业/无风险记录:蓝灰提示
      return '<div class="cr-badge cr-info" style="margin-top:10px">ℹ️ 已查询企业信息：' +
        JTUi.escapeHtml(meta.note || '天眼查未返回该企业工商数据') + '（本次分析未纳入企业维度）</div>';
    }
    // 根本没查:黄色提示,说明原因
    const reason = (!meta) ? '天眼查桥接未连接或未配置 API Key' :
      (meta.note || '天眼查查询未执行');
    return '<div class="cr-badge cr-warn" style="margin-top:10px">⚠️ 本次未结合企业信息分析（' +
      JTUi.escapeHtml(reason) + '）。在设置页填写天眼查 Key 并保持 mcp-bridge 运行后重试，可纳入企业真实性、行业错配与司法风险。</div>';
  }

  // 渲染调试数据面板(显示插件从页面抓取的全部原始字段)
  function renderDebugData(job) {
    const el = document.getElementById('debugData');
    if (!el || !job) return;

    // 关键字段高亮显示
    const fields = [
      { label: 'title', value: job.title, hint: '岗位标题' },
      { label: 'company', value: job.company, hint: '公司名' },
      { label: 'location', value: job.location, hint: '工作地点' },
      { label: 'salaryRaw', value: job.salaryRaw, hint: '原始薪资文本' },
      { label: 'salaryMin', value: job.salaryMin, hint: '解析后最低薪资(数字)' },
      { label: 'salaryMax', value: job.salaryMax, hint: '解析后最高薪资(数字)' },
      { label: 'site', value: job.site, hint: '识别的站点名称' },
      { label: 'url', value: job.url ? job.url.substring(0, 120) + (job.url.length > 120 ? '...' : '') : '', hint: '页面 URL(截断显示)' }
    ];

    let html = '<table class="debug-table"><tbody>';

    fields.forEach(f => {
      const v = f.value !== undefined && f.value !== null ? f.value : '(空)';
      const cls = !f.value || f.value === '' ? 'debug-empty' : '';
      html += `<tr><td class="debug-label">${JTUi.escapeHtml(f.label)}</td><td class="debug-value ${cls}" title="${JTUi.escapeHtml(f.hint)}">${JTUi.escapeHtml(String(v))}</td></tr>`;
    });

    html += '</tbody></table>';

    // DOM 诊断信息
    const d = job._debug;
    if (d) {
      html += '<details open><summary style="cursor:pointer;font-weight:700;color:#dc2626;font-size:11px;margin-top:8px">🔧 DOM 诊断(提取链路)</summary>';
      html += '<table class="debug-table" style="margin-top:4px"><tbody>';
      const diagFields = [
        ['容器元素', d.containerTag + '.' + d.containerClass],
        ['容器ID', d.containerId || '(无)'],
        ['是否退回body', d.isBody ? '⚠️ 是(选择器全失败)' : '否'],
        ['容器文本量', String(d.containerTextLen || 0) + '字'],
        ['含正文section标题', d.hasBodySection ? '✅ 是' : '❌ 否(可能选到纯头部)'],
        ['站点', d.siteName],
        ['区块提取模式', d.sectionEnabled ? '已启用' : '未启用'],
        ['内容选择器', d.contentSelector],
        ['.job-sec-text 数量', String(d.secTextCount)],
        ['首个块预览', d.secTextPreview || '(无)'],
      ];
      diagFields.forEach(([k, v]) => {
        const cls = (k === '.job-sec-text 数量' && d.secTextCount === 0) || (k === '含正文section标题' && !d.hasBodySection) ? 'debug-empty' : '';
        html += `<tr><td class="debug-label">${JTUi.escapeHtml(k)}</td><td class="debug-value ${cls}">${JTUi.escapeHtml(v)}</td></tr>`;
      });
      html += '</tbody></table>';
      // 容器全文预览(折叠)
      if (d.containerPreview) {
        html += `<details class="debug-long-text"><summary>容器 innerText 全文 (${d.containerTextLen || 0}字)</summary><pre class="debug-pre">${JTUi.escapeHtml(d.containerPreview)}</pre></details>`;
      }
      html += '</details>';
    }

    // description 和 requirement 单独展示(长文本可折叠)
    if (job.description) {
      html += `<details class="debug-long-text"><summary>description（岗位职责 · ${String(job.description).length}字）</summary><pre class="debug-pre">${JTUi.escapeHtml(job.description)}</pre></details>`;
    } else {
      html += `<div class="debug-missing">description: (未提取到)</div>`;
    }

    if (job.requirement) {
      html += `<details class="debug-long-text"><summary>requirement（任职要求 · ${String(job.requirement).length}字）</summary><pre class="debug-pre">${JTUi.escapeHtml(job.requirement)}</pre></details>`;
    } else {
      html += `<div class="debug-missing">requirement: (未提取到 — ⚠️ 如果页面上有"任职要求"但这里为空,说明选择器没匹配上!)</div>`;
    }

    // v1.5.3 调试后门:复制完整诊断报告 + 自动桥接
    html += '<div style="margin-top:8px;text-align:center">';
    html += '<button id="btnCopyDiag" class="btn btn-secondary" style="font-size:11px;padding:4px 10px">📋 复制完整诊断报告</button>';
    html += '</div>';

    el.innerHTML = html;

    // 绑定复制按钮事件
    const btnCopy = document.getElementById('btnCopyDiag');
    if (btnCopy) {
      btnCopy.addEventListener('click', async () => {
        try {
          const report = await fetchFullDiagnosticReport(job);
          const text = JSON.stringify(report, null, 2);
          // 写入剪贴板
          await navigator.clipboard.writeText(text);
          btnCopy.textContent = '✅ 已复制! (可直接粘贴给 AI)';
          btnCopy.style.color = '#16a34a';
          setTimeout(() => { btnCopy.textContent = '📋 复制完整诊断报告'; btnCopy.style.color = ''; }, 2500);
          // 同时写入 chrome.storage 作为桥接(供 AI 直接读取)
          chrome.storage.local.set({ '_jt_debug_bridge': { report, url: job.url || '', timestamp: Date.now() } });
        } catch (e) {
          btnCopy.textContent = '❌ 复制失败: ' + e.message;
          btnCopy.style.color = '#dc2626';
        }
      });
    }
  }

  // v1.5.3 从 content script 获取完整诊断报告(含选择器匹配详情 + 容器原始文本)
  async function fetchFullDiagnosticReport(job) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab) resolve({ error: '无活动标签页' });
        chrome.tabs.sendMessage(tab.id, { type: 'JT_GET_FULL_DIAG' }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve({ error: '无法获取诊断数据', partialDebug: (job && job._debug) || null });
          } else {
            resolve(res.report || res);
          }
        });
      });
    });
  }
})();
