// ============================================================
// parseSalary.test.js — 薪资解析单元测试
// 覆盖:K/千/万单位、年薪转月薪、面议/空值、单值、异常格式
// ============================================================

describe('JTParser.parseSalary', () => {
  const parseSalary = JTParser.parseSalary;

  test('解析 "8K-12K" 应转换为 8000-12000', () => {
    const r = parseSalary('8K-12K');
    expect(r.min).toBe(8000);
    expect(r.max).toBe(12000);
    expect(r.unit).toBe('8K-12K');
  });

  test('解析 "8k-12k" 小写 k 也应识别', () => {
    const r = parseSalary('8k-12k');
    expect(r.min).toBe(8000);
    expect(r.max).toBe(12000);
  });

  test('解析 "5千-8千" 中文千应识别', () => {
    const r = parseSalary('5千-8千');
    expect(r.min).toBe(5000);
    expect(r.max).toBe(8000);
  });

  test('解析 "1万-1.5万" 万应乘10000', () => {
    const r = parseSalary('1万-1.5万');
    expect(r.min).toBe(10000);
    expect(r.max).toBe(15000);
  });

  test('解析 "10-20万/年" 年薪应除以12转月薪', () => {
    const r = parseSalary('10-20万/年');
    expect(r.min).toBe(Math.round(100000 / 12));
    expect(r.max).toBe(Math.round(200000 / 12));
  });

  test('解析 "8-12K/年" K+年薪组合', () => {
    const r = parseSalary('8-12K/年');
    expect(r.min).toBe(Math.round(8000 / 12));
    expect(r.max).toBe(Math.round(12000 / 12));
  });

  test('解析 "面议" 应返回 0/0', () => {
    const r = parseSalary('面议');
    expect(r.min).toBe(0);
    expect(r.max).toBe(0);
    expect(r.unit).toBe('面议');
  });

  test('空字符串应返回 0/0/空', () => {
    const r = parseSalary('');
    expect(r.min).toBe(0);
    expect(r.max).toBe(0);
    expect(r.unit).toBe('');
  });

  test('null/undefined 应安全返回 0/0/空', () => {
    expect(parseSalary(null)).toEqual({ min: 0, max: 0, unit: '' });
    expect(parseSalary(undefined)).toEqual({ min: 0, max: 0, unit: '' });
  });

  test('小数薪资 "3.5K-5.5K" 应正确解析', () => {
    const r = parseSalary('3.5K-5.5K');
    expect(r.min).toBe(3500);
    expect(r.max).toBe(5500);
  });

  test('使用"至"作为分隔符 "6K至10K"', () => {
    const r = parseSalary('6K至10K');
    expect(r.min).toBe(6000);
    expect(r.max).toBe(10000);
  });

  test('使用"到"作为分隔符 "6K到10K"', () => {
    const r = parseSalary('6K到10K');
    expect(r.min).toBe(6000);
    expect(r.max).toBe(10000);
  });

  test('无法匹配的格式 "薪资优厚" 应保留原文为 unit', () => {
    const r = parseSalary('薪资优厚');
    expect(r.min).toBe(0);
    expect(r.max).toBe(0);
    expect(r.unit).toBe('薪资优厚');
  });
});
