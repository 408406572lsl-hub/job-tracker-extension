// ============================================================
// autoscan.test.js — 自动扫描逻辑 + BOSS 列表卡片采集回归测试
// 验证:URL 构建 / 岗位归一化 / 分析挑选 / 日计数重置 / 列表卡片解析
// ============================================================
/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://www.zhipin.com/web/geek/job?query=%E5%BA%B7%E5%A4%8D&city=101280600"}
 */

describe('JTAutoScan 纯逻辑', () => {
  const baseCfg = () => JTAutoScan.merge({
    enabled: true, keywords: '康复 推拿', city: '101280600', cityName: '长沙',
    intervalMin: 60, maxPerScan: 20, enrichDetails: true, autoAnalyze: true,
    analyzePerDay: 30
  });

  test('buildBossSearchUrls:每个关键词生成一个 URL', () => {
    const urls = JTAutoScan.buildBossSearchUrls(baseCfg());
    expect(urls.length).toBe(2);
    expect(urls[0]).toContain('https://www.zhipin.com/web/geek/job?');
    expect(urls[0]).toContain('query=');
    expect(urls[0]).toContain('city=101280600');
    expect(urls[0]).toContain('page=1');
    // 中文被编码
    expect(decodeURIComponent(urls[0])).toContain('康复');
  });

  test('buildBossSearchUrls:空关键词不产生 URL', () => {
    const urls = JTAutoScan.buildBossSearchUrls(JTAutoScan.merge({ keywords: '   ', city: '101280600' }));
    expect(urls.length).toBe(0);
  });

  test('normalizeCollected:补齐运行状态字段', () => {
    const jobs = JTAutoScan.normalizeCollected([
      { id: 'a', url: 'https://x/1', title: '推拿师' },
      { id: 'b', url: 'https://x/2', title: '康复师', status: 'applied' }
    ], 123456);
    expect(jobs[0].collectedVia).toBe('auto');
    expect(jobs[0].status).toBe('unseen');
    expect(jobs[0].capturedAt).toBe(123456);
    // 已存在 status 也会被覆盖为 unseen(自动采集统一标记待看)
    expect(jobs[1].status).toBe('unseen');
  });

  test('pickJobsForAnalysis:受每日上限与每轮上限约束', () => {
    const jobs = Array.from({ length: 10 }, (_, i) => ({ id: 'j' + i }));
    const cfg = baseCfg();
    // usedToday=0, cap=20 → 全取 10
    expect(JTAutoScan.pickJobsForAnalysis(jobs, cfg, 0).length).toBe(10);
    // usedToday=28, 剩余 2 → 取 2
    expect(JTAutoScan.pickJobsForAnalysis(jobs, cfg, 28).length).toBe(2);
    // autoAnalyze=false → 0
    expect(JTAutoScan.pickJobsForAnalysis(jobs, JTAutoScan.merge({ autoAnalyze: false }), 0).length).toBe(0);
    // 达到每日上限 → 0
    expect(JTAutoScan.pickJobsForAnalysis(jobs, cfg, 30).length).toBe(0);
  });

  test('resetDailyIfNeeded:跨日重置当日分析计数', () => {
    const state = { lastDate: '2026-07-07', analyzedToday: 12 };
    JTAutoScan.resetDailyIfNeeded(state);
    // 模拟"今天"与 lastDate 不同(用真实当天会随测试日变化,这里直接验证重置逻辑)
    const forced = { lastDate: '1999-01-01', analyzedToday: 99 };
    JTAutoScan.resetDailyIfNeeded(forced);
    expect(forced.analyzedToday).toBe(0);
    expect(forced.lastDate).toBe(JTAutoScan.dayKey());
  });

  test('shouldRun:仅 enabled 时运行', () => {
    expect(JTAutoScan.shouldRun(baseCfg())).toBe(true);
    expect(JTAutoScan.shouldRun(JTAutoScan.merge({ enabled: false }))).toBe(false);
  });

  test('reachedJobCap:达到"本次最多采集"上限即停止', () => {
    // 0 / 负数 = 不限制
    expect(JTAutoScan.reachedJobCap(0, 0)).toBe(false);
    expect(JTAutoScan.reachedJobCap(999, 0)).toBe(false);
    expect(JTAutoScan.reachedJobCap(10, -5)).toBe(false);
    // 达到上限(含等于)即返回 true
    expect(JTAutoScan.reachedJobCap(49, 50)).toBe(false);
    expect(JTAutoScan.reachedJobCap(50, 50)).toBe(true);
    expect(JTAutoScan.reachedJobCap(80, 50)).toBe(true);
  });

  test('merge:默认配置含 maxJobsPerRun 字段(默认 0 = 不限制)', () => {
    const cfg = JTAutoScan.merge({});
    expect(cfg.maxJobsPerRun).toBe(0);
    // 用户设置的上限应被保留
    expect(JTAutoScan.merge({ maxJobsPerRun: 30 }).maxJobsPerRun).toBe(30);
  });
});

describe('BOSS 列表卡片采集', () => {
  beforeAll(() => {
    try {
      Object.defineProperty(globalThis, 'location', {
        value: new URL('https://www.zhipin.com/web/geek/job?query=%E5%BA%B7%E5%A4%8D&city=101280600'),
        configurable: true, writable: true
      });
    } catch (e) { /* ignore */ }
    // innerText 桥接 textContent(jsdom 无布局)
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
      if (!desc || !desc.get || desc.get.toString().includes('layout')) {
        Object.defineProperty(HTMLElement.prototype, 'innerText', {
          get() { return this.textContent; },
          set(v) { this.textContent = v; },
          configurable: true
        });
      }
    } catch (e) { /* skip */ }

    document.body.innerHTML = `
      <div class="job-card-wrap">
        <a href="https://www.zhipin.com/job_detail/aaa.html">
          <span class="job-name">中医推拿按摩师</span>
          <span class="job-salary">5-8K·13薪</span>
          <span class="boss-name">长沙明眸建盟健康管理</span>
          <span class="company-location">长沙</span>
        </a>
      </div>
      <div class="job-card-wrap">
        <a href="https://www.zhipin.com/job_detail/bbb.html">
          <span class="job-name">康复治疗师</span>
          <span class="job-salary">6-10K</span>
          <span class="boss-name">某康复医院</span>
          <span class="company-location">南宁</span>
        </a>
      </div>`;
  });

  test('findJobCards 找到两张卡片', () => {
    const cards = JTParser.findJobCards();
    expect(cards.length).toBeGreaterThanOrEqual(2);
  });

  test('parseJobFromCard 提取标题/公司/薪资/地点/链接', () => {
    const cards = JTParser.findJobCards();
    const jobs = cards.map(c => JTParser.parseJobFromCard(c)).filter(Boolean);
    const tui = jobs.find(j => j.url.includes('aaa.html'));
    expect(tui).toBeDefined();
    expect(tui.title).toBe('中医推拿按摩师');
    expect(tui.company).toContain('长沙明眸建盟健康管理');
    expect(tui.salaryRaw).toContain('5-8K');
    expect(tui.location).toBe('长沙');
    expect(tui.url).toContain('job_detail/aaa.html');
    expect(tui.status).toBe('unseen');
    expect(tui.collectedVia).toBeUndefined(); // 列表解析不含该字段,归一化时才加
  });
});
