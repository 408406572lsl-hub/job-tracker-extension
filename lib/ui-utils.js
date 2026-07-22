// ============================================================
// ui-utils.js — UI 共享工具函数
// popup.js 和 dashboard.js 共用,消除重复代码
// ============================================================

const JTUi = (() => {

  // HTML 转义(防 XSS)
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // 属性值转义(防属性注入 / XSS)
  // 必须转义 & " ' < > 五个字符,否则攻击者可在属性值里注入新属性或提前闭合标签
  function escapeAttr(str) {
    return (str == null ? '' : String(str))
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 安全 URL:仅放行 http/https,其余(尤其 javascript:/data:/vbscript:)一律返回 '#'
  // 用于把(可能来自远端页面的) job.url 放进 href 属性前,阻断伪协议 XSS
  function safeUrl(url) {
    const u = (url == null ? '' : String(url)).trim();
    if (/^https?:\/\//i.test(u)) return u;
    return '#';
  }

  // 匹配等级标签
  const LEVEL_LABELS = { high: '推荐', medium: '可看', low: '不太匹配' };

  // 风险等级映射 → CSS class
  const RISK_CLASS_MAP = { '高': 'high', '中': 'medium', '低': 'low', '信息不足': 'info' };

  // 风险等级 → 中文标签
  const RISK_LABEL_MAP = { '高': '风险高', '中': '风险中', '低': '风险低', '信息不足': '信息不足' };

  const RELATION_LABEL_MAP = {
    '直接匹配': '直接匹配',
    '相邻转岗': '相邻转岗',
    '跨行可迁移': '跨行可迁移',
    '关系较弱': '关系较弱',
    '基本不匹配': '基本不匹配',
    '信息不足': '信息不足'
  };

  // 渲染通用岗位 AI 分析结果(返回 HTML 字符串)
  // 被 popup.js renderAiResult 和 dashboard.js renderModalAiResult 共用
  // localScore: 本地规则匹配分(可选),用于与 AI 分并列展示、差异提示
  function renderAiAnalysisHtml(a, localScore) {
    // fitScore 必须是有穷数字;LLM/被篡改响应若返回字符串(含 HTML)则降级为 '?',避免注入
    const score = (a != null && typeof a.fitScore === 'number' && Number.isFinite(a.fitScore)
      && a.fitScore >= 0 && a.fitScore <= 100)
      ? a.fitScore
      : '?';
    a = a || {};
    const asArray = (value) => Array.isArray(value) ? value : [];
    const riskLevel = RISK_LABEL_MAP[a.overallRisk] ? a.overallRisk : '信息不足';
    const riskClass = RISK_CLASS_MAP[riskLevel];
    const riskLabel = RISK_LABEL_MAP[riskLevel];
    const relationLabel = RELATION_LABEL_MAP[a.relationType] || '';
    const recommendation = typeof a.recommendation === 'string' ? a.recommendation : '';
    const careerValue = typeof a.careerValue === 'string' ? a.careerValue : '';

    // 本地规则分维度(硬性匹配度)
    const hasLocalScore = typeof localScore === 'number' && Number.isFinite(localScore);
    const lv = hasLocalScore ? JTFilters.getMatchLevel(localScore) : null;
    const lvLabel = lv ? LEVEL_LABELS[lv] : '';
    const localScoreHtml = hasLocalScore
      ? `<div class="ai-score-block hard">
           <div class="ai-score-cap">硬性匹配度</div>
           <div class="ai-score-val">${localScore}<span class="ai-score-unit">分</span></div>
           <div class="ai-score-desc">${lvLabel ? lvLabel + ' · ' : ''}规则引擎(实时)</div>
         </div>`
      : '';

    // 头部:规则分、AI 关系分和岗位风险分别表达,避免把跨专业差距与岗位风险混在一起
    const scoreHead = `
      <div class="ai-dual-score">
        ${localScoreHtml}
        <div class="ai-score-block ai">
          <div class="ai-score-cap">AI 关系程度</div>
          <div class="ai-score-val">${score}<span class="ai-score-unit">分</span></div>
          <div class="ai-score-desc">能力匹配+转岗可行性</div>
        </div>
      </div>
      <div class="ai-result-tags">
        ${relationLabel ? `<span class="ai-relation-tag">与我关系：${escapeHtml(relationLabel)}</span>` : ''}
        ${recommendation ? `<span class="ai-recommend-tag">投递建议：${escapeHtml(recommendation)}</span>` : ''}
        ${careerValue ? `<span class="ai-career-tag">职业价值：${escapeHtml(careerValue)}</span>` : ''}
        <span class="ai-risk-tag ai-risk-tag-${riskClass}">岗位风险：${escapeHtml(riskLabel)}</span>
      </div>
    `;

    // 两维度差距 > 20 时,给出互补洞察而非矛盾困惑
    let gapHtml = '';
    if (hasLocalScore && typeof a.fitScore === 'number' && Number.isFinite(a.fitScore)) {
      const gap = Math.abs(a.fitScore - localScore);
      if (gap > 20) {
        gapHtml = a.fitScore > localScore
          ? '<div class="ai-gap-hint">两维度差异较大：规则硬条件得分一般，但 AI 认为能力可迁移或转岗可行，建议结合门槛详情判断。</div>'
          : '<div class="ai-gap-hint">两维度差异较大：规则硬条件得分较高，但 AI 认为实际胜任关系较弱，建议重点核实职责和能力差距。</div>';
      }
    }

    const relationHtml = typeof a.relationSummary === 'string' && a.relationSummary
      ? `<div class="ai-relation-summary"><strong>关系判断：</strong>${escapeHtml(a.relationSummary)}</div>` : '';
    const reasons = asArray(a.fitReasons);
    const transferable = asArray(a.transferableStrengths);
    const barriers = asArray(a.entryBarriers);
    const gaps = asArray(a.gaps);
    const suggestions = asArray(a.suggestions);
    const risks = asArray(a.risks);
    const reasonsHtml = reasons.length
      ? `<div class="ai-sub-title">匹配优势</div><ul class="ai-list">${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
    const transferableHtml = transferable.length
      ? `<div class="ai-sub-title">可迁移能力</div><ul class="ai-list">${transferable.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
    const barriersHtml = barriers.length
      ? `<div class="ai-sub-title">入门门槛</div><ul class="ai-list">${barriers.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
    const gapsHtml = gaps.length
      ? `<div class="ai-sub-title">差距短板</div><ul class="ai-list">${gaps.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
    const suggHtml = suggestions.length
      ? `<div class="ai-sub-title">行动建议</div><ul class="ai-list">${suggestions.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
    const risksHtml = risks.length
      ? `<div class="ai-sub-title">岗位避坑</div>${risks.map((risk) => {
          const r = risk && typeof risk === 'object' ? risk : { detail: risk };
          const severity = RISK_CLASS_MAP[r.severity] ? r.severity : '信息不足';
          const sev = RISK_CLASS_MAP[severity];
          return `<div class="ai-risk-item ${sev}">
            <div class="ai-risk-type">${escapeHtml(r.type || '其他')} · ${escapeHtml(severity)}</div>
            <div class="ai-risk-detail">${escapeHtml(r.detail || '')}</div>
            ${r.advice ? `<div class="ai-risk-advice">建议：${escapeHtml(r.advice)}</div>` : ''}
          </div>`;
        }).join('')}` : '';
    const noRiskHtml = (!risks.length && a.analysisVersion >= 2)
      ? '<div class="ai-no-risk">当前岗位文本中未发现明确风险证据；这不等于岗位绝对安全，仍需核实薪资结构、合同、社保和实际职责。</div>' : '';
    const summaryHtml = a.summary ? `<div class="ai-summary">${escapeHtml(a.summary)}</div>` : '';

    // 公司风险卡(天眼AI enrichment,analysisVersion:2 扩展)
    const companyRiskHtml = renderCompanyRiskHtml(a.companyRisk);

    return scoreHead + gapHtml + relationHtml + reasonsHtml + transferableHtml + barriersHtml + gapsHtml + suggHtml + risksHtml + noRiskHtml + summaryHtml + companyRiskHtml;
  }

  // 渲染公司风险卡(天眼AI 工商/风险 enrichment 结果)
  // cr: analysis.companyRisk 或 null/undefined
  function renderCompanyRiskHtml(cr) {
    if (!cr || !cr.unifiedCode) return '';
    const esc = (v) => escapeHtml(v == null ? '' : String(v));
    const statusClass = /注销|吊销|清算/.test(cr.legalStatus || '') ? 'cr-bad'
      : (/存续|在业|正常/.test(cr.legalStatus || '') ? 'cr-ok' : 'cr-unknown');
    const riskClassMap = { low: 'cr-ok', mid: 'cr-warn', high: 'cr-bad', unknown: 'cr-unknown' };
    const matchLabel = { high: '高度匹配', mid: '部分相关', low: '行业错配', unknown: '暂不评估' };
    const medLabel = { true: '具备医疗资质', false: '非医疗(养生/咨询类)', unknown: '资质未知' };
    const jr = cr.judicialRisk || {};
    const jrClass = riskClassMap[jr.level] || 'cr-unknown';
    const jrLabel = { low: '无风险记录', mid: '存在风险记录', high: '高风险' }[jr.level] || '未知';

    let html = '<div class="cr-card">';
    html += `<div class="cr-title">🏢 公司风险 · 天眼AI<span class="cr-src">${esc(cr.source)}</span></div>`;
    html += '<div class="cr-grid">';
    html += `<div class="cr-item"><span class="cr-k">企业</span><span class="cr-v">${esc(cr.legalName)}</span></div>`;
    html += `<div class="cr-item"><span class="cr-k">登记状态</span><span class="cr-v ${statusClass}">${esc(cr.legalStatus) || '未知'}</span></div>`;
    html += `<div class="cr-item"><span class="cr-k">注册资本</span><span class="cr-v">${esc(cr.registeredCapital) || '未知'}</span></div>`;
    html += `<div class="cr-item"><span class="cr-k">成立日期</span><span class="cr-v">${esc(cr.establishedAt) || '未知'}</span></div>`;
    html += `<div class="cr-item"><span class="cr-k">参保人数</span><span class="cr-v">${cr.insuredCount != null ? esc(cr.insuredCount) + ' 人' : '未知'}</span></div>`;
    html += `<div class="cr-item"><span class="cr-k">所属行业</span><span class="cr-v">${esc(cr.industry) || '未知'}</span></div>`;
    html += `<div class="cr-item"><span class="cr-k">行业匹配</span><span class="cr-v ${riskClassMap[cr.industryMatch] || 'cr-unknown'}">${matchLabel[cr.industryMatch] || esc(cr.industryMatch)}</span></div>`;
    html += `<div class="cr-item"><span class="cr-k">医疗资质</span><span class="cr-v ${cr.medicalQualified === false ? 'cr-bad' : (cr.medicalQualified === true ? 'cr-ok' : 'cr-unknown')}">${medLabel[cr.medicalQualified] || esc(cr.medicalQualified)}</span></div>`;
    html += `<div class="cr-item"><span class="cr-k">司法风险</span><span class="cr-v ${jrClass}">${jrLabel}${jr.caseCount ? '(' + esc(jr.caseCount) + ')' : ''}</span></div>`;
    html += '</div>';
    // 行业错配 / 非医疗 醒目提示(对康复岗求职最关键)
    if (cr.industryMatch === 'low' || cr.medicalQualified === false) {
      html += `<div class="cr-alert">⚠️ 该公司经营范围为非医疗/养生保健类，不能聘用需医疗执业资质的治疗岗，请核实岗位实际工作内容是否匹配你的康复治疗专业。</div>`;
    }
    if (cr.note) html += `<div class="cr-note">${esc(cr.note)}</div>`;
    html += '</div>';
    return html;
  }

  // 日期格式化
  function formatDate(ts, forFile) {
    if (!ts) return '';
    const d = new Date(ts);
    if (forFile) return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // 解析逗号分隔列表
  function parseList(str) {
    return str.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  }

  return {
    escapeHtml,
    escapeAttr,
    safeUrl,
    LEVEL_LABELS,
    renderAiAnalysisHtml,
    formatDate,
    parseList
  };
})();
