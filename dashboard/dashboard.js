// ============================================================
// dashboard.js — 管理面板逻辑
// 岗位列表渲染、筛选、排序、状态管理、导出、弹窗详情
// ============================================================

(function () {
  'use strict';

  let allJobs = [];
  let filters = null;
  let settings = null;
  let selectedIds = new Set();
  let currentModalJob = null;

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      filters = await JTStorage.getFilters();
      settings = await JTStorage.getSettings();
      allJobs = await JTStorage.getJobs();
    } catch (e) {
      console.error('[JT] 初始化数据加载失败:', e);
      document.body.insertAdjacentHTML('afterbegin',
        '<div style="padding:16px;background:#fee;border:1px solid #c33;color:#c33;border-radius:8px;margin:12px;">数据加载失败,请刷新页面重试。错误: ' + String(e).replace(/</g, '&lt;') + '</div>');
      return;
    }

    // 给所有岗位重新计算匹配分
    recomputeScores();

    renderFilterPanel();
    renderSettings();
    renderStats();
    renderJobList();

    bindEvents();
    initTabs();
    loadHrJobContext();
    initAutoScanBar();

    // URL hash 路由
    if (location.hash === '#filters') {
      document.getElementById('filterPanel').scrollIntoView();
    } else if (location.hash === '#hr') {
      switchTab('hr');
    } else if (location.hash === '#resume') {
      switchTab('resume');
    } else if (location.hash === '#autoscan' || location.hash === '#autoscan-run') {
      // 从设置页"立即扫描"跳来,或 SW 闹钟唤醒 → 自动启动扫描
      setTimeout(() => startScanFromDashboard(), 500);
    }
  });

  // ----------------------------------------------------------
  // 标签切换
  // ----------------------------------------------------------
  function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        if (target === 'settings') {
          window.location.href = '../settings/settings.html';
          return;
        }
        switchTab(target);
      });
    });
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.getElementById('tabJobs').style.display = (name === 'jobs') ? 'flex' : 'none';
    document.getElementById('tabHr').style.display = (name === 'hr') ? 'flex' : 'none';
    document.getElementById('tabResume').style.display = (name === 'resume') ? 'flex' : 'none';
    if (name === 'resume') loadResumeTab();
  }

  // 加载已记录岗位到 HR 关联下拉
  function loadHrJobContext() {
    const sel = document.getElementById('hrJobContext');
    if (!sel) return;
    sel.innerHTML = '<option value="">不关联</option>';
    allJobs.slice(0, 100).forEach(job => {
      const opt = document.createElement('option');
      opt.value = job.id;
      opt.textContent = (job.title || '未知') + ' - ' + (job.company || '');
      sel.appendChild(opt);
    });
  }

  // 将 AI 分析结果写回内存中的岗位对象(统一供 runModalAnalyze/batchAnalyze/importJobs 使用)
  function applyAiResultToJob(jobId, analysis) {
    if (!analysis || typeof analysis.fitScore !== 'number') return false;
    const idx = allJobs.findIndex(j => j.id === jobId);
    if (idx < 0) return false;
    allJobs[idx] = Object.assign({}, allJobs[idx], {
      aiFitScore: analysis.fitScore,
      aiAnalysis: analysis,
      aiAnalyzedAt: Date.now()
    });
    return true;
  }

  // 重新计算所有岗位的匹配分
  // 评分优先级：AI 适配度分(aiFitScore) > 规则筛选分
  // 这样管理面板的排序/筛选/分数标签都以 AI 给出的评分为准,未做过 AI 分析的岗位回退规则分
  function recomputeScores() {
    allJobs = allJobs.map(job => {
      const result = JTFilters.evaluate(job, filters);
      const hasAi = (typeof job.aiFitScore === 'number');
      const score = hasAi ? job.aiFitScore : result.score;
      const scoreSource = hasAi ? 'ai' : 'rule';
      return { ...job, score, scoreSource, matchReasons: result.reasons, matched: result.matched };
    });
  }

  // 渲染筛选面板(把当前 filters 填入表单)
  function renderFilterPanel() {
    document.getElementById('fInclude').value = (filters.includeKeywords || []).join(', ');
    document.getElementById('fExclude').value = (filters.excludeKeywords || []).join(', ');
    document.getElementById('fCities').value = (filters.cities || []).join(', ');
    document.getElementById('fMinSalary').value = filters.minSalary || '';
    document.getElementById('fMaxSalary').value = filters.maxSalary || '';
    document.getElementById('fCert').checked = !!filters.excludeCertRequired;
    document.getElementById('fExp').checked = !!filters.excludeExpRequired;
    document.getElementById('fMinScore').value = filters.minScore || 40;
    document.getElementById('fMinScoreVal').textContent = filters.minScore || 40;
  }

  // 渲染设置
  function renderSettings() {
    document.getElementById('settingShowBadges').checked = settings.showBadges !== false;
  }

  // 渲染统计
  function renderStats() {
    const stats = JTStorage.getStats(allJobs);
    document.getElementById('sTotal').textContent = stats.total;
    document.getElementById('sHigh').textContent = stats.high;
    document.getElementById('sMatch').textContent = stats.matched;
    document.getElementById('sApplied').textContent = stats.byStatus.applied || 0;
    document.getElementById('sInterview').textContent = stats.byStatus.interview || 0;
    document.getElementById('sOffer').textContent = stats.byStatus.offer || 0;
  }

  // 获取过滤后的岗位列表
  function getFilteredJobs() {
    const onlyMatched = document.getElementById('fOnlyMatched').checked;
    const hideRejected = document.getElementById('fHideRejected').checked;
    const statusFilter = document.getElementById('fStatus').value;
    const searchQuery = document.getElementById('fSearch').value.trim().toLowerCase();
    const sortBy = document.getElementById('sortBy').value;

    let result = [...allJobs];

    if (onlyMatched) result = result.filter(j => (j.score || 0) >= (filters.minScore || 40));
    if (hideRejected) result = result.filter(j => j.status !== 'rejected');
    if (statusFilter) result = result.filter(j => j.status === statusFilter);
    if (searchQuery) {
      result = result.filter(j =>
        (j.title || '').toLowerCase().includes(searchQuery) ||
        (j.company || '').toLowerCase().includes(searchQuery)
      );
    }

    // 排序
    result.sort((a, b) => {
      if (sortBy === 'score') return (b.score || 0) - (a.score || 0);
      if (sortBy === 'capturedAt') return (b.capturedAt || 0) - (a.capturedAt || 0);
      if (sortBy === 'salaryMax') return (b.salaryMax || 0) - (a.salaryMax || 0);
      if (sortBy === 'title') return (a.title || '').localeCompare(b.title || '', 'zh-CN');
      return 0;
    });

    return result;
  }

  // 渲染岗位列表
  function renderJobList() {
    const list = document.getElementById('jobList');
    const jobs = getFilteredJobs();
    document.getElementById('resultCount').textContent = `共 ${jobs.length} 条`;

    if (jobs.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p>没有匹配的岗位</p>
          <p class="empty-hint">试试调整筛选条件,或去招聘网站记录更多岗位</p>
        </div>`;
      return;
    }

    list.innerHTML = jobs.map(job => {
      const level = JTFilters.getMatchLevel(job.score || 0);
      const statusLabel = JT_STATUS_LABELS[job.status] || '待看';
      const reasons = (job.matchReasons || []).slice(0, 3).map(r => '• ' + r).join('  ');
      const checked = selectedIds.has(job.id) ? 'checked' : '';
      const aiMark = job.scoreSource === 'ai' ? '<span class="score-src" title="AI 综合评估分">AI</span>' : '';

      return `
        <div class="job-card ${checked ? 'selected' : ''}" data-id="${job.id}">
          <div class="job-card-left">
            <input type="checkbox" class="job-card-checkbox" data-id="${job.id}" ${checked}>
          </div>
          <div class="job-card-main">
            <div class="job-card-title-row">
              <span class="job-card-title"><a href="${JTUi.escapeAttr(JTUi.safeUrl(job.url))}" target="_blank" data-stop="1">${JTUi.escapeHtml(job.title || '未知岗位')}</a></span>
            </div>
            <div class="job-card-meta">
              <span>${JTUi.escapeHtml(job.company || '未知公司')}</span>
              <span>${JTUi.escapeHtml(job.location || '地点未知')}</span>
              <span class="job-card-salary">${JTUi.escapeHtml(job.salaryRaw || '面议')}</span>
              <span>${JTUi.escapeHtml(job.site || '')}</span>
              <span>${JTUi.formatDate(job.capturedAt)}</span>
            </div>
            ${reasons ? `<div class="job-card-reasons">${JTUi.escapeHtml(reasons)}</div>` : ''}
          </div>
          <div class="job-card-right">
            <span class="score-tag score-tag-${level}">${aiMark}${job.score || 0} · ${JTUi.LEVEL_LABELS[level]}</span>
            <span class="status-tag status-${job.status || 'unseen'}">${statusLabel}</span>
          </div>
        </div>`;
    }).join('');
  }

  // 绑定事件
  function bindEvents() {
    // 应用筛选
    document.getElementById('btnApplyFilters').addEventListener('click', applyFilters);

    // 恢复默认
    document.getElementById('btnResetFilters').addEventListener('click', async () => {
      if (!confirm('确定恢复默认筛选条件?当前自定义条件将被覆盖。')) return;
      filters = { ...JT_CONFIG.defaultFilters };
      await JTStorage.saveFilters(filters);
      renderFilterPanel();
      recomputeScores();
      renderStats();
      renderJobList();
      await persistJobs();
    });

    // 最低分滑块
    document.getElementById('fMinScore').addEventListener('input', (e) => {
      document.getElementById('fMinScoreVal').textContent = e.target.value;
    });

    // 显示筛选变化即刷新(fSearch 用 input 事件需防抖,避免每键一次全量重渲染)
    let searchTimer = null;
    ['fOnlyMatched', 'fHideRejected', 'fStatus', 'sortBy'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('change', renderJobList);
    });
    const searchEl = document.getElementById('fSearch');
    searchEl.addEventListener('change', renderJobList);
    searchEl.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(renderJobList, 300);
    });

    // 设置变化
    document.getElementById('settingShowBadges').addEventListener('change', async (e) => {
      settings.showBadges = e.target.checked;
      await JTStorage.saveSettings(settings);
    });

    // 导出
    document.getElementById('btnExportCSV').addEventListener('click', () => exportData('csv'));
    document.getElementById('btnExportJSON').addEventListener('click', () => exportData('json'));

    // 自动扫描入口
    document.getElementById('btnAutoScan').addEventListener('click', () => {
      window.location.href = '../settings/autoscan.html';
    });
    // 批量 AI 分析(对管理面板中尚未分析的岗位)
    document.getElementById('btnBatchAnalyze').addEventListener('click', batchAnalyzeJobs);
    // 导入岗位(JSON / CSV)
    document.getElementById('btnImport').addEventListener('click', () => {
      document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importJobsFromFile(file);
      e.target.value = ''; // 允许重复选同一文件
    });
    const runNowBtn = document.getElementById('btnRunScanNow');
    const stopBtn = document.getElementById('btnStopScan');
    if (runNowBtn) {
      runNowBtn.addEventListener('click', startScanFromDashboard);
    }
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        JTScanController.stop();
      });
    }

    // 监听来自 SW 的闹钟唤醒消息
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'JT_SCAN_START_FROM_ALARM') {
        startScanFromDashboard();
        sendResponse({ ok: true });
      }
    });

    // 清空(记入墓碑:清空后自动扫描也不会再把这批岗位加回)
    document.getElementById('btnClearAll').addEventListener('click', async () => {
      if (!confirm('确定清空所有已记录的岗位?此操作不可撤销!')) return;
      if (!confirm('再次确认:真的要删除全部 ' + allJobs.length + ' 条记录吗?\n\n注意:清空的岗位会被记入"已删除",之后自动扫描也不会再收录它们。\n如需重新收录,请到「自动扫描设置」页点"清空删除记录"。')) return;
      await JTStorage.clearAll({ tombstone: true });
      allJobs = [];
      selectedIds.clear();
      renderStats();
      renderJobList();
    });

    // 全选 / 删除选中
    document.getElementById('btnSelectAll').addEventListener('click', () => {
      const jobs = getFilteredJobs();
      const allSelected = jobs.every(j => selectedIds.has(j.id));
      if (allSelected) {
        jobs.forEach(j => selectedIds.delete(j.id));
      } else {
        jobs.forEach(j => selectedIds.add(j.id));
      }
      renderJobList();
    });

    document.getElementById('btnDeleteSelected').addEventListener('click', async () => {
      if (selectedIds.size === 0) { alert('请先选择要删除的岗位'); return; }
      if (!confirm(`确定删除选中的 ${selectedIds.size} 条记录?`)) return;
      await JTStorage.deleteJobs([...selectedIds]);
      allJobs = allJobs.filter(j => !selectedIds.has(j.id));
      selectedIds.clear();
      renderStats();
      renderJobList();
    });

    // 岗位卡片点击(委托)
    document.getElementById('jobList').addEventListener('click', (e) => {
      // 复选框
      if (e.target.classList.contains('job-card-checkbox')) {
        const id = e.target.dataset.id;
        if (e.target.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        e.target.closest('.job-card').classList.toggle('selected');
        return;
      }
      // 链接点击不弹窗
      if (e.target.tagName === 'A' || e.target.closest('a')) return;
      // 卡片点击 → 打开弹窗
      const card = e.target.closest('.job-card');
      if (card) {
        openJobModal(card.dataset.id);
      }
    });

    // 弹窗
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.querySelector('.modal-overlay').addEventListener('click', closeModal);
    document.getElementById('modalSave').addEventListener('click', saveModalJob);
    document.getElementById('modalDelete').addEventListener('click', deleteModalJob);

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // —— HR 回复:意图选择 ——
    document.getElementById('intentGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.intent-btn');
      if (!btn) return;
      document.querySelectorAll('.intent-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });

    // —— HR 回复:生成 ——
    document.getElementById('btnGenerateReply').addEventListener('click', generateReply);

    // —— 详情弹窗:AI 分析 ——
    document.getElementById('btnModalAnalyze').addEventListener('click', runModalAnalyze);
  }

  // ----------------------------------------------------------
  // HR 回复生成
  // ----------------------------------------------------------
  async function generateReply() {
    const hrMessage = document.getElementById('hrMessage').value.trim();
    const intentBtn = document.querySelector('.intent-btn.active');
    const intent = intentBtn ? intentBtn.dataset.intent : 'other';
    const style = document.getElementById('hrStyle').value;

    // 关联岗位上下文
    const jobId = document.getElementById('hrJobContext').value;
    const job = allJobs.find(j => j.id === jobId);
    const context = { jobTitle: job ? job.title : '' };

    const output = document.getElementById('hrOutput');
    const btn = document.getElementById('btnGenerateReply');
    btn.disabled = true;
    btn.textContent = '生成中…';
    output.innerHTML = '<div class="hr-loading">正在生成回复,约需 10-20 秒…</div>';

    chrome.runtime.sendMessage({ type: 'JT_LLM_REPLY', hrMessage, intent, style, context }, (res) => {
      btn.disabled = false;
      btn.textContent = '生成回复';
      if (chrome.runtime.lastError || !res) {
        output.innerHTML = '<div class="ai-error">生成失败:无法连接到插件后台</div>';
        return;
      }
      if (!res.ok) {
        if (res.needSettings) {
          output.innerHTML = `<div class="ai-error">${JTUi.escapeHtml(res.error)} <a href="../settings/settings.html">前往 AI 设置 →</a></div>`;
        } else {
          output.innerHTML = `<div class="ai-error">${JTUi.escapeHtml(res.error || '生成失败')}</div>`;
        }
        return;
      }
      renderHrOutput(res.versions);
    });
  }

  function renderHrOutput(versions) {
    const output = document.getElementById('hrOutput');
    output.innerHTML = versions.map((text, i) => `
      <div class="reply-card">
        <div class="reply-card-label">${i === 0 ? '推荐版本' : '备选版本 ' + i}</div>
        <div class="reply-card-text">${JTUi.escapeHtml(text)}</div>
        <div class="reply-card-actions">
          <button class="btn btn-primary btn-sm" data-copy="${JTUi.escapeAttr(text)}">复制</button>
        </div>
      </div>
    `).join('') + `<button id="btnRegen" class="btn btn-outline btn-block" style='margin-top:8px'>↻ 重新生成</button>`;

    // 复制按钮
    output.querySelectorAll('[data-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.copy).then(() => {
          const orig = btn.textContent;
          btn.textContent = '已复制 ✓';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        });
      });
    });
    // 重新生成
    const regen = document.getElementById('btnRegen');
    if (regen) regen.addEventListener('click', generateReply);
  }

  // ----------------------------------------------------------
  // 详情弹窗 AI 分析
  // ----------------------------------------------------------
  async function runModalAnalyze(force) {
    if (!currentModalJob) return;
    const el = document.getElementById('aiModalResult');
    const btn = document.getElementById('btnModalAnalyze');
    btn.disabled = true;
    btn.textContent = '分析中…';
    el.innerHTML = '<div class="hr-loading">正在调用大模型分析,约需 10-30 秒…</div>';

    chrome.runtime.sendMessage({ type: 'JT_LLM_ANALYZE', job: currentModalJob, force: !!force }, (res) => {
      btn.disabled = false;
      btn.textContent = '🤖 AI 分析此岗位';
      if (chrome.runtime.lastError || !res) {
        el.innerHTML = '<div class="ai-error">分析失败:无法连接到插件后台</div>';
        return;
      }
      if (!res.ok) {
        if (res.needSettings) {
          el.innerHTML = `<div class="ai-error">${JTUi.escapeHtml(res.error)} <a href="../settings/settings.html">前往 AI 设置 →</a></div>`;
        } else {
          let html = `<div class="ai-error">${JTUi.escapeHtml(res.error || '分析失败')}</div>`;
          if (res.raw) {
            html += `<details class="ai-raw-details"><summary>查看模型原始返回</summary><pre class="ai-raw-pre">${JTUi.escapeHtml(res.raw)}</pre></details>`;
          }
          el.innerHTML = html;
        }
        return;
      }
      renderModalAiResult(res, currentModalJob.score);

      // 分析成功后即时把 AI 分写回内存岗位,并重算/重渲染(以 AI 分为主)
      if (res.analysis && typeof res.analysis.fitScore === 'number') {
        if (applyAiResultToJob(currentModalJob.id, res.analysis)) {
          currentModalJob = allJobs.find(j => j.id === currentModalJob.id);
          recomputeScores();
          renderStats();
          renderJobList();
          persistJobs();
        }
      }
    });
  }

  // ----------------------------------------------------------
  // 批量 AI 分析:对管理面板中尚未分析的岗位逐一跑 AI 适配度分析
  // ----------------------------------------------------------
  // 单岗位分析(返回 Promise,供批量复用;复用后台 JT_LLM_ANALYZE)
  function analyzeOneJob(job) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'JT_LLM_ANALYZE', job, force: false }, (res) => {
        if (chrome.runtime.lastError || !res) resolve(null);
        else resolve(res);
      });
    });
  }

  async function batchAnalyzeJobs() {
    if (!allJobs || allJobs.length === 0) {
      alert('管理面板还没有岗位,请先采集或记录岗位。');
      return;
    }
    // 仅分析尚未分析过的岗位(无 aiFitScore 的)
    const unanalyzed = allJobs.filter(j => j && j.id && typeof j.aiFitScore !== 'number');
    if (unanalyzed.length === 0) {
      alert('所有岗位都已分析过了。如需重分析,可在岗位详情里点"重新分析"。');
      return;
    }
    // 上限保护:默认每批最多 30 个,若自动扫描设置了更低的分析上限则取较小值
    let cap = 30;
    try {
      const cfg = await JTStorage.getAutoScan();
      if (cfg && cfg.analyzePerDay > 0) cap = Math.min(cap, cfg.analyzePerDay);
    } catch (e) { /* 忽略,用默认上限 */ }
    const queue = unanalyzed.slice(0, cap);

    if (!confirm(`将对 ${queue.length} 个未分析岗位做 AI 分析(可分析共 ${unanalyzed.length} 个,本次上限 ${cap} 个)。\n\n每个约消耗 1 次大模型调用,可能产生 API 费用。是否继续?`)) {
      return;
    }

    const btn = document.getElementById('btnBatchAnalyze');
    const panel = document.getElementById('scanProgressPanel');
    const title = document.getElementById('scanProgressTitle');
    const bar = document.getElementById('scanProgressBar');
    const detail = document.getElementById('scanProgressDetail');
    if (btn) btn.disabled = true;
    if (panel) panel.style.display = '';
    if (title) title.textContent = `批量 AI 分析 0/${queue.length} …`;
    if (bar) bar.style.width = '0%';

    let success = 0, fail = 0;
    for (let i = 0; i < queue.length; i++) {
      const job = queue[i];
      if (title) title.textContent = `批量 AI 分析 ${i + 1}/${queue.length}:${job.title || ''}`;
      if (bar) bar.style.width = Math.round((i / queue.length) * 100) + '%';
      try {
        const res = await analyzeOneJob(job);
        if (res && res.ok && res.analysis && typeof res.analysis.fitScore === 'number') {
          applyAiResultToJob(job.id, res.analysis);
          success++;
        } else {
          fail++;
        }
      } catch (e) {
        fail++;
      }
      if (detail) detail.textContent = `成功 ${success} · 失败 ${fail}`;
      await new Promise(r => setTimeout(r, 800)); // 节流,降低 API 限频/风控风险
    }

    recomputeScores();
    renderStats();
    renderJobList();
    persistJobs();

    if (bar) bar.style.width = '100%';
    if (title) title.textContent = `批量 AI 分析完成:成功 ${success},失败 ${fail}`;
    setTimeout(() => { if (panel) panel.style.display = 'none'; }, 1800);
    if (btn) btn.disabled = false;
    alert(`批量 AI 分析完成。\n成功:${success} 失败:${fail}\n评分已更新,列表已刷新。`);
  }

  // ----------------------------------------------------------
  // 导入岗位(JSON / CSV)→ 入库 + 自动分析
  // ----------------------------------------------------------
  async function importJobsFromFile(file) {
    const name = file.name || '';
    const lower = name.toLowerCase();
    let text;
    try {
      text = await file.text();
    } catch (e) {
      alert('读取文件失败:' + (e.message || e));
      return;
    }
    // 去除 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    let jobs = [];
    try {
      if (lower.endsWith('.json')) {
        jobs = parseImportJSON(text);
      } else if (lower.endsWith('.csv')) {
        jobs = parseImportCSV(text);
      } else {
        // 自动嗅探
        const trimmed = text.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          jobs = parseImportJSON(text);
        } else {
          jobs = parseImportCSV(text);
        }
      }
    } catch (e) {
      alert('解析文件失败:' + (e.message || e) + '\n请确认文件格式正确(JSON 或 CSV)。');
      return;
    }

    if (!jobs || jobs.length === 0) {
      alert('文件中没有可导入的岗位数据。');
      return;
    }

    if (!confirm(`检测到 ${jobs.length} 条岗位,确认导入?\n导入后会自动对未分析岗位触发 AI 分析(受每日上限约束)。`)) {
      return;
    }

    // 入库
    const panel = document.getElementById('scanProgressPanel');
    const title = document.getElementById('scanProgressTitle');
    const bar = document.getElementById('scanProgressBar');
    const detail = document.getElementById('scanProgressDetail');
    if (panel) panel.style.display = '';
    if (title) title.textContent = '导入岗位中…';
    if (bar) bar.style.width = '0%';

    const saved = await JTStorage.saveJobs(jobs);
    if (detail) detail.textContent = `入库:新增 ${saved.added},更新 ${saved.updated}`;

    // 刷新内存
    allJobs = await JTStorage.getJobs();
    recomputeScores();
    renderStats();
    renderJobList();

    // 自动分析未分析岗位(复用 JTAnalyzeHelper,受 autoAnalyze + analyzePerDay 约束)
    const unanalyzed = allJobs.filter(j => j && typeof j.aiFitScore !== 'number');
    let cap = 30;
    try {
      const cfg = await JTStorage.getAutoScan();
      if (cfg.autoAnalyze && cfg.analyzePerDay > 0) cap = Math.min(cap, cfg.analyzePerDay);
    } catch (e) { /* 用默认上限 */ }

    const queue = unanalyzed.slice(0, cap);
    let success = 0, skipped = 0;
    if (queue.length > 0) {
      if (title) title.textContent = `导入完成,自动分析 ${queue.length} 个岗位…`;
      for (let i = 0; i < queue.length; i++) {
        const job = queue[i];
        if (bar) bar.style.width = Math.round((i / queue.length) * 100) + '%';
        if (title) title.textContent = `自动分析 ${i + 1}/${queue.length}: ${job.title || ''}`;
        try {
          const r = await JTAnalyzeHelper.maybeAutoAnalyze(job);
          if (r.analyzed && r.analysis) {
            applyAiResultToJob(job.id, r.analysis);
            success++;
          } else {
            skipped++;
          }
        } catch (e) {
          skipped++;
        }
        if (detail) detail.textContent = `分析成功 ${success} · 跳过 ${skipped}`;
        await new Promise(r => setTimeout(r, 800)); // 节流
      }
      recomputeScores();
      renderStats();
      renderJobList();
      persistJobs();
    }

    if (bar) bar.style.width = '100%';
    if (title) title.textContent = '导入完成';
    setTimeout(() => { if (panel) panel.style.display = 'none'; }, 2000);
    alert(`导入完成!\n入库:新增 ${saved.added},更新 ${saved.updated}\n自动分析:成功 ${success},跳过 ${skipped}`);
  }

  // 解析导入 JSON(支持数组或单个对象)
  function parseImportJSON(text) {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : [data];
    return arr.map(normalizeImportedJob).filter(j => j && (j.title || j.url));
  }

  // 解析导入 CSV(反向 exportCSV 格式)
  // 表头:标题,公司,地点,薪资,最低月薪,最高月薪,来源,匹配分,匹配原因,状态,链接,记录时间,备注
  function parseImportCSV(text) {
    const lines = splitCSVLines(text);
    if (lines.length < 2) return [];
    const headers = lines[0];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].length === 1 && lines[i][0] === '') continue;
      const row = {};
      for (let j = 0; j < headers.length && j < lines[i].length; j++) {
        row[headers[j]] = lines[i][j];
      }
      rows.push(row);
    }
    return rows.map(r => {
      const job = {
        title: r['标题'] || r['title'] || '',
        company: r['公司'] || r['company'] || '',
        location: r['地点'] || r['location'] || '',
        salaryRaw: r['薪资'] || r['salaryRaw'] || '',
        salaryMin: parseInt(r['最低月薪'] || r['salaryMin']) || 0,
        salaryMax: parseInt(r['最高月薪'] || r['salaryMax']) || 0,
        site: r['来源'] || r['site'] || '',
        url: r['链接'] || r['url'] || '',
        notes: r['备注'] || r['notes'] || '',
        status: r['状态'] || r['status'] || 'unseen',
        capturedAt: r['记录时间'] ? parseDateStr(r['记录时间']) : Date.now()
      };
      return normalizeImportedJob(job);
    }).filter(j => j.title || j.url);
  }

  // 按行拆分 CSV(处理引号包裹的逗号和转义双引号)
  function splitCSVLines(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (ch === '\r') { /* skip */ }
        else { field += ch; }
      }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  // 解析中文日期字符串(如 2024/1/1 12:00:00)为时间戳
  function parseDateStr(s) {
    const t = Date.parse(s);
    return isNaN(t) ? Date.now() : t;
  }

  // 归一化导入的岗位对象(补齐必要字段)
  function normalizeImportedJob(j) {
    if (!j || typeof j !== 'object') return null;
    const job = Object.assign({}, j);
    if (!job.status) job.status = 'unseen';
    if (!job.capturedAt) job.capturedAt = Date.now();
    // 注意:不要删除 job.id。缺 id 的岗位由 storage.saveJobs 的 ensureJobId 统一兜底生成,
    // 此处删除会导致导入岗位无稳定 id,后续无法按 id 更新/删除(M9 修复)
    return job;
  }

  function renderModalAiResult(res, localScore) {
    const el = document.getElementById('aiModalResult');
    const a = res.analysis || {};
    let html = JTUi.renderAiAnalysisHtml(a, localScore);
    // 企业信息状态提示(三态,始终可见,让用户明确知道"查没查 / 查到什么")
    html += renderCompanyRiskBadge(res.companyRisk, res.companyRiskMeta);
    html += '<div class="ai-reanalyze">';
    if (res.cached) html += '<span class="ai-cache-hint">（缓存结果,24h 内复用）</span>';
    html += '<button id="btnModalReanalyze" class="btn btn-sm btn-outline">↻ 重新分析</button></div>';
    el.innerHTML = html;
    const rb = document.getElementById('btnModalReanalyze');
    if (rb) rb.addEventListener('click', () => runModalAnalyze(true));
  }

  // 企业信息状态徽标(三态可见):已结合 / 已查但无数据 / 未结合(含原因)
  function renderCompanyRiskBadge(companyRisk, meta) {
    if (companyRisk && companyRisk.legalName) {
      const r = companyRisk;
      const riskTxt = (r.riskLevel === 'low') ? '低风险' : (r.riskLevel === 'high') ? '高风险' : '未知';
      const jud = r.judicialRisk && r.judicialRisk.level ? ('司法风险:' + (r.judicialRisk.level === 'low' ? '低' : r.judicialRisk.level === 'mid' ? '中' : r.judicialRisk.level)) : '';
      return '<div class="cr-badge cr-ok" style="margin-top:10px">✅ 已结合企业信息分析：' +
        JTUi.escapeHtml(r.legalName) + ' · ' + JTUi.escapeHtml(r.legalStatus || '状态未知') +
        (r.insuredCount != null ? ' · 参保' + r.insuredCount + '人' : '') +
        ' · ' + riskTxt + (jud ? ' · ' + jud : '') + '</div>';
    }
    if (meta && meta.queried && !meta.found) {
      return '<div class="cr-badge cr-info" style="margin-top:10px">ℹ️ 已查询企业信息：' +
        JTUi.escapeHtml(meta.note || '天眼查未返回该企业工商数据') + '（本次分析未纳入企业维度）</div>';
    }
    const reason = (!meta) ? '天眼查桥接未连接或未配置 API Key' :
      (meta.note || '天眼查查询未执行');
    return '<div class="cr-badge cr-warn" style="margin-top:10px">⚠️ 本次未结合企业信息分析（' +
      JTUi.escapeHtml(reason) + '）。在设置页填写天眼查 Key 并保持 mcp-bridge 运行后重试，可纳入企业真实性、行业错配与司法风险。</div>';
  }

  // ----------------------------------------------------------
  // 简历档案标签页
  // ----------------------------------------------------------
  async function loadResumeTab() {
    const profile = await JTStorage.getProfile();
    renderResumeProfile(profile);
    renderRecommendations(profile);
  }

  function renderResumeProfile(profile) {
    const el = document.getElementById('resumeProfileDisplay');
    if (!profile || !profile.name) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📄</div>
          <p>尚未上传简历</p>
          <p class="empty-hint">请到 <a href="../settings/settings.html" class="link">AI 设置</a> 上传简历文件,AI 会自动提取结构化档案</p>
        </div>`;
      return;
    }

    const fields = [
      ['姓名', profile.name], ['性别', profile.gender], ['电话', profile.phone],
      ['邮箱', profile.email], ['年龄', profile.age], ['学历', profile.education],
      ['毕业院校', profile.school], ['专业', profile.major], ['毕业时间', profile.graduationDate],
      ['期望薪资', profile.expectedSalary], ['期望城市', profile.expectedCity],
      ['证书', (profile.certifications || []).join('、')],
      ['技能', (profile.skills || []).join('、')]
    ];
    const fieldsHtml = fields.filter(f => f[1]).map(f =>
      `<div class="profile-item"><span class="profile-item-label">${f[0]}</span><span class="profile-item-value">${JTUi.escapeHtml(f[1])}</span></div>`
    ).join('');
    const summaryHtml = profile.selfSummary ? `<div class="profile-summary">${JTUi.escapeHtml(profile.selfSummary)}</div>` : '';

    el.innerHTML = `
      <div class="profile-card">
        ${fieldsHtml}
        ${summaryHtml}
        <div class="profile-edit-link">
          <a href="../settings/settings.html" class="link">编辑档案 →</a>
        </div>
      </div>`;
  }

  function renderRecommendations(profile) {
    const el = document.getElementById('recommendList');
    if (!profile || !profile.name) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">🎯</div><p>上传简历后显示推荐</p></div>';
      return;
    }
    if (allJobs.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>还没有记录岗位</p></div>';
      return;
    }

    // 按匹配分排序,取前 10
    const sorted = [...allJobs].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
    el.innerHTML = sorted.map(job => {
      const level = JTFilters.getMatchLevel(job.score || 0);
      const aiMark = job.scoreSource === 'ai' ? '<span class="score-src" title="AI 综合评估分">AI</span>' : '';
      return `
        <div class="recommend-card" data-id="${job.id}">
          <div class="recommend-main">
            <div class="recommend-title">${JTUi.escapeHtml(job.title || '未知')}</div>
            <div class="recommend-meta">${JTUi.escapeHtml(job.company || '')} · ${JTUi.escapeHtml(job.location || '')} · ${JTUi.escapeHtml(job.salaryRaw || '面议')}</div>
          </div>
          <div class="recommend-right">
            <span class="score-tag score-tag-${level}">${aiMark}${job.score || 0} · ${JTUi.LEVEL_LABELS[level]}</span>
            <a href="${JTUi.escapeAttr(JTUi.safeUrl(job.url))}" target="_blank" class="btn btn-sm btn-outline">投递 ↗</a>
          </div>
        </div>`;
    }).join('');

    // 点击卡片打开详情
    el.querySelectorAll('.recommend-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'A') return;
        openJobModal(card.dataset.id);
      });
    });
  }

  // 应用筛选条件
  async function applyFilters() {
    filters = {
      includeKeywords: JTUi.parseList(document.getElementById('fInclude').value),
      excludeKeywords: JTUi.parseList(document.getElementById('fExclude').value),
      cities: JTUi.parseList(document.getElementById('fCities').value),
      minSalary: parseInt(document.getElementById('fMinSalary').value) || 0,
      maxSalary: parseInt(document.getElementById('fMaxSalary').value) || 0,
      excludeCertRequired: document.getElementById('fCert').checked,
      excludeExpRequired: document.getElementById('fExp').checked,
      certKeywords: JT_CONFIG.defaultFilters.certKeywords,
      expKeywords: JT_CONFIG.defaultFilters.expKeywords,
      minScore: parseInt(document.getElementById('fMinScore').value) || 0
    };
    await JTStorage.saveFilters(filters);
    recomputeScores();
    await persistJobs();
    renderStats();
    renderJobList();
  }

  // 把筛选后的分数写回存储
  async function persistJobs() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.jobs]: allJobs }, () => resolve());
    });
  }

  // 打开岗位详情弹窗
  function openJobModal(id) {
    const job = allJobs.find(j => j.id === id);
    if (!job) return;
    currentModalJob = job;

    // 锁定 body 滚动
    document.body.style.overflow = 'hidden';

    document.getElementById('modalTitle').textContent = job.title || '岗位详情';
    document.getElementById('modalStatus').value = job.status || 'unseen';
    document.getElementById('modalNotes').value = job.notes || '';
    document.getElementById('modalOpenLink').href = JTUi.safeUrl(job.url);

    // 清空之前的 AI 分析结果
    document.getElementById('aiModalResult').innerHTML = '';

    const level = JTFilters.getMatchLevel(job.score || 0);
    const reasonsHtml = (job.matchReasons || []).length
      ? `<div class="modal-reasons">${job.matchReasons.map(r => '• ' + JTUi.escapeHtml(r)).join('<br>')}</div>`
      : '';
    const scoreSourceLabel = job.scoreSource === 'ai'
      ? '<span class="score-src" title="AI 综合评估分">AI</span> 综合评估'
      : '规则引擎(实时)';

    document.getElementById('modalBody').innerHTML = `
      <div class="modal-field">
        <div class="modal-field-label">公司</div>
        <div class="modal-field-value">${JTUi.escapeHtml(job.company || '未知')}</div>
      </div>
      <div class="modal-field">
        <div class="modal-field-label">地点 / 薪资</div>
        <div class="modal-field-value">${JTUi.escapeHtml(job.location || '未知')} · <span style="color:#dc2626;font-weight:600">${JTUi.escapeHtml(job.salaryRaw || '面议')}</span></div>
      </div>
      <div class="modal-field">
        <div class="modal-field-label">来源 / 记录时间</div>
        <div class="modal-field-value">${JTUi.escapeHtml(job.site || '')} · ${JTUi.formatDate(job.capturedAt)}</div>
      </div>
      <div class="modal-field">
        <div class="modal-field-label">匹配分</div>
        <div class="modal-field-value"><span class="score-tag score-tag-${level}">${job.score || 0} · ${JTUi.LEVEL_LABELS[level]}</span> <span class="score-source-label">${scoreSourceLabel}</span></div>
      </div>
      ${reasonsHtml ? `<div class="modal-field">${reasonsHtml}</div>` : ''}
      ${job.description ? `
      <div class="modal-field">
        <div class="modal-field-label">岗位描述</div>
        <div class="modal-field-desc">${JTUi.escapeHtml(job.description)}</div>
      </div>` : ''}
      ${job.requirement ? `
      <div class="modal-field">
        <div class="modal-field-label">任职要求</div>
        <div class="modal-field-desc">${JTUi.escapeHtml(job.requirement)}</div>
      </div>` : ''}
    `;

    document.getElementById('jobModal').style.display = 'flex';
  }

  function closeModal() {
    document.getElementById('jobModal').style.display = 'none';
    document.getElementById('aiModalResult').innerHTML = '';
    document.body.style.overflow = '';  // 恢复页面滚动
    currentModalJob = null;
  }

  // 保存弹窗修改
  async function saveModalJob() {
    if (!currentModalJob) return;
    const status = document.getElementById('modalStatus').value;
    const notes = document.getElementById('modalNotes').value;
    try {
      await JTStorage.updateStatus(currentModalJob.id, status);
      await JTStorage.updateNotes(currentModalJob.id, notes);
      // 更新本地(仅在存储成功后,避免 UI 与存储状态不一致)
      const job = allJobs.find(j => j.id === currentModalJob.id);
      if (job) { job.status = status; job.notes = notes; }
      renderStats();
      renderJobList();
    } catch (e) {
      alert('保存失败,请重试: ' + String(e));
      return; // 不关闭弹窗,让用户可重试
    }
    closeModal();
  }

  // 删除当前弹窗岗位
  async function deleteModalJob() {
    if (!currentModalJob) return;
    if (!confirm('确定删除此岗位记录?')) return;
    try {
      await JTStorage.deleteJob(currentModalJob.id);
    } catch (e) {
      alert('删除失败,请重试: ' + String(e));
      return;
    }
    // 仅在存储成功后更新本地状态
    allJobs = allJobs.filter(j => j.id !== currentModalJob.id);
    selectedIds.delete(currentModalJob.id);
    renderStats();
    renderJobList();
    closeModal();
  }

  // 导出
  function exportData(format) {
    const jobs = getFilteredJobs();
    if (jobs.length === 0) { alert('没有可导出的岗位'); return; }
    const content = format === 'csv' ? JTStorage.exportCSV(jobs) : JTStorage.exportJSON(jobs);
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
    const ext = format === 'csv' ? 'csv' : 'json';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `岗位记录_${JTUi.formatDate(Date.now(), true)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 本地辅助函数(formatDate/escapeHtml/escapeAttr/parseList)已迁移到 lib/ui-utils.js(JTUi)

  // ----------------------------------------------------------
  // 自动扫描状态条
  // ----------------------------------------------------------
  async function initAutoScanBar() {
    const bar = document.getElementById('autoscanBar');
    const text = document.getElementById('asText');
    const dot = document.getElementById('asDot');
    if (!bar || !text) return;
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'JT_GET_AUTOSCAN_STATUS' }, resolve);
      });
      if (!res || !res.ok) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      const fmt = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
      const next = res.nextFireTime ? new Date(res.nextFireTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未启动';
      dot.className = 'as-dot ' + (res.enabled ? 'on' : 'off');
      text.innerHTML = res.enabled
        ? `自动扫描已开启 · 上次 <b>${fmt(res.lastScanAt)}</b> · 下次 <b>${next}</b> · 累计采集 ${res.totalCollected}`
        : `自动扫描未开启 · 累计自动采集 ${res.totalCollected} · <a href="../settings/autoscan.html" class="link">去设置 →</a>`;
    } catch (e) {
      bar.style.display = 'none';
    }
  }

  // ----------------------------------------------------------
  // 前端扫描控制器:启动扫描
  // ----------------------------------------------------------
  async function startScanFromDashboard() {
    if (JTScanController.isRunning()) {
      alert('扫描正在进行中,请等待完成或点击停止。');
      return;
    }

    const cfg = await JTStorage.getAutoScan();
    if (!JTAutoScan.shouldRun(cfg) && !cfg.keywords) {
      alert('请先到设置页配置关键词并启用自动扫描。');
      return;
    }

    // 即使未启用定时,也允许手动触发一轮
    // forceAnalyze:true → 手动扫描强制重新分析,不命中 AI 缓存(杜绝「引用旧缓存瞬间完成」)
    const runCfg = { ...cfg, enabled: true, forceAnalyze: true };

    const runNowBtn = document.getElementById('btnRunScanNow');
    const stopBtn = document.getElementById('btnStopScan');
    const progressPanel = document.getElementById('scanProgressPanel');
    const progressTitle = document.getElementById('scanProgressTitle');
    const progressBar = document.getElementById('scanProgressBar');
    const progressDetail = document.getElementById('scanProgressDetail');

    if (runNowBtn) runNowBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    if (progressPanel) progressPanel.style.display = '';

    // 注册进度回调
    JTScanController.onProgress((p) => {
      if (progressTitle) {
        const phaseMap = {
          loading: '正在加载搜索页…',
          collecting: `正在采集第 ${p.page} 页…`,
          page_done: `第 ${p.page} 页完成`,
          analyzing: `正在分析: ${p.job || ''}`,
          done: `扫描完成`,
          error: `扫描出错: ${p.error || ''}`,
        };
        progressTitle.textContent = phaseMap[p.phase] || p.phase;
      }
      if (progressBar && p.total !== undefined) {
        // 进度条按新增数粗略估算
        const pct = Math.min(95, (p.total || 0) * 2);
        progressBar.style.width = pct + '%';
      }
      if (progressDetail) {
        if (p.phase === 'done') {
          progressDetail.textContent = `本轮新增 ${p.added || 0} 个岗位(累计 ${p.total || 0})`;
          if (progressBar) progressBar.style.width = '100%';
        } else if (p.phase === 'page_done') {
          progressDetail.textContent = `第${p.page}页: 采集${p.pageCollected}个,新增${p.pageAdded}个 | 累计新增${p.total}个`;
        } else if (p.phase === 'error') {
          progressDetail.textContent = p.error || '未知错误';
        } else {
          progressDetail.textContent = `已新增 ${p.total || 0} 个`;
        }
      }

      // 扫描完成后刷新列表
      if (p.phase === 'done' || p.phase === 'error') {
        if (runNowBtn) { runNowBtn.style.display = ''; runNowBtn.disabled = false; }
        if (stopBtn) stopBtn.style.display = 'none';
        setTimeout(() => {
          if (progressPanel) progressPanel.style.display = 'none';
        }, 5000);
        // 刷新岗位列表 + 状态条
        refreshAfterScan();
      }
    });

    // 启动扫描(异步,不阻塞)
    JTScanController.start(runCfg).then((result) => {
      if (!result.ok) {
        if (progressTitle) progressTitle.textContent = '扫描失败';
        if (progressDetail) progressDetail.textContent = result.error || '未知错误';
      }
    });
  }

  // 扫描后刷新列表和状态
  async function refreshAfterScan() {
    allJobs = await JTStorage.getJobs();
    recomputeScores();
    renderStats();
    renderJobList();
    initAutoScanBar();
  }
})();
