// ============================================================
// simulate.js — 匹配分机制 v2 全面模拟测试
// 构造 15 个典型岗位场景,覆盖所有改进点,输出评分对比报告
// ============================================================

// 加载源码:用间接 eval (0, eval) 在全局作用域执行,并在末尾显式把 const 声明挂到 globalThis。
// 说明:源码用 `const X = ...` 声明顶层变量,这些声明不会自动成为 globalObject 的属性,
//       必须在同一段执行代码末尾显式赋值 `globalThis.X = X`。
//       vm.runInThisContext 的 const 声明留在词法环境,不挂到 globalThis,所以不能用。
const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, '..', 'lib');
const readSrc = rel => fs.readFileSync(path.join(baseDir, rel), 'utf8');

function loadSrc(rel, exportNames = []) {
  const code = readSrc(rel);
  const expose = exportNames
    .map(n => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
    .join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}

loadSrc('config.js', ['JT_CONFIG']);
loadSrc('filters.js', ['JTFilters']);

const { evaluate, getMatchLevel } = globalThis.JTFilters;

// ============================================================
// 模拟用户筛选条件(康复治疗求职场景)
// ============================================================
const userFilters = {
  includeKeywords: ['康复', '康复治疗', 'PT', 'OT', 'ST', '物理治疗', '作业治疗', '言语治疗', '理疗'],
  excludeKeywords: ['销售', '保险', '中介'],
  cities: ['北京', '上海', '广州'],
  minSalary: 0,
  maxSalary: 0,
  excludeCertRequired: true,
  certKeywords: ['执业证', '资格证', '持证', '须有证', '需要证书', '康复师证', '技师证'],
  excludeExpRequired: false,
  minScore: 40
};

// ============================================================
// 15 个模拟岗位场景
// ============================================================
const scenarios = [
  {
    name: '① 理想岗位(标题+城市命中,无硬性障碍)',
    job: {
      title: '康复治疗师',
      company: '南宁某康复医院',
      location: '南宁',
      salaryRaw: '6K-9K',
      salaryMin: 6000, salaryMax: 9000,
      description: '负责康复治疗工作,包括物理治疗和作业治疗',
      requirement: '康复治疗专业毕业,有责任心'
    },
    expected: '高分(85+)'
  },
  {
    name: '② 标题命中但要求证书(硬性障碍)',
    job: {
      title: '康复治疗师',
      company: '某医疗机构',
      location: '南宁',
      salaryRaw: '8K-12K',
      salaryMin: 8000, salaryMax: 12000,
      description: '负责康复治疗工作',
      requirement: '必须持有康复师执业证,3年以上经验'
    },
    expected: '低分(≤59,硬性要求)'
  },
  {
    name: '③ "持证优先"非硬性要求(加分项,不封顶)',
    job: {
      title: '康复治疗师',
      company: '某诊所',
      location: '南宁',
      salaryRaw: '5K-8K',
      salaryMin: 5000, salaryMax: 8000,
      description: '负责康复治疗',
      requirement: '康复治疗专业,有执业证优先'
    },
    expected: '高分(证书为加分项,不触发封顶)'
  },
  {
    name: '④ 否定上下文:"非康复岗位"',
    job: {
      title: '非康复岗位-行政前台',
      company: '某公司',
      location: '南宁',
      salaryRaw: '4K-6K',
      salaryMin: 4000, salaryMax: 6000,
      description: '负责前台接待和行政工作,不需要康复相关经验',
      requirement: '大专以上学历'
    },
    expected: '低分(关键词不命中)'
  },
  {
    name: '⑤ 短关键词误匹配:"PT" in "Input"',
    job: {
      title: 'Input Operator',
      company: '某外企',
      location: '上海',
      salaryRaw: '10K-15K',
      salaryMin: 10000, salaryMax: 15000,
      description: 'responsible for output and input processing',
      requirement: 'Bachelor degree, English fluency'
    },
    expected: '低分(PT不命中)'
  },
  {
    name: '⑥ 任职要求命中 vs 描述命中(同关键词不同区域)',
    job: {
      title: '医疗岗位',
      company: '某医院',
      location: '南宁',
      salaryRaw: '面议',
      salaryMin: 0, salaryMax: 0,
      description: '日常工作涉及康复治疗相关内容',
      requirement: '康复治疗专业毕业'
    },
    expected: '中高分(要求区命中>描述命中)'
  },
  {
    name: '⑦ 关键词去重:"康复治疗"+"康复"同时命中',
    job: {
      title: '康复治疗师',
      company: '某中心',
      location: '南宁',
      salaryRaw: '6K-8K',
      salaryMin: 6000, salaryMax: 8000,
      description: '负责康复治疗工作',
      requirement: '康复治疗相关背景'
    },
    expected: '高分(去重后不重复计分)'
  },
  {
    name: '⑧ 排除词命中(标题含"销售")',
    job: {
      title: '康复器材销售代表',
      company: '某器械公司',
      location: '南宁',
      salaryRaw: '5K-15K',
      salaryMin: 5000, salaryMax: 15000,
      description: '负责康复治疗器材的销售推广',
      requirement: '有销售经验优先'
    },
    expected: '中低分(排除词重扣)'
  },
  {
    name: '⑨ 城市不符(非目标城市)',
    job: {
      title: '康复治疗师',
      company: '某医院',
      location: '广州',
      salaryRaw: '8K-12K',
      salaryMin: 8000, salaryMax: 12000,
      description: '负责康复治疗',
      requirement: '康复治疗专业'
    },
    expected: '中低分(城市维度0分)'
  },
  {
    name: '⑩ 城市仅描述提及(弱匹配)',
    job: {
      title: '康复治疗师',
      company: '某医疗集团',
      location: '不限',
      salaryRaw: '6K-10K',
      salaryMin: 6000, salaryMax: 10000,
      description: '工作地点可能在南宁分部',
      requirement: '康复治疗专业'
    },
    expected: '中高分(城市半分)'
  },
  {
    name: '⑪ 完全不匹配(无关岗位)',
    job: {
      title: 'Java后端工程师',
      company: '某科技公司',
      location: '北京',
      salaryRaw: '15K-25K',
      salaryMin: 15000, salaryMax: 25000,
      description: '负责后端系统开发',
      requirement: 'Java, Spring Boot, 微服务'
    },
    expected: '低分(全维度不命中)'
  },
  {
    name: '⑫ "3年以上经验"硬性要求(经验排除开启)',
    job: {
      title: '康复治疗师',
      company: '某三甲医院',
      location: '南宁',
      salaryRaw: '10K-15K',
      salaryMin: 10000, salaryMax: 15000,
      description: '负责康复治疗',
      requirement: '3年以上工作经验,康复治疗专业'
    },
    filters: {
      includeKeywords: ['康复', '康复治疗', 'PT', 'OT', 'ST', '物理治疗', '作业治疗', '言语治疗', '理疗'],
      excludeKeywords: ['销售', '保险', '中介'],
      cities: ['北京', '上海', '广州'],
      minSalary: 0,
      maxSalary: 0,
      excludeCertRequired: true,
      certKeywords: ['执业证', '资格证', '持证', '须有证', '需要证书', '康复师证', '技师证'],
      excludeExpRequired: true,
      expKeywords: ['3年以上', '工作经验', '年以上经验'],
      minScore: 40
    },
    expected: '低分(≤59,经验硬性要求封顶)'
  },
  {
    name: '⑬ 薪资面议(中性,不扣分)',
    job: {
      title: '康复治疗师',
      company: '某诊所',
      location: '南宁',
      salaryRaw: '面议',
      salaryMin: 0, salaryMax: 0,
      description: '负责康复治疗工作',
      requirement: '康复治疗专业'
    },
    expected: '高分(薪资不拉低)'
  },
  {
    name: '⑭ 排除词在否定上下文("非销售")',
    job: {
      title: '非销售岗位-康复治疗师',
      company: '某机构',
      location: '南宁',
      salaryRaw: '6K-9K',
      salaryMin: 6000, salaryMax: 9000,
      description: '纯技术岗位,非销售性质',
      requirement: '康复治疗专业'
    },
    expected: '高分(排除词不扣分)'
  },
  {
    name: '⑮ 多维度全部命中(理想场景)',
    job: {
      title: 'PT物理治疗师',
      company: '南宁康复中心',
      location: '南宁',
      salaryRaw: '7K-10K',
      salaryMin: 7000, salaryMax: 10000,
      description: '负责物理治疗和康复治疗',
      requirement: '康复治疗专业,欢迎应届毕业生'
    },
    expected: '最高分(全维度命中)'
  }
];

// ============================================================
// 运行模拟并输出报告
// ============================================================
console.log('═'.repeat(90));
console.log('  匹配分机制 v2 全面模拟测试报告');
console.log('  筛选条件: 关键词[' + userFilters.includeKeywords.join(',') + ']');
console.log('  目标城市: [' + userFilters.cities.join(',') + ']');
console.log('  证书排除: ' + (userFilters.excludeCertRequired ? '开启' : '关闭'));
console.log('═'.repeat(90));

let passCount = 0;
let totalCount = scenarios.length;

scenarios.forEach((s, i) => {
  const filters = s.filters || userFilters;
  const result = evaluate(s.job, filters);
  const level = getMatchLevel(result.score);
  const levelLabel = { high: '推荐', medium: '可看', low: '不匹配' }[level];
  const confidence = (result.confidence * 100).toFixed(0) + '%';

  // 简单验证:分数是否在合理范围
  // 注意:用 else-if 链确保 "中高分"/"中低分" 优先于 "高分"/"低分" 匹配,避免子串误匹配
  let pass = true;
  if (s.expected.includes('最高分')) {
    if (result.score < 80) pass = false;
  } else if (s.expected.includes('中高分')) {
    if (result.score < 60 || result.score >= 85) pass = false;
  } else if (s.expected.includes('中低分')) {
    if (result.score < 40 || result.score >= 70) pass = false;
  } else if (s.expected.includes('中分')) {
    if (result.score < 40 || result.score >= 75) pass = false;
  } else if (s.expected.includes('高分')) {
    if (result.score < 70) pass = false;
  } else if (s.expected.includes('低分')) {
    if (result.score >= 60) pass = false;
  }

  if (pass) passCount++;

  const status = pass ? 'PASS' : 'FAIL';
  const bar = '█'.repeat(Math.floor(result.score / 5)) + '░'.repeat(20 - Math.floor(result.score / 5));

  console.log('');
  console.log('┌' + '─'.repeat(88) + '┐');
  console.log('│ ' + s.name.padEnd(86) + '│');
  console.log('├' + '─'.repeat(88) + '┤');
  console.log('│ 评分: ' + String(result.score).padStart(3) + '/100 [' + bar + '] ' + levelLabel + '  置信度: ' + confidence + '  ' + status);
  console.log('│ 预期: ' + s.expected);
  console.log('│ 原因:');
  result.reasons.forEach(r => {
    console.log('│   • ' + r);
  });
  console.log('└' + '─'.repeat(88) + '┘');
});

console.log('');
console.log('═'.repeat(90));
console.log('  模拟结果: ' + passCount + '/' + totalCount + ' 符合预期');
if (passCount === totalCount) {
  console.log('  ✅ 所有场景评分符合预期');
} else {
  console.log('  ❌ 有 ' + (totalCount - passCount) + ' 个场景不符合预期,需检查');
}
console.log('═'.repeat(90));

// ============================================================
// v1 vs v2 对比(关键场景)
// ============================================================
console.log('');
console.log('═'.repeat(90));
console.log('  v1 vs v2 关键差异对比(旧版子串匹配 vs 新版智能匹配)');
console.log('═'.repeat(90));

const v1MatchAny = (text, keywords) => {
  if (!text || !keywords) return [];
  const t = String(text).toLowerCase();
  return keywords.filter(k => k && t.includes(String(k).toLowerCase()));
};

const v1ScoreKeyword = (job, keywords) => {
  const title = job.title || '';
  const body = (job.description || '') + ' ' + (job.requirement || '');
  const titleHits = v1MatchAny(title, keywords);
  const bodyHits = v1MatchAny(body, keywords).filter(k => !titleHits.includes(k));
  if (titleHits.length > 0) return { sub: 0.85 + Math.min(1, titleHits.length / 3) * 0.15, hits: titleHits, where: '标题' };
  if (bodyHits.length > 0) return { sub: 0.30 + Math.min(1, bodyHits.length / 3) * 0.15, hits: bodyHits, where: '描述' };
  return { sub: 0, hits: [], where: '未命中' };
};

const compareScenarios = [
  { name: '否定上下文:"非康复岗位"', job: { title: '非康复岗位', description: '', requirement: '' } },
  { name: '词边界:PT in Input', job: { title: 'Input Operator', description: 'output processing', requirement: '' } },
  { name: '去重:康复治疗+康复', job: { title: '康复治疗师', description: '康复治疗', requirement: '' } },
  { name: '要求区vs描述区', job: { title: '医疗岗', description: '涉及康复治疗', requirement: '康复治疗专业' } }
];

compareScenarios.forEach(s => {
  const v1 = v1ScoreKeyword(s.job, userFilters.includeKeywords);
  const v2 = evaluate(s.job, { ...userFilters, excludeCertRequired: false, excludeKeywords: [] });
  console.log('');
  console.log('  场景: ' + s.name);
  console.log('    v1: sub=' + v1.sub.toFixed(2) + '  命中=' + JSON.stringify(v1.hits) + '  位置=' + v1.where);
  const v2Reason = v2.reasons.find(r => r.includes('命中') || r.includes('未命中')) || 'N/A';
  console.log('    v2: score=' + v2.score + '  ' + v2Reason);
  console.log('    差异: ' + (v1.sub > 0 && v2.score < 50 ? 'v1虚高,v2正确排除' :
                              v1.hits.length > 1 && v2.score >= 50 ? 'v1重复计分,v2去重' :
                              'v2分层评分更精准'));
});

console.log('');
console.log('═'.repeat(90));
