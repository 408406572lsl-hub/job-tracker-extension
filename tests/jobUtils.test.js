// ============================================================
// jobUtils.test.js — JT_Utils 去重工具单元测试
// 覆盖:normalizeUrl、jobKey、findDuplicate
// ============================================================

describe('JT_Utils', () => {
  const normalizeUrl = JT_Utils.normalizeUrl;
  const jobKey = JT_Utils.jobKey;
  const findDuplicate = JT_Utils.findDuplicate;

  // ----------------------------------------------------------
  // 1. normalizeUrl
  // ----------------------------------------------------------
  describe('normalizeUrl', () => {
    test('应去除 utm_* 跟踪参数', () => {
      const r = normalizeUrl('https://example.com/job/123?utm_source=wechat&utm_medium=share');
      expect(r).toBe('https://example.com/job/123');
    });

    test('应去除 from/source/ref 等跟踪参数', () => {
      const r = normalizeUrl('https://example.com/job/123?from=home&source=app&ref=menu');
      expect(r).toBe('https://example.com/job/123');
    });

    test('应保留业务参数(如 jobid)', () => {
      const r = normalizeUrl('https://example.com/job?jobid=456&from=nav');
      expect(r).toBe('https://example.com/job?jobid=456');
    });

    test('应去除 hash', () => {
      const r = normalizeUrl('https://example.com/job/123#detail');
      expect(r).toBe('https://example.com/job/123');
    });

    test('应统一 host 小写', () => {
      const r = normalizeUrl('https://EXAMPLE.COM/Job/123');
      expect(r).toBe('https://example.com/Job/123');
    });

    test('应去除末尾斜杠', () => {
      const r = normalizeUrl('https://example.com/job/123/');
      expect(r).toBe('https://example.com/job/123');
    });

    test('空值应返回空字符串', () => {
      expect(normalizeUrl('')).toBe('');
      expect(normalizeUrl(null)).toBe('');
      expect(normalizeUrl(undefined)).toBe('');
    });

    test('危险协议(javascript:/data:/vbscript:)应被拒绝返回空字符串', () => {
      expect(normalizeUrl('  javascript:void(0)#xxx  ')).toBe('');
      expect(normalizeUrl('data:text/html,<script>x</script>')).toBe('');
      expect(normalizeUrl('vbscript:msgbox(1)')).toBe('');
    });

    test('无协议的非标准 URL 应走 catch 兜底:trim + 去 hash + 去末尾斜杠', () => {
      const r = normalizeUrl('  example.com/job/123#frag/  ');
      expect(r).toBe('example.com/job/123');
    });
  });

  // ----------------------------------------------------------
  // 2. jobKey
  // ----------------------------------------------------------
  describe('jobKey', () => {
    test('有 URL 时应以 u: 开头 + normalizeUrl 结果', () => {
      const key = jobKey({ url: 'https://example.com/job/1?utm_source=x' });
      expect(key).toBe('u:https://example.com/job/1');
    });

    test('URL 缺失时用 title+company 兜底,以 t: 开头', () => {
      const key = jobKey({ title: ' 口腔医师 ', company: '某医院' });
      expect(key).toBe('t:口腔医师|某医院');
    });

    test('兜底键应 trim + 小写,消除大小写差异', () => {
      const k1 = jobKey({ title: 'Oral Doctor', company: 'Hospital' });
      const k2 = jobKey({ title: 'oral doctor', company: 'hospital' });
      expect(k1).toBe(k2);
    });

    test('URL 和 title 都缺失时返回空字符串', () => {
      expect(jobKey({})).toBe('');
      expect(jobKey(null)).toBe('');
    });

    test('同岗不同跟踪参数应生成相同键', () => {
      const k1 = jobKey({ url: 'https://example.com/job/1?utm_source=a' });
      const k2 = jobKey({ url: 'https://example.com/job/1?from=home' });
      expect(k1).toBe(k2);
    });

    test('同岗带 BOSS 的 ka 跟踪参数应生成相同键(去重/墓碑生效前提)', () => {
      // BOSS 岗位详情链接常带 ?ka=search_list_N(随列表位置变化),若 key 漂移会导致
      // 同一岗位重复入库、且删除后扫描又复活。修复后 ka 应被剔除。
      const k1 = jobKey({ url: 'https://www.zhipin.com/job/123?ka=search_list_1' });
      const k2 = jobKey({ url: 'https://www.zhipin.com/job/123?ka=search_list_3' });
      expect(k1).toBe(k2);
      expect(k1).toBe('u:https://www.zhipin.com/job/123');
    });
  });

  // ----------------------------------------------------------
  // 3. findDuplicate
  // ----------------------------------------------------------
  describe('findDuplicate', () => {
    const jobs = [
      { id: 'a', url: 'https://example.com/job/1', title: '岗位A', company: '公司A' },
      { id: 'b', url: 'https://example.com/job/2', title: '岗位B', company: '公司B' }
    ];

    test('同 URL(含跟踪参数)应找到重复', () => {
      const idx = findDuplicate(jobs, { url: 'https://example.com/job/1?utm_source=x' });
      expect(idx).toBe(0);
    });

    test('不同 URL 不应找到重复', () => {
      const idx = findDuplicate(jobs, { url: 'https://example.com/job/999' });
      expect(idx).toBe(-1);
    });

    test('URL 缺失但 title+company 匹配应找到重复', () => {
      // 注意:findDuplicate 以 jobKey 为准。若已存岗位带 URL,其键为 u: 前缀,
      // 不会与仅含 title+company 的 t: 键匹配。故此处用"无 URL 岗位列表"验证兜底逻辑。
      const noUrlJobs = [
        { id: 'a', title: '岗位A', company: '公司A' },
        { id: 'b', title: '岗位B', company: '公司B' }
      ];
      const idx = findDuplicate(noUrlJobs, { title: '岗位A', company: '公司A' });
      expect(idx).toBe(0);
    });

    test('URL 缺失且 title+company 不匹配应返回 -1', () => {
      const idx = findDuplicate(jobs, { title: '岗位X', company: '公司X' });
      expect(idx).toBe(-1);
    });

    test('空列表应返回 -1', () => {
      expect(findDuplicate([], { url: 'https://example.com/1' })).toBe(-1);
    });

    test('target 为 null 应返回 -1', () => {
      expect(findDuplicate(jobs, null)).toBe(-1);
    });

    test('key 为空(无 url 无 title)应返回 -1', () => {
      expect(findDuplicate(jobs, { company: '某公司' })).toBe(-1);
    });
  });
});
