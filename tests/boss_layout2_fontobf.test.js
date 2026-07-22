/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://www.zhipin.com/job_detail/x.html"}
 */
// ============================================================
// boss_layout2_fontobf.test.js — 模拟 BOSS 直聘字体反爬回归测试
// 真实浏览器里 BOSS 可能让 document.body.innerText(整页聚合)返回空字符串,
// 但各子元素(含 .job-detail 容器)的 innerText/textContent 仍含真实字符
// (用户 2026-07-07 15:21 诊断佐证:.job-sec-text/.boss-info-attr/.salary 均 matched:true 且有全文)。
// 旧代码 extractBossTitleFromBody 直读 document.body.innerText → 拿到 '' →
// 标题回退 <title> 技能标签"针灸推拿"。本测试仅清空 document.body.innerText,
// 子元素仍可读,以此忠实复现并锁死 v1.5.15 修复(改用 getText(document.body),
// innerText 空则回退 textContent,与 company/salary/description 一致)。
// 注意:docblock 必须置顶,否则 jsdom 退化 localhost 使站点识别失效。
// ============================================================
describe('zhipin.com 字体反爬(body.innerText 为空)布局', () => {
  const JD = `一、工作内容 1，熟悉中医按摩相关知识，认真执行各项理疗技术操作规程 2，利用中医推拿手法给客户提供颈肩腰腿痛的治疗和调理 3，主要的工作就是做中医推拿，正规的，给客户解决办公久坐久站的方面的疲劳以及相关症状 4、能够服务门店管理，相互配合做好客户服务工作。 二、招聘人员：中医推拿按摩师：男女不限！ 三、招聘要求： 1、手法较好，面试需要试手法，需要根据手法而定。 2、手法欠佳者，其他方面可以，能吃苦耐劳，我们有自己的专业的培训中心，可以免费岗前培训后上岗，不收取任何费用，培训期间包吃包住。 3、年龄要求45周岁以下，请您悉知 4、不做足疗和spa 相关业务，主要是做推拿，正规纯粹，其他的勿扰。 5、公司没有产品推销，没有推销任务！主要是以手法为主，以踏实做技术为主。 四．待遇 1、包吃包住，有单独宿舍，空调热水器，洗衣机一应俱全。 2、保底4000至6000元，根据你的手法而定。 五、我们的优势 1、我们是长沙地区连锁店。 六、我们的期望 1、欢迎广大应届生和往届生。`;

  beforeAll(() => {
    // 子元素 innerText 桥接到 textContent(正常可读);与 boss_layout2.test.js 一致
    try {
      Object.defineProperty(HTMLElement.prototype, 'innerText', {
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
        configurable: true
      });
    } catch (e) {}
    // 关键:仅 document.body.innerText 被字体反爬清空(整页聚合层),子元素不受影响
    try {
      Object.defineProperty(document.body, 'innerText', {
        get() { return ''; },
        set(v) { this.textContent = v; },
        configurable: true
      });
    } catch (e) {}
    window.Element.prototype.getBoundingClientRect = function () {
      return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0 };
    };
    document.title = '针灸推拿-招聘-BOSS直聘';
    document.body.innerHTML = `
      <div class="job-detail">
        <div class="share">微信扫码分享 举报</div>
        <div class="job-sec-header">职位描述</div>
        <div class="job-tags">康复理疗机构 推拿 接受无针灸/推拿相关经验 无销售性质</div>
        <div class="job-desc">${JD}</div>
        <div class="salary-detail">薪资详情 薪资范围：4000-9000元/月 发薪日期：15日 提成方式：按单提成； 奖金补贴：餐补、加班费、绩效奖金、全勤奖、工龄奖、包吃、包住</div>
        <h2 class="name">郭女士 刚刚活跃</h2>
        <div class="boss-info-attr">长沙明眸建盟健康管理 · 招聘经理</div>
        <div class="company-name">公司名称 长沙明眸建盟健康管理有限公司</div>
        <p class="salary">5-8K·13薪</p>
        <div class="company-location">长沙</div>
        <div class="company-intro">公司介绍 明眸简介 明眸建盟推拿是长沙明眸建盟健康管理有限公司旗下运营品牌之一。</div>
        <div class="widget">竞争力分析 查看完整个人竞争力 个人综合排名：在人中排名第 你在？位置 一般 良好 优秀 极好</div>
      </div>`;
  });

  test('字体反爬下标题仍从正文提取,不回退 <title> 技能标签', () => {
    const job = JTParser.parseJobFromDetailPage();
    expect(job.title).toBe('中医推拿按摩师');
    expect(job.title).not.toBe('针灸推拿');
  });

  test('字体反爬下 requirement/description 仍正确', () => {
    const job = JTParser.parseJobFromDetailPage();
    expect(job.requirement).toContain('手法较好');
    expect(job.requirement).not.toContain('薪资范围');
    expect(job.description).toContain('工作内容');
    expect(job.description.startsWith('一、工作内容')).toBe(true);
  });

  test('字体反爬下薪资/公司/地点仍正确', () => {
    const job = JTParser.parseJobFromDetailPage();
    expect(job.salaryRaw).toContain('5-8K');
    expect(job.salaryMin).toBe(5000);
    expect(job.salaryMax).toBe(8000);
    expect(job.company).toBe('长沙明眸建盟健康管理有限公司');
    expect(job.location).toBe('长沙');
  });
});
