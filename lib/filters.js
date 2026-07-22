// ============================================================
// filters.js — 筛选匹配引擎(v2 智能版)
// 根据用户设置的筛选条件,给岗位打匹配分和原因
//
// v2 改进:
//   1. 否定上下文检测 — "非康复岗位"里的"康复"不命中
//   2. 短关键词词边界 — "PT" 不匹配 "input" 里的 "pt"
//   3. 任职要求与描述分离 — 要求区命中给更高分(雇主明确要求的条件)
//   4. 硬性要求 vs 加分项 — "必须持证"给0分,"持证优先"给半分
//   5. 关键词去重 — "康复治疗"命中时不重复计"康复"
//   6. 置信度指示 — 基于已启用维度数量评估本地分可靠性
//
// 评分模型(加权归一):
//   每个已启用的维度给出一个子分(0~1),按权重加权求和后归一化到 0~100。
//   - 关键词:标题命中权重最高(强信号),要求区次之,描述命中最弱
//   - 城市 / 薪资 / 证书 / 经验:仅在用户实际配置时才参与
//   - 排除词:标题命中重扣、描述命中轻扣,设上限
// ============================================================

const JTFilters = (() => {
  const W = JT_CONFIG.scoreWeights;

  // ---- 否定上下文检测 ----
  // 如果关键词前面紧挨这些词,说明是"不/非/无需"等否定语境,不应命中
  const NEGATION_PREFIXES = ['不', '非', '无需', '不需要', '不含', '没有', '无', '免'];

  // ---- 要求强度标记 ----
  // 硬性要求:必须/需要/要求/须/应/持有/具备/限定/X年以上
  const HARD_REQ_MARKERS = ['必须', '需要', '要求', '须', '应', '持有', '具备', '限定', '应有', '必备', '须持', '需持', '年以上', '持证'];
  // 软性加分:优先/加分/prefer
  const SOFT_REQ_MARKERS = ['优先', '加分', 'prefer', 'preferred', 'nice', '者优先', '即可', '不限'];

  // ============================================================
  // 智能关键词匹配(核心改进)
  // ============================================================

  // 检查关键词是否处于否定上下文中(前面紧挨"不/非/无需"等)
  function isNegated(text, matchIndex) {
    const windowBefore = text.substring(Math.max(0, matchIndex - 4), matchIndex);
    return NEGATION_PREFIXES.some(neg => windowBefore.endsWith(neg));
  }

  // 检查短关键词(≤2字符)的词边界
  // 避免英文字母关键词(如 PT/OT)匹配到其他英文单词内部
  function passesBoundary(text, keyword, idx) {
    if (keyword.length <= 2) {
      const before = idx > 0 ? text[idx - 1] : ' ';
      const after = idx + keyword.length < text.length ? text[idx + keyword.length] : ' ';
      // 相邻字符如果是英文字母,说明是单词内部匹配,不算命中
      if (/[a-z]/.test(before) || /[a-z]/.test(after)) return false;
    }
    return true;
  }

  // 智能匹配单个关键词(返回匹配位置,未命中返回 -1)
  function matchKeywordSmart(text, keyword) {
    if (!text || !keyword) return -1;
    const t = String(text).normalize('NFKC').toLowerCase();
    const k = String(keyword).normalize('NFKC').toLowerCase();
    const idx = t.indexOf(k);
    if (idx < 0) return -1;
    if (!passesBoundary(t, k, idx)) return -1;
    if (isNegated(t, idx)) return -1;
    return idx;
  }

  // 批量智能匹配(返回命中的关键词列表)
  function matchKeywordsSmart(text, keywords) {
    if (!text || !keywords || !keywords.length) return [];
    return keywords.filter(k => k && matchKeywordSmart(text, k) >= 0);
  }

  // 关键词去重:如果较长关键词包含较短关键词,只保留较长的
  // 避免同义词/子串重复计分(如"康复治疗"和"康复"同时命中只计一次)
  function deduplicateHits(hits) {
    if (!hits || hits.length <= 1) return hits;
    return hits.filter(k => !hits.some(other => other !== k && other.length > k.length && other.toLowerCase().includes(k.toLowerCase())));
  }

  // 检测要求强度:关键词本身及附近是否有"必须/需要/X年以上"或"优先/加分"
  function detectRequirementStrength(text, keyword) {
    const idx = matchKeywordSmart(text, keyword);
    if (idx < 0) return 'none';
    // 上下文包含关键词本身及其前后各15字符(确保关键词内的标记也能被检测到)
    const context = text.substring(Math.max(0, idx - 15), Math.min(text.length, idx + keyword.length + 15)).toLowerCase();
    if (HARD_REQ_MARKERS.some(m => context.includes(m))) return 'hard';
    if (SOFT_REQ_MARKERS.some(m => context.includes(m))) return 'soft';
    return 'neutral';
  }

  // ============================================================
  // 各维度子分计算(均返回 0~1 的 sub 与说明)
  // ============================================================

  // 关键词相关度:标题命中 > 任职要求命中 > 描述命中
  function scoreKeyword(job, includeKeywords, reasons) {
    const title = (job.title || '');
    const req = (job.requirement || '');
    const desc = (job.description || '');

    let titleHits = matchKeywordsSmart(title, includeKeywords);
    let reqHits = matchKeywordsSmart(req, includeKeywords).filter(k => !titleHits.includes(k));
    let descHits = matchKeywordsSmart(desc, includeKeywords).filter(k => !titleHits.includes(k) && !reqHits.includes(k));

    // 去重:同义词/子串只保留最长的一个
    titleHits = deduplicateHits(titleHits);
    reqHits = deduplicateHits(reqHits);
    descHits = deduplicateHits(descHits);

    let sub;
    if (titleHits.length > 0) {
      const step = Math.min(1, titleHits.length / 3) * W.keywordTitleStep;
      sub = Math.min(1, W.keywordTitleBase + step);
      reasons.push(`标题命中关键词: ${titleHits.join('、')}`);
    } else if (reqHits.length > 0) {
      // 任职要求中命中:较强信号(雇主明确列出的条件与求职者匹配)
      const step = Math.min(1, reqHits.length / 3) * W.keywordReqStep;
      sub = Math.min(W.keywordReqMax, W.keywordReqBase + step);
      reasons.push(`任职要求命中关键词: ${reqHits.join('、')}`);
    } else if (descHits.length > 0) {
      const step = Math.min(1, descHits.length / 3) * W.keywordBodyStep;
      sub = Math.min(W.keywordBodyMax, W.keywordBodyBase + step);
      reasons.push(`描述命中关键词: ${descHits.join('、')}`);
    } else {
      sub = 0;
      reasons.push('未命中任何关键词');
    }
    return sub;
  }

  // 城市匹配:优先看岗位地点字段,描述中提到只算弱匹配
  function scoreLocation(job, cities, reasons) {
    const loc = String(job.location || '').normalize('NFKC').toLowerCase();
    const desc = String(job.description || '').normalize('NFKC').toLowerCase();
    const inLoc = cities.filter(c => loc.includes(String(c).normalize('NFKC').toLowerCase()));
    const inDesc = cities.filter(c => !inLoc.includes(c) && desc.includes(String(c).normalize('NFKC').toLowerCase()));
    if (inLoc.length > 0) {
      reasons.push(`城市匹配: ${job.location || inLoc.join('/')}`);
      return 1;
    }
    if (inDesc.length > 0) {
      reasons.push(`城市仅描述提及: ${inDesc.join('/')}`);
      return 0.5;
    }
    reasons.push(`城市不符: ${job.location || '未知'}`);
    return 0;
  }

  // 薪资匹配:区间内给满分,略超区间(缓冲 20%)给半分,未知(面议)给中性半分
  function scoreSalary(job, minSalary, maxSalary, reasons) {
    const avg = (job.salaryMin && job.salaryMax)
      ? (Number(job.salaryMin) + Number(job.salaryMax)) / 2
      : 0;
    if (avg <= 0) {
      reasons.push(`薪资未知(面议),无法判断: ${job.salaryRaw || ''}`);
      return W.salaryUnknownSub;
    }
    const okMin = (minSalary <= 0) || (avg >= minSalary);
    const okMax = (maxSalary <= 0) || (avg <= maxSalary);
    if (okMin && okMax) {
      reasons.push(`薪资合适: ${job.salaryRaw || ''}`);
      return 1;
    }
    if ((minSalary > 0 && avg < minSalary && avg >= minSalary * (1 - W.salaryBufferRatio)) ||
        (maxSalary > 0 && avg > maxSalary && avg <= maxSalary * (1 + W.salaryBufferRatio))) {
      reasons.push(`薪资略超区间: ${job.salaryRaw || ''}`);
      return 0.5;
    }
    reasons.push(`薪资不匹配: ${job.salaryRaw || ''}`);
    return 0.1;
  }

  // 证书匹配(v2 改进):区分硬性要求 / 加分项 / 仅提及 / 未要求
  function scoreCert(job, certKeywords, reasons) {
    const reqText = (job.requirement || '');
    const descText = (job.description || '');

    // 先检查任职要求区(更强信号)
    for (const k of certKeywords) {
      if (matchKeywordSmart(reqText, k) >= 0) {
        const strength = detectRequirementStrength(reqText, k);
        if (strength === 'hard') {
          reasons.push(`要求证书(硬性要求): ${k}`);
          return 0;
        }
        if (strength === 'soft') {
          reasons.push(`证书为加分项(非硬性): ${k}`);
          return W.certSoftSub;
        }
        // neutral:在任职要求中提到但无明确强度标记,视为中等要求
        reasons.push(`任职要求提及证书: ${k}`);
        return W.certMentionedSub;
      }
    }

    // 再检查描述区(弱信号)
    for (const k of certKeywords) {
      if (matchKeywordSmart(descText, k) >= 0) {
        const strength = detectRequirementStrength(descText, k);
        if (strength === 'soft') {
          reasons.push(`证书为加分项(非硬性): ${k}`);
          return W.certSoftSub;
        }
        reasons.push(`描述提及证书: ${k}`);
        return W.certMentionedSub;
      }
    }

    reasons.push('未要求证书');
    return 1;
  }

  // 经验匹配(v2 改进):区分硬性要求 / 加分项 / 仅提及 / 未要求
  function scoreExp(job, expKeywords, reasons) {
    const reqText = (job.requirement || '');
    const descText = (job.description || '');

    // 先检查任职要求区
    for (const k of expKeywords) {
      if (matchKeywordSmart(reqText, k) >= 0) {
        const strength = detectRequirementStrength(reqText, k);
        if (strength === 'hard') {
          reasons.push(`要求工作经验(硬性要求): ${k}`);
          return 0;
        }
        if (strength === 'soft') {
          reasons.push(`经验为加分项(非硬性): ${k}`);
          return W.expSoftSub;
        }
        reasons.push(`任职要求提及经验: ${k}`);
        return W.expMentionedSub;
      }
    }

    // 再检查描述区
    for (const k of expKeywords) {
      if (matchKeywordSmart(descText, k) >= 0) {
        const strength = detectRequirementStrength(descText, k);
        if (strength === 'soft') {
          reasons.push(`经验为加分项(非硬性): ${k}`);
          return W.expSoftSub;
        }
        reasons.push(`描述提及经验: ${k}`);
        return W.expMentionedSub;
      }
    }

    reasons.push('未要求经验');
    return 1;
  }

  // 排除词扣分(v2 改进:否定上下文不扣分)
  function excludePenalty(job, excludeKeywords, reasons) {
    const titleHits = matchKeywordsSmart(job.title, excludeKeywords);
    const reqText = (job.requirement || '');
    const descText = (job.description || '');
    const bodyHits = matchKeywordsSmart(reqText + ' ' + descText, excludeKeywords).filter(k => !titleHits.includes(k));
    if (titleHits.length === 0 && bodyHits.length === 0) return 0;
    let penalty = titleHits.length * W.excludePenaltyTitle + bodyHits.length * W.excludePenaltyBody;
    penalty = Math.min(W.excludePenaltyCap, penalty);
    const parts = [];
    if (titleHits.length) parts.push(`标题:${titleHits.join('、')}`);
    if (bodyHits.length) parts.push(`描述:${bodyHits.join('、')}`);
    reasons.push(`命中排除词(${penalty}分): ${parts.join(' / ')}`);
    return penalty;
  }

  // ============================================================
  // 主评分函数
  // ============================================================

  function evaluate(job, filters) {
    filters = filters || JT_CONFIG.defaultFilters;
    const reasons = [];

    let raw = 0;          // 加权子分总和
    let weightSum = 0;    // 已启用维度权重和
    let dimCount = 0;     // 已启用维度数量(用于置信度)

    // 1. 关键词(配置了才计入)
    if (filters.includeKeywords && filters.includeKeywords.length) {
      raw += W.keyword * scoreKeyword(job, filters.includeKeywords, reasons);
      weightSum += W.keyword;
      dimCount++;
    }

    // 2. 城市(配置了才计入)
    if (filters.cities && filters.cities.length) {
      raw += W.location * scoreLocation(job, filters.cities, reasons);
      weightSum += W.location;
      dimCount++;
    }

    // 3. 薪资(配置了上下限才计入)
    const minSalary = Number(filters.minSalary) || 0;
    const maxSalary = Number(filters.maxSalary) || 0;
    if (minSalary > 0 || maxSalary > 0) {
      raw += W.salary * scoreSalary(job, minSalary, maxSalary, reasons);
      weightSum += W.salary;
      dimCount++;
    }

    // 4. 证书偏好(仅开启时计入)
    if (filters.excludeCertRequired) {
      const certKw = filters.certKeywords || JT_CONFIG.defaultFilters.certKeywords;
      raw += W.cert * scoreCert(job, certKw, reasons);
      weightSum += W.cert;
      dimCount++;
    }

    // 5. 经验偏好(仅开启时计入)
    if (filters.excludeExpRequired) {
      const expKw = filters.expKeywords || JT_CONFIG.defaultFilters.expKeywords;
      raw += W.exp * scoreExp(job, expKw, reasons);
      weightSum += W.exp;
      dimCount++;
    }

    // 归一化到 0~100;无任何有效维度则给中性基线
    let score;
    if (weightSum === 0) {
      score = W.neutralBaseline;
      reasons.push('未设置有效筛选条件,评分仅供参考');
    } else {
      score = Math.round((raw / weightSum) * 100);
    }

    // 排除词扣分(标题/描述分级,与维度无关,始终生效)
    if (filters.excludeKeywords && filters.excludeKeywords.length) {
      score -= excludePenalty(job, filters.excludeKeywords, reasons);
    }

    // 硬性要求未满足时封顶(与 AI prompt 规则对齐)
    // - 证书或经验有1项硬性要求未满足 → score ≤ 59
    // - 证书和经验同时硬性要求未满足 → score ≤ 39
    const hardMissCount = reasons.filter(r => r.includes('硬性要求')).length;
    if (hardMissCount >= 2) {
      score = Math.min(score, 39);
    } else if (hardMissCount >= 1) {
      score = Math.min(score, 59);
    }

    score = Math.max(0, Math.min(100, score));
    const matched = score >= (Number(filters.minScore) || 0);

    // 置信度:基于已启用维度数量
    // 1维=0.30, 2维=0.55, 3维=0.75, 4+维=0.90
    const confidence = weightSum === 0 ? 0.10 : Math.min(0.90, 0.30 + (dimCount - 1) * 0.20);

    return { score, reasons, matched, confidence };
  }

  // 批量筛选,给每个 job 填充 score 和 matchReasons
  function evaluateAll(jobs, filters) {
    return jobs.map(job => {
      const result = evaluate(job, filters);
      return { ...job, score: result.score, matchReasons: result.reasons, matched: result.matched, confidence: result.confidence };
    });
  }

  // 获取匹配等级(用于颜色标记)
  function getMatchLevel(score) {
    if (score >= 70) return 'high';    // 绿色
    if (score >= 40) return 'medium';  // 黄色
    return 'low';                       // 红色
  }

  // 等级对应的中文
  const LEVEL_LABELS = { high: '推荐', medium: '可看', low: '不太匹配' };

  return { evaluate, evaluateAll, getMatchLevel, LEVEL_LABELS };
})();
