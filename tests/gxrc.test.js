// ============================================================
// gxrc.test.js — 广西人才网(gxrc.com)提取回归测试
// 依据用户提供的真实诊断 JSON 重建 DOM,验证修复后提取正确:
//   标题/公司/薪资/描述/要求 全部命中,且"任职要求:康复士及以上证件"
//   (考证要求)被正确提取进 requirement,不再被公司简介/职位推荐污染。
//
// 通过 @jest-environment-options 把本文件 jsdom 的 URL 固定为 gxrc.com,
// 使 getSiteConfig() 能命中 gxrc.com 适配器(避免跨域 pushState 限制)。
// ============================================================
/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://www.gxrc.com/jobDetail/35b08de2-f5a9-482f-bbaa-85f1bfba4fdc"}
 */
describe('gxrc.com 提取', () => {
  const PAGE_URL = 'https://www.gxrc.com/jobDetail/35b08de2-f5a9-482f-bbaa-85f1bfba4fdc';
  const JOB_BODY = `职位描述 1. 负责语言障碍儿童、发育迟缓儿童、自闭症儿童能力评估； 2. 根据诊断结果、评估结果制定个性化的训练目标何计划，并进行康复治疗； 3. 熟练运用PT、OT、ST、言语及感统等训练方法完成康复治疗，严格遵守操作规程； 4. 观察训练对象的情况及治疗反应，做好各项记录； 5. 进行康复常识的宣传工作，介绍各项康复方法的治疗作用及注意事项，以使患者能理解、配合并主动参与康复治疗 6. 与家长保持良好沟通，为家庭训练提供正确的教育指导和支持 任职要求：康复士及以上证件 五险 节日福利 生日福利 包吃 包住 工作地点 示例中西医结合医院有限公司 示例市示例区示例医院示例大道123号安吉客运站斜对面 公交、驾车路线 200 米 © 2026 Baidu - GS(2025)4125号 - 甲测资字11111342 - 京ICP证030173号 - Data © 百度智图 其它要求 工作性质：全职 专业要求： 语言/程度： 职称要求：无 更新时间：2026-04-29 公司介绍 示例医院是国家门批准成立的一家以中医诊疗新技术为核心、中医治疗疾病为特色的二级中西医结合医院。示例医院诊疗环境温馨，医疗器械先进，医护队伍强大，为疾病的诊疗提供了优秀的条件。 联系方式 联系人：李小姐 联系电话：0771********查看 电子邮箱：9921************ 联系地址：示例市示例区示例中西医结合医院 职位推荐 康复医师 8-10K 示例城和医院 科主任/学科带头人（康复科） 20-30K 示例桂园康复医院有限公司 主治医师 10-12K 示例桂园康复医院有限公司 康复治疗师`;

  beforeAll(() => {
    // 确保 location 指向 gxrc.com(jsdom 默认 localhost;跨域 pushState 受限,
    // 故直接重定义 globalThis.location 为 URL 对象,使 getSiteConfig 命中 gxrc.com 适配器)
    try {
      Object.defineProperty(globalThis, 'location', {
        value: new URL(PAGE_URL),
        configurable: true,
        writable: true
      });
    } catch (e) { /* ignore */ }

    // jsdom 无布局,HTMLElement.innerText 在某些版本返回 '';parser 依赖 innerText,
    // 这里把它桥接为 textContent,使无头测试能忠实模拟浏览器提取行为。
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
      if (!desc || !desc.get || desc.get.toString().includes('layout')) {
        Object.defineProperty(HTMLElement.prototype, 'innerText', {
          get() { return this.textContent; },
          set(v) { this.textContent = v; },
          configurable: true
        });
      }
    } catch (e) { /* 已有可靠 innerText,跳过 */ }

    document.body.innerHTML = `
      <div class="page" id="page">
        <div class="job-detail-wrap">
          <div class="job-detail" id="jobDetail">
            <h1 class="job-name">儿科康复 3-4K</h1>
            <div class="meta">示例自治区/示例市/示例区|学历不限|经验不限|招聘2人 收藏职位 立即投递 聊一聊</div>
            <div class="job-body">${JOB_BODY}</div>
          </div>
        </div>
      </div>`;
  });

  test('应能识别为广西人才网并正确提取全部字段', () => {
    const job = JTParser.parseJobFromDetailPage();

    expect(job.site).toBe('广西人才网');
    expect(job.title).toBe('儿科康复');
    expect(job.company).toBe('示例中西医结合医院有限公司');
    // 薪资:"3-4K" 必须被提取(之前漏提成为空)
    expect(job.salaryRaw).toContain('3-4K');
    // 描述应为真实岗位职责,而非头部 meta 行
    expect(job.description).toContain('语言障碍儿童');
    expect(job.description).not.toContain('学历不限|经验不限');
    // 关键:考证要求"康复士及以上证件"必须进入 requirement,且不被公司简介/职位推荐污染
    expect(job.requirement).toContain('康复士及以上证件');
    expect(job.requirement).not.toContain('公司介绍');
    expect(job.requirement).not.toContain('职位推荐');
    expect(job.requirement).not.toContain('示例城和医院');
  });
});
