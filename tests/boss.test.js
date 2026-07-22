// ============================================================
// boss.test.js — BOSS直聘(zhipin.com)提取回归测试
// 依据用户提供的真实诊断 JSON 重建 DOM,验证修复后:
//   1) 标题来自 .job-banner 内的真实岗位名(中医推拿按摩师),
//      不再误识别为招聘者昵称"郭女士 刚刚活跃"(v1.5.11 修),
//      也不再回退到 <title> 组件垃圾文本"你在？位置"(v1.5.13 修)。
//   2) 薪资"5-8K·13薪"能正确提取。
//   3) requirement 不被"薪资详情"区块污染,而是从 JD 的"招聘要求"子标题拆分出真实要求。
// 关键结构:真实标题 .job-name 在 .job-banner(与 .job-detail 同级,不在容器内),
//   HR 昵称 .name(H2) 在 .job-detail 内;薪资 .salary 在 .job-detail 内。
// ============================================================
/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://www.zhipin.com/job_detail/5450eef70544a47403Z52t-0ElNT.html"}
 */
describe('zhipin.com 提取', () => {
  const PAGE_URL = 'https://www.zhipin.com/job_detail/5450eef70544a47403Z52t-0ElNT.html';
  // 岗位正文(取自诊断 rawContainerText,含"三、招聘要求"子标题,以及"四．待遇"边界)
  const JOB_DESC = `职位描述 康复理疗机构 推拿 接受无针灸/推拿相关经验 无销售性质
一、工作内容 1，熟悉中医按摩相关知识，认真执行各项理疗技术操作规程 2，利用中医推拿手法给客户提供颈肩腰腿痛的治疗和调理 3，主要的工作就是做中医推拿，正规的，给客户解决办公久坐久站的方面的疲劳以及相关症状 4、能够服务门店管理，相互配合做好客户服务工作。
二、招聘人员：中医推拿按摩师：男女不限！
三、招聘要求： 1、手法较好，面试需要试手法，需要根据手法而定。 2、手法欠佳者，其他方面可以，能吃苦耐劳，我们有自己的专业的培训中心，可以免费岗前培训后上岗，不收取任何费用，培训期间包吃包住。 3、年龄要求45周岁以下，请您悉知 4、不做足疗和spa 相关业务，主要是做推拿，正规纯粹，其他的勿扰。 5、公司没有产品推销，没有推销任务！主要是以手法为主，以踏实做技术为主。
四．待遇 1、包吃包住，有单独宿舍，空调热水器，洗衣机一应俱全。 2、保底4000至6000元，根据你的手法而定，手法好，保底就高，因能力大小而评定，因人而异，手法好，工资就高，手法差点，可以培训努力提升自我！`;

  beforeAll(() => {
    try {
      Object.defineProperty(globalThis, 'location', {
        value: new URL(PAGE_URL),
        configurable: true,
        writable: true
      });
    } catch (e) { /* ignore */ }

    // jsdom 无布局,innerText 桥接 textContent
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

    // jsdom 的 getBoundingClientRect 默认返回全 0,isReasonableContainer 会据此拒绝 .job-detail
    // 而回退到 document.body;真实浏览器有布局不会。这里 mock 一个非零矩形,使容器选择贴近真实。
    try {
      window.Element.prototype.getBoundingClientRect = function () {
        return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0 };
      };
    } catch (e) { /* skip */ }

    // 忠实重建:真实标题在 .job-banner(容器外),HR 昵称 .name 在 .job-detail 内
    document.body.innerHTML = `
      <div class="job-banner">
        <h1 class="job-name">中医推拿按摩师</h1>
        <span class="job-salary">5-8K·13薪</span>
      </div>
      <div class="job-detail">
        <h2 class="name">郭女士 刚刚活跃</h2>
        <div class="boss-info-attr">长沙明眸建盟健康管理 · 招聘经理</div>
        <div class="company-name">公司名称 长沙明眸建盟健康管理有限公司</div>
        <p class="salary">5-8K·13薪</p>
        <div class="company-location">长沙</div>
        <div class="job-sec-text">${JOB_DESC}</div>
        <div class="job-sec-text">薪资详情 薪资范围：4000-9000元/月 发薪日期：15日 提成方式：按单提成； 奖金补贴：餐补、加班费、绩效奖金、全勤奖、工龄奖、包吃、包住</div>
      </div>`;
  });

  test('标题应为真实岗位名,而非 HR 昵称或 Widget 垃圾文本', () => {
    const job = JTParser.parseJobFromDetailPage();

    expect(job.site).toBe('BOSS直聘');
    // 核心:标题不能是招聘者昵称
    expect(job.title).not.toBe('郭女士 刚刚活跃');
    // 核心:标题不能是 <title> 回退的组件垃圾文本
    expect(job.title).not.toBe('你在？位置');
    // 核心:标题应为真实岗位名
    expect(job.title).toBe('中医推拿按摩师');
  });

  test('薪资应正确提取(5-8K·13薪 → 5000~8000)', () => {
    const job = JTParser.parseJobFromDetailPage();
    expect(job.salaryRaw).toContain('5-8K');
    expect(job.salaryMin).toBe(5000);
    expect(job.salaryMax).toBe(8000);
  });

  test('requirement 不应被"薪资详情"污染,而应来自 JD 的"招聘要求"', () => {
    const job = JTParser.parseJobFromDetailPage();
    // 不含薪资详情段
    expect(job.requirement).not.toContain('薪资范围');
    expect(job.requirement).not.toContain('薪资详情');
    // 真实要求内容(来自"三、招聘要求")
    expect(job.requirement).toContain('手法较好');
    // description 不应包含被拆走的招聘要求段
    expect(job.description).toContain('工作内容');
    expect(job.description).not.toContain('薪资范围');
  });
});
