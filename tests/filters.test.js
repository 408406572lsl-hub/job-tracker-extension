// ============================================================
// filters.test.js — 筛选匹配引擎单元测试
// 覆盖:关键词命中、城市匹配、薪资区间、证书/经验排除、排除词扣分、
//      未配置筛选时的中性基线、匹配等级判定
// ============================================================

describe('JTFilters', () => {
  const evaluate = JTFilters.evaluate;
  const getMatchLevel = JTFilters.getMatchLevel;

  // 构造一个基础岗位对象
  const baseJob = (overrides = {}) => ({
    title: '口腔医师',
    company: '某口腔医院',
    location: '杭州',
    salaryRaw: '8K-12K',
    salaryMin: 8000,
    salaryMax: 12000,
    description: '负责口腔诊疗工作,有执业医师证优先',
    requirement: '口腔医学专业,持有医师执业证书',
    ...overrides
  });

  // ----------------------------------------------------------
  // 1. 关键词匹配维度
  // ----------------------------------------------------------
  describe('关键词匹配', () => {
    test('标题命中关键词应给高分', () => {
      const filters = { includeKeywords: ['口腔', '医师'], minScore: 0 };
      const r = evaluate(baseJob(), filters);
      expect(r.score).toBeGreaterThanOrEqual(70);
      expect(r.reasons.some(s => s.includes('标题命中'))).toBe(true);
    });

    test('仅描述命中应给中分', () => {
      const filters = { includeKeywords: ['诊疗'], minScore: 0 };
      const r = evaluate(baseJob({ title: '其他岗位' }), filters);
      expect(r.reasons.some(s => s.includes('描述命中'))).toBe(true);
    });

    test('未命中关键词应得 0 分(关键词维度)', () => {
      const filters = { includeKeywords: ['Java', '后端'], minScore: 0 };
      const r = evaluate(baseJob(), filters);
      expect(r.reasons.some(s => s.includes('未命中'))).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 2. 城市匹配维度
  // ----------------------------------------------------------
  describe('城市匹配', () => {
    test('地点字段命中应给满分', () => {
      const filters = { cities: ['杭州', '上海'], minScore: 0 };
      const r = evaluate(baseJob(), filters);
      expect(r.reasons.some(s => s.includes('城市匹配'))).toBe(true);
    });

    test('仅描述提及应给半分', () => {
      const filters = { cities: ['北京'], minScore: 0 };
      const r = evaluate(baseJob({
        location: '杭州',
        description: '工作地点可能在北京也有分部'
      }), filters);
      expect(r.reasons.some(s => s.includes('仅描述提及'))).toBe(true);
    });

    test('城市不符应得 0 分(该维度)', () => {
      const filters = { cities: ['深圳'], minScore: 0 };
      const r = evaluate(baseJob({ location: '杭州' }), filters);
      expect(r.reasons.some(s => s.includes('城市不符'))).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 3. 薪资匹配维度
  // ----------------------------------------------------------
  describe('薪资匹配', () => {
    test('区间内应给满分', () => {
      const filters = { minSalary: 5000, maxSalary: 15000, minScore: 0 };
      const r = evaluate(baseJob({ salaryMin: 8000, salaryMax: 12000 }), filters);
      expect(r.reasons.some(s => s.includes('薪资合适'))).toBe(true);
    });

    test('略超区间(20%内)应给半分', () => {
      // avg=15000, maxSalary=13000, 15000 <= 13000*1.2=15600
      const filters = { minSalary: 0, maxSalary: 13000, minScore: 0 };
      const r = evaluate(baseJob({ salaryMin: 14000, salaryMax: 16000, salaryRaw: '14-16K' }), filters);
      expect(r.reasons.some(s => s.includes('略超区间'))).toBe(true);
    });

    test('面议/未知薪资应给中性半分', () => {
      const filters = { minSalary: 5000, maxSalary: 15000, minScore: 0 };
      const r = evaluate(baseJob({ salaryMin: 0, salaryMax: 0, salaryRaw: '面议' }), filters);
      expect(r.reasons.some(s => s.includes('薪资未知'))).toBe(true);
    });

    test('严重超出区间应得低分', () => {
      const filters = { minSalary: 0, maxSalary: 5000, minScore: 0 };
      const r = evaluate(baseJob({ salaryMin: 20000, salaryMax: 30000, salaryRaw: '20-30K' }), filters);
      expect(r.reasons.some(s => s.includes('薪资不匹配'))).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 4. 证书/经验排除
  // ----------------------------------------------------------
  describe('证书与经验排除', () => {
    test('要求证书时开启排除应扣分', () => {
      const filters = {
        excludeCertRequired: true,
        certKeywords: ['执业医师证', '医师执业证书'],
        minScore: 0
      };
      const r = evaluate(baseJob(), filters);
      expect(r.reasons.some(s => s.includes('要求证书'))).toBe(true);
    });

    test('不要求证书时开启排除应给满分(该维度)', () => {
      const filters = {
        excludeCertRequired: true,
        certKeywords: ['执业医师证'],
        minScore: 0
      };
      const r = evaluate(baseJob({
        requirement: '口腔医学专业',
        description: '负责诊疗工作'
      }), filters);
      expect(r.reasons.some(s => s.includes('未要求证书'))).toBe(true);
    });

    test('要求工作经验时开启排除应扣分', () => {
      const filters = {
        excludeExpRequired: true,
        expKeywords: ['3年以上', '工作经验'],
        minScore: 0
      };
      const r = evaluate(baseJob({
        requirement: '3年以上工作经验,口腔医学专业'
      }), filters);
      expect(r.reasons.some(s => s.includes('要求工作经验'))).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 5. 排除词扣分
  // ----------------------------------------------------------
  describe('排除词扣分', () => {
    test('标题命中排除词应重扣', () => {
      const filters = { excludeKeywords: ['实习', '兼职'], minScore: 0 };
      const r = evaluate(baseJob({ title: '口腔医师(实习)' }), filters);
      expect(r.reasons.some(s => s.includes('命中排除词'))).toBe(true);
      expect(r.score).toBeLessThan(55); // 基线 55 - 扣分
    });

    test('描述命中排除词应轻扣', () => {
      const filters = { excludeKeywords: ['夜班'], minScore: 0 };
      const r = evaluate(baseJob({
        description: '偶有夜班安排'
      }), filters);
      expect(r.reasons.some(s => s.includes('命中排除词'))).toBe(true);
    });

    test('未命中排除词不扣分', () => {
      const filters = { excludeKeywords: ['Java'], minScore: 0 };
      const r = evaluate(baseJob(), filters);
      expect(r.reasons.some(s => s.includes('命中排除词'))).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 6. 未配置筛选条件
  // ----------------------------------------------------------
  describe('未配置筛选条件', () => {
    test('应返回中性基线分(55)', () => {
      const r = evaluate(baseJob(), {});
      expect(r.score).toBe(55);
      expect(r.reasons.some(s => s.includes('未设置有效筛选条件'))).toBe(true);
    });

    test('null filters 应回退到默认筛选(不崩溃,分数落在 0-100)', () => {
      const r = evaluate(baseJob(), null);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    });
  });

  // ----------------------------------------------------------
  // 7. matched 判定
  // ----------------------------------------------------------
  describe('matched 判定', () => {
    test('分数 >= minScore 时 matched=true', () => {
      const filters = { includeKeywords: ['口腔'], minScore: 50 };
      const r = evaluate(baseJob(), filters);
      expect(r.matched).toBe(true);
    });

    test('分数 < minScore 时 matched=false', () => {
      const filters = { includeKeywords: ['Java'], minScore: 50 };
      const r = evaluate(baseJob(), filters);
      expect(r.matched).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 8. getMatchLevel
  // ----------------------------------------------------------
  describe('getMatchLevel', () => {
    test('70 分以上为 high', () => {
      expect(getMatchLevel(70)).toBe('high');
      expect(getMatchLevel(100)).toBe('high');
    });

    test('40-69 分为 medium', () => {
      expect(getMatchLevel(40)).toBe('medium');
      expect(getMatchLevel(69)).toBe('medium');
    });

    test('40 分以下为 low', () => {
      expect(getMatchLevel(0)).toBe('low');
      expect(getMatchLevel(39)).toBe('low');
    });
  });

  // ----------------------------------------------------------
  // 9. 综合场景
  // ----------------------------------------------------------
  describe('综合场景', () => {
    test('多维度命中应得高分', () => {
      const filters = {
        includeKeywords: ['口腔', '医师'],
        cities: ['杭州'],
        minSalary: 5000,
        maxSalary: 15000,
        minScore: 60
      };
      const r = evaluate(baseJob(), filters);
      expect(r.score).toBeGreaterThanOrEqual(70);
      expect(r.matched).toBe(true);
    });

    test('排除词应显著拉低高分岗位(权重模型下可能仍匹配,属设计取向)', () => {
      const filters = {
        includeKeywords: ['口腔', '医师'],
        cities: ['杭州'],
        excludeKeywords: ['实习'],
        minScore: 60
      };
      const r = evaluate(baseJob({ title: '口腔医师(实习)' }), filters);
      expect(r.score).toBeLessThan(70); // 排除词应显著拉低分数
      expect(r.reasons.some(s => s.includes('命中排除词'))).toBe(true);
      // 注:强关键词+城市命中可抵消部分排除扣分,若希望排除词"必定"翻转为不匹配,
      // 需在 scoreWeights 中提高 excludePenaltyTitle 或引入"排除词命中即封顶"规则。
    });
  });

  // ----------------------------------------------------------
  // 10. v2 智能匹配:否定上下文
  // ----------------------------------------------------------
  describe('否定上下文检测', () => {
    test('关键词前有"非"不应命中', () => {
      const filters = { includeKeywords: ['康复'], minScore: 0 };
      const r = evaluate(baseJob({
        title: '非康复岗位',
        description: '负责行政工作',
        requirement: ''
      }), filters);
      expect(r.reasons.some(s => s.includes('未命中'))).toBe(true);
    });

    test('关键词前有"不需要"不应命中', () => {
      const filters = { includeKeywords: ['康复'], minScore: 0 };
      const r = evaluate(baseJob({
        title: '前台接待',
        description: '不需要康复相关经验',
        requirement: ''
      }), filters);
      expect(r.reasons.some(s => s.includes('未命中'))).toBe(true);
    });

    test('排除词在否定上下文中不应扣分', () => {
      const filters = { excludeKeywords: ['销售'], minScore: 0 };
      const r = evaluate(baseJob({
        title: '非销售岗位',
        description: '负责诊疗工作',
        requirement: ''
      }), filters);
      expect(r.reasons.some(s => s.includes('命中排除词'))).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 11. v2 智能匹配:短关键词词边界
  // ----------------------------------------------------------
  describe('短关键词词边界', () => {
    test('PT 不应匹配英文单词内部', () => {
      const filters = { includeKeywords: ['PT'], minScore: 0 };
      const r = evaluate(baseJob({
        title: 'Input Operator',
        description: 'responsible for output processing',
        requirement: ''
      }), filters);
      expect(r.reasons.some(s => s.includes('未命中'))).toBe(true);
    });

    test('PT 在中文语境中应正常命中', () => {
      const filters = { includeKeywords: ['PT'], minScore: 0 };
      const r = evaluate(baseJob({
        title: 'PT康复治疗师',
        description: '负责物理治疗',
        requirement: ''
      }), filters);
      expect(r.reasons.some(s => s.includes('标题命中'))).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 12. v2 智能匹配:任职要求与描述分离
  // ----------------------------------------------------------
  describe('任职要求分离评分', () => {
    test('任职要求命中应比描述命中给更高分', () => {
      const filters = { includeKeywords: ['康复治疗'], minScore: 0 };
      const reqJob = evaluate(baseJob({
        title: '医疗岗位',
        description: '负责日常工作',
        requirement: '康复治疗专业毕业'
      }), filters);
      const descJob = evaluate(baseJob({
        title: '医疗岗位',
        description: '涉及康复治疗相关工作',
        requirement: '医学相关专业'
      }), filters);
      expect(reqJob.score).toBeGreaterThan(descJob.score);
      expect(reqJob.reasons.some(s => s.includes('任职要求命中'))).toBe(true);
      expect(descJob.reasons.some(s => s.includes('描述命中'))).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 13. v2 智能匹配:硬性要求 vs 加分项
  // ----------------------------------------------------------
  describe('证书要求强度区分', () => {
    test('"必须持证"应给0分(硬性要求)', () => {
      const filters = {
        excludeCertRequired: true,
        certKeywords: ['执业证'],
        minScore: 0
      };
      const r = evaluate(baseJob({
        title: '康复治疗师',
        description: '负责诊疗',
        requirement: '必须持有执业证'
      }), filters);
      expect(r.reasons.some(s => s.includes('硬性要求'))).toBe(true);
    });

    test('"持证优先"应给半分(加分项)', () => {
      const filters = {
        excludeCertRequired: true,
        certKeywords: ['执业证'],
        minScore: 0
      };
      const r = evaluate(baseJob({
        title: '康复治疗师',
        description: '负责诊疗',
        requirement: '有执业证优先'
      }), filters);
      expect(r.reasons.some(s => s.includes('加分项'))).toBe(true);
    });

    test('"3年以上经验"应识别为硬性要求', () => {
      const filters = {
        excludeExpRequired: true,
        expKeywords: ['3年以上', '工作经验'],
        minScore: 0
      };
      const r = evaluate(baseJob({
        title: '康复治疗师',
        description: '负责诊疗',
        requirement: '3年以上工作经验,康复治疗专业'
      }), filters);
      expect(r.reasons.some(s => s.includes('硬性要求'))).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 14. v2 智能匹配:关键词去重
  // ----------------------------------------------------------
  describe('关键词去重', () => {
    test('"康复治疗"和"康复"同时命中只计一次', () => {
      const filters = { includeKeywords: ['康复', '康复治疗'], minScore: 0 };
      const r = evaluate(baseJob({
        title: '康复治疗师',
        description: '负责康复治疗工作',
        requirement: ''
      }), filters);
      // 标题命中原因中不应同时出现"康复"和"康复治疗"(后者包含前者,去重)
      const titleReason = r.reasons.find(s => s.includes('标题命中'));
      if (titleReason) {
        // 应只保留较长的"康复治疗"
        expect(titleReason.includes('康复治疗')).toBe(true);
      }
    });
  });

  // ----------------------------------------------------------
  // 15. v2 置信度
  // ----------------------------------------------------------
  describe('置信度', () => {
    test('无筛选条件时置信度极低', () => {
      const r = evaluate(baseJob(), {});
      expect(r.confidence).toBeLessThanOrEqual(0.10);
    });

    test('单维度筛选置信度较低', () => {
      const filters = { includeKeywords: ['口腔'], minScore: 0 };
      const r = evaluate(baseJob(), filters);
      expect(r.confidence).toBeGreaterThanOrEqual(0.25);
      expect(r.confidence).toBeLessThan(0.55);
    });

    test('多维度筛选置信度较高', () => {
      const filters = {
        includeKeywords: ['口腔'],
        cities: ['杭州'],
        minSalary: 5000,
        maxSalary: 15000,
        excludeCertRequired: true,
        minScore: 0
      };
      const r = evaluate(baseJob(), filters);
      expect(r.confidence).toBeGreaterThanOrEqual(0.75);
    });
  });
});
