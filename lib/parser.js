// ============================================================
// parser.js — 岗位信息提取器
// 通用启发式解析 + 站点适配器,从当前页面 DOM 提取结构化岗位数据
// 关键:所有提取都限定在"详情容器"范围内,避免在列表页抓到第一个岗位
// ============================================================

const JTParser = (() => {

  // ==========================================================
  // Section 1: 站点配置与容器定位
  //   - getSiteConfig: 按 hostname 匹配站点配置
  //   - getDetailContainer: 定位岗位详情所在的 DOM 区域
  //   - isReasonableContainer / findJobContentContainer: 容器质量判断
  // ==========================================================

  // 站点配置缓存(按 hostname 缓存，避免每次遍历 Object.entries)
  let _siteConfigCache = null;
  let _siteConfigHost = '';

  // 获取当前站点配置
  function getSiteConfig() {
    const host = location.hostname.replace(/^www\./, '');
    if (host === _siteConfigHost && _siteConfigCache !== undefined) return _siteConfigCache;
    _siteConfigHost = host;
    for (const [domain, cfg] of Object.entries(JT_CONFIG.sites)) {
      if (host.includes(domain)) { _siteConfigCache = cfg; return cfg; }
    }
    _siteConfigCache = null;
    return null;
  }

  // ----------------------------------------------------------
  // 详情容器定位:确定当前展示的岗位详情所在的 DOM 区域
  // 这是修复"总是显示第一个"的关键——提取只在容器内进行
  // ----------------------------------------------------------
  function getDetailContainer() {
    const site = getSiteConfig();
    // 1. 站点配置的详情容器选择器
    const siteContainers = (site && site.detailContainer) || [];
    // 2. 通用详情容器选择器
    const genContainers = JT_CONFIG.genericDetailContainer || [];
    const candidates = [...siteContainers, ...genContainers];

    for (const sel of candidates) {
      try {
        // 可能有多个,取第一个"有实质内容"的
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (isReasonableContainer(el)) return el;
        }
      } catch (e) { /* 选择器无效,跳过 */ }
    }
    // 3. 兜底:整个 body(但此时提取质量会下降)
    return document.body;
  }

  // v1.5.4:在 body 中搜索真正包含"职位正文"的区块
  //   背景:站点 detailContainer 配置可能命中"公司侧栏/头部"而非职位正文
  //        (如康强 kq36.com 的 .job-detail 实际是公司信息盒,职位描述在另一个区块)
  //   做法:扫描 body 中所有文本节点,找出含职位描述/任职要求关键词、且不含导航/工商信息的
  //        最大区块,作为实际提取作用域。不依赖任何站点特有 class,通用性强。
  function findJobContentContainer() {
    const jobKw = /职位描述|岗位描述|工作内容|岗位职责|任职要求|岗位要求|招聘要求|任职资格|具体要求|我们需要你|你需要|岗位说明|职位说明|岗位详情|职位详情|职位信息|招聘信息/i;
    const navKw = /招聘职位|联系我们|单位简介|首页|登录|注册|工商信息|法定代表人|注册资金|成立日期|企业类型|本单位职位/i;
    let best = null, bestLen = 0;
    const nodes = document.body.querySelectorAll('div, section, article, td, li, dd, p, tr');
    for (const el of nodes) {
      const t = getText(el); // v1.5.47:改用 getText 应对 BOSS 字体反爬(innerText 空时回退 textContent)
      if (t.length < 80) continue;          // 太短不可能是完整职位区块
      if (!jobKw.test(t)) continue;          // 必须含职位正文关键词
      if (navKw.test(t)) continue;           // 排除导航/公司信息盒
      if (t.length > bestLen) { bestLen = t.length; best = el; }
    }
    return best;
  }

  // v1.5.4:判断 requirement 是否为"垃圾"(表格表头/导航栏/过短无意义文本)
  //   典型垃圾:"类别 城市 经验 学历 部门 薪酬 人事"(空格分隔的短中文词)
  function isJunkRequirement(text) {
    if (!text) return false;                 // 空不是垃圾(只是空,交由清空逻辑处理)
    const t = text.trim();
    if (t.length === 0) return false;
    // 表格表头:空格分隔的多个短中文词(2-4字)
    if (/^[\u4e00-\u9fa5]{1,4}(\s+[\u4e00-\u9fa5]{1,4}){2,}$/.test(t)) return true;
    // 过短且无句子结构(真实任职要求通常较长)
    // v1.5.10:但含证书/资格/资质等关键词的短要求(如"康复士及以上证件")仍是有效任职要求,不可误判为垃圾
    if (t.length < 12 && !/证书|资格|资质|证件|及以上|经验|年限|学历|大专|本科|硕士|熟练|优先|具备|持有|要求|条件/i.test(t)) return true;
    // 含导航/公司信息词
    if (/招聘职位|联系我们|单位简介|首页|登录|注册|工商信息|法定代表人|注册资金|成立日期/.test(t)) return true;
    return false;
  }

  // 判断一个容器是否"合理":可见、有足够文本、含薪资或描述特征
  // ⚠️ v1.4.7 增强:区分"纯头部"(仅标题/薪资/标签)和"含正文"(职位描述/任职要求等)
  //    纯头部容器(如 .job-banner)通过基础检查但不含岗位正文,会导致 description/requirement 全空
  function isReasonableContainer(el) {
    if (!el) return false;
    // 可见性检查
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // 文本量
    const text = getText(el); // v1.5.47:改用 getText 应对 BOSS 字体反爬(innerText 空时回退 textContent)
    if (text.trim().length < 30) return false;
    // 含岗位特征(薪资/描述/要求之一)
    if (/[\d]+\s*[kK千万元]?\s*[-~至到]/.test(text)) return true;
    if (/职责|要求|描述|岗位|任职|responsib|requirement/i.test(text)) return true;

    // v1.4.7: 含正文 section 标题 → 一定是好容器(即使没匹配到上面宽泛关键词)
    const bodySectionKw = /职位描述|任职要求|工作内容|岗位要求|招聘要求|资格条件|具体要求|我们需要你|你需要/i;
    if (bodySectionKw.test(text)) return true;

    // 文本量足够大(>200字)且含数字 → 可能是完整详情页
    if (text.trim().length > 200 && /\d/.test(text)) return true;

    return false;
  }

  // ==========================================================
  // Section 2: 选择器工具与文本清理
  //   - pickSelector / getSelectors: 按选择器列表依次尝试
  //   - cleanText: 清理空白字符
  // ==========================================================

  // ----------------------------------------------------------
  // 在指定作用域内按选择器列表依次尝试,取第一个有文本的
  // scope 默认为详情容器,避免抓到列表第一个
  // ----------------------------------------------------------
  function pickSelector(selectors, scope) {
    if (!selectors) return null;
    const root = scope || getDetailContainer();
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el && getText(el)) return el;
      } catch (e) { /* 选择器可能无效,跳过 */ }
    }
    // 作用域内没找到,且作用域不是 body,再退回全页面找(但排除列表卡片,避免抓到第一个)
    if (root !== document.body) {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (!el || !getText(el)) continue;
          // 排除已知列表卡片内的元素(避免回退时抓到列表第一个)
          const inCard = el.closest('[class*="job-card"], [class*="job-item"], [class*="list-item"]');
          if (inCard && inCard !== el) continue;
          return el;
        } catch (e) { /* skip */ }
      }
    }
    return null;
  }

  // 合并站点选择器和通用选择器
  function getSelectors(field) {
    const site = getSiteConfig();
    const siteSels = (site && site.selectors && site.selectors[field]) || [];
    const genSels = JT_CONFIG.genericSelectors[field] || [];
    return [...siteSels, ...genSels];
  }

  // ==========================================================
  // Section 3: 字段提取
  //   - extractTitle / extractCompany / extractSalary / extractLocation
  //   - extractDescription / extractRequirement
  //   - parseSalary: 薪资字符串解析(纯函数,无 DOM 依赖)
  //   - extractCompanyByText / extractLocationByText: 启发式文本提取
  // ==========================================================

  // 清理文本
  function cleanText(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').replace(/[\u00a0]+/g, ' ').trim();
  }

  // v1.5.13: 取元素文本。优先 innerText(布局感知),
  //   当 innerText 为空时回退 textContent —— 应对 BOSS 直聘字体混淆反爬
  //   (.job-name/.job-salary 等元素的可见文本只存在于 textContent,innerText 为空)
  function getText(el) {
    if (!el) return '';
    const t = (el.innerText || '').trim();
    if (t) return t;
    const tc = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return tc;
  }

  // v1.5.11: 拒绝把 HR/招聘者昵称误当岗位标题
  //   BOSS直聘把招聘者昵称写在 .name / .boss-name 元素里,形如"郭女士 刚刚活跃"(姓氏+女士/先生 + 活跃状态)。
  //   这类文本明显不是岗位名,一旦被标题选择器回退命中会污染 AI 分析(用户实测:标题被识别成"郭女士 刚刚活跃")。
  function isBossNameLike(text) {
    if (!text) return false;
    if (/(女士|先生|同学)\s*(刚刚|今日|现在)?\s*(活跃|在线)/.test(text)) return true;
    if (/(刚刚|今日|现在)\s*(活跃|在线)\s*$/.test(text)) return true;
    return false;
  }

  // v1.5.13: 拒绝把"竞争力分析"等 Widget 文本 / 页面杂项当标题
  //   实测 BOSS 直聘标题选择器全部失效时,pickSelector 会回退到 <title> 元素,
  //   而部分页面 <title> 动态为"你在？位置"之类组件文本,污染 AI 分析。
  function isWidgetNoise(text) {
    if (!text) return false;
    if (/你在|位置|竞争力|排名|综合|认证|实名|活跃|在线|刚刚/.test(text)) return true;
    return false;
  }

  // v1.5.14:BOSS 直聘"标题在正文"的 A/B 布局兜底
  //   部分 BOSS 页面没有 .job-banner / .job-name(标题不在头部独立区),
  //   真实岗位名只出现在正文(如"二、招聘人员：中医推拿按摩师：男女不限！")
  //   或某个 h1/h2/h3 里。此时不能回退到 <title>(常为"针灸推拿"之类的技能标签),
  //   而应从正文提取真实岗位名。
  function extractBossTitleFromBody() {
    // v1.5.15: 必须用 getText(document.body) 而非 document.body.innerText 直读。
    //   BOSS 直聘字体反爬会让 document.body.innerText 在真实浏览器里为空(但 textContent 有真实字符),
    //   直接读 innerText 会拿到 '' → 标题回退到 <title> 技能标签"针灸推拿"。
    //   getText 已带 innerText 空则回退 textContent 的兜底,与 company/salary/description 一致。
    const bodyText = document.body ? getText(document.body) : '';
    if (!bodyText) return '';
    // 策略A:正文锚点"招聘人员：X" / "招聘岗位：X" / "职位名称：X" 等
    const m = bodyText.match(
      /(?:招聘人员|招聘岗位|招聘职位|职位名称|岗位名称|招聘工种)[：:]\s*([\u4e00-\u9fa5A-Za-z·（）()]{2,20}?)(?:[:：]|\s*男女|\s*（|\s*\(|\s*$|\n)/
    );
    if (m && m[1]) {
      const cand = m[1].trim();
      if (cand.length >= 2 && cand.length <= 20 && !isBossNameLike(cand) && !isWidgetNoise(cand)) {
        return cand;
      }
    }
    // 策略B:页面里最像岗位名的 h1/h2/h3(h1 优先,避免抓到 HR 昵称/Widget)
    for (const tag of ['h1', 'h2', 'h3']) {
      const els = document.querySelectorAll(tag);
      for (const el of els) {
        const txt = getText(el).split(/[-_|·\s]+/)[0].trim();
        if (txt && txt.length >= 2 && txt.length <= 24 &&
            /师|员|工|经理|顾问|助理|专员|工程师|推拿|按摩|康复|护理|医生|技师|导购|客服|销售|设计|运营|会计|出纳|文员/.test(txt) &&
            !isBossNameLike(txt) && !isWidgetNoise(txt) && !/[\d]\s*[kK万千]/.test(txt)) {
          return txt;
        }
      }
    }
    return '';
  }

  // 提取标题(限定作用域)
  function extractTitle(scope) {
    const site = getSiteConfig();
    // v1.5.13: BOSS 直聘真实标题在 .job-banner(与 .job-detail 同级的头部区),
    //   且常被字体混淆(innerText 空、textContent 才有值),选择器难以命中。
    //   优先直接从 .job-banner 提取,避免回退到 <title> 组件垃圾文本。
    if (site && site.name === 'BOSS直聘') {
      const banner = document.querySelector('.job-banner') ||
        document.querySelector('[class*="job-banner"]') ||
        document.querySelector('[class*="job-header"]');
      let t = '';
      if (banner) {
        const tEl = banner.querySelector('.job-name') ||
          banner.querySelector('h1') ||
          banner.querySelector('[class*="job-name"]') ||
          banner.querySelector('[class*="job-title"]') ||
          banner.querySelector('h2:not(.name)');
        t = tEl ? getText(tEl) : '';
        if (!t) {
          // banner 内第一行像标题的文本(排除薪资行 / HR 昵称 / Widget 文本)
          const lines = getText(banner).split(/[\n|]/).map(s => s.trim()).filter(Boolean);
          for (const ln of lines) {
            if (/[\d]\s*[kK万千]/.test(ln)) continue;   // 薪资行
            if (isBossNameLike(ln)) continue;            // HR 昵称
            if (isWidgetNoise(ln)) continue;             // Widget 文本
            if (ln.length >= 2 && ln.length <= 30) { t = ln; break; }
          }
        }
      }
      // v1.5.14:无 .job-banner(部分 A/B 布局)或 banner 内取不到时,
      //   从正文兜底提取真实岗位名(避免回退到 <title> 的技能标签"针灸推拿")
      if (!t || isBossNameLike(t) || isWidgetNoise(t)) {
        const bt = extractBossTitleFromBody();
        if (bt) t = bt;
      }
      if (t && !isBossNameLike(t) && !isWidgetNoise(t)) {
        return t.split(/[-_|·]\s*/)[0].trim();
      }
    }
    // 通用路径:选择器 + 全页回退
    const el = pickSelector(getSelectors('title'), scope);
    let title = el ? getText(el) : '';
    if (isBossNameLike(title)) title = '';   // v1.5.11: 拒绝 HR 昵称被当标题
    if (isWidgetNoise(title)) title = '';    // v1.5.13: 拒绝 Widget 组件文本
    // 若标题含站点名/后缀则截断
    title = title.split(/[-_|·]\s*/)[0].trim();
    return title;
  }

  // v1.5.6: 校验提取到的片段是否像公司名(排除"查看企业/联系我们/立即投递"等 UI 短语)
  // v1.5.7: 加强守卫 —— 拒绝页脚广告语("备受大学生欢迎…")与 JD 正文里的关联机构名
  //   (如"全国青年中医学研究院"只是职位描述开头提到的机构,并非招聘主体)
  function isLikelyCompanyName(name) {
    if (!name || name.length < 2 || name.length > 30) return false;
    // 以动作动词/标签开头 → 是 UI/导航短语而非公司名
    if (/^(查看|了解|关于|联系|点击|进入|更多|返回|马上|立即|去|我的|企业简介|公司简介|公司名称|企业名称)/.test(name)) return false;
    // 含 UI 动作词 / 广告语 / 平台名 / JD 噪声 → 不是公司名
    if (/招聘|投递|收藏|分享|举报|登录|注册|客服|首页|职位|详情|简介|欢迎|平台|成长|求职|大学生|备受|中医药全产业链|全国青年|智联|网版权|针对|企业或|单位/.test(name)) return false;
    return true;
  }

  // v1.5.5: 智联校园版等无稳定公司选择器的站点,从正文文本启发式提取公司名
  // v1.5.7: 强/弱后缀双通道(强=有限公司/集团/公司/企业;弱=研究院/大学…),锚点优先。
  // v1.5.8: 重写为"多位置候选 + 加权评分"模型(用户建议),彻底解决单一正则顺序误抓:
  //   - 不再"第一个命中就返回",而是从多个位置收集候选,按 位置权威度 + 后缀强度 + JD/页脚降权 打分取最高。
  //   - 彻底剔除"企业"后缀(它是 JD 噪声源,会误抓"针对的是企业")。
  //   - 锚点"公司简介/所属行业/查看企业详情"区块权重最高(权威用工主体位置)。
  //   - 全页扫描对所有 有限公司/集团/公司 片段打分,落在 JD 区块内的候选大幅降权。
  function extractCompanyByText(scope) {
    const text = scope ? getText(scope) : getText(document.body); // v1.5.47:改用 getText 应对字体反爬
    if (!text) return '';

    // 候选集合:{name, score}
    const candidates = [];
    // 入池:通过守卫 + 后缀强度加权
    const add = (name, base) => {
      name = (name || '').trim();
      if (!name || !isLikelyCompanyName(name)) return;
      let suffix = 0;
      if (/有限公司|有限责任公司|股份公司/.test(name)) suffix = 5;
      else if (/集团$/.test(name)) suffix = 4;
      else if (/公司$/.test(name)) suffix = 3;
      // 弱后缀(研究院/大学/学校/中心…)此处不入池,避免 JD 关联机构名
      candidates.push({ name, score: base + suffix });
    };

    // 只认真实用工主体后缀(不含"企业",避免"针对的是企业"类 JD 噪声)
    const RE = /([\u4e00-\u9fa5]{2,30}(?:有限公司|有限责任公司|股份公司|集团|公司))/g;

    // 位置1(权威,权重最高):"公司简介/所属行业/查看企业详情/企业名称/公司名称"锚点后首个公司名
    // v1.5.10:站点公司名紧跟"工作地点"标签后(如"工作地点 示例医院有限公司"),纳入锚点
    const anchors = ['公司简介', '所属行业', '查看企业详情', '企业名称', '公司名称', '工作地点'];
    for (const a of anchors) {
      const idx = text.indexOf(a);
      if (idx === -1) continue;
      const tail = text.substring(idx + a.length, idx + a.length + 200);
      RE.lastIndex = 0;
      const m = RE.exec(tail);
      if (m) { add(m[1], 12); break; }  // 锚点区块命中即采用,不继续其它锚点
    }

    // 位置2(中):全页扫描所有 有限公司/集团/公司 片段,按是否落在 JD 区块内降权
    RE.lastIndex = 0;
    let mm;
    while ((mm = RE.exec(text)) !== null) {
      const frag = mm[1];
      const before = text.substring(Math.max(0, mm.index - 60), mm.index);
      const inJD = /工作职责|任职要求|职位描述|岗位要求|福利待遇/.test(before);
      add(frag, inJD ? 1 : 5);
    }

    if (!candidates.length) return '';
    candidates.sort((x, y) => y.score - x.score);
    return candidates[0].name;
  }

  // v1.5.5: 智联校园版等无稳定地点选择器的站点,从正文文本启发式提取地点
  //   优先匹配信息行"东莞·塘厦镇经验不限…"(地点后紧跟 经验/学历/全职 等),
  //   兜底匹配"工作地点 X"。扫描整个 body(地点通常在头部,不在职位详情区块内)
  function extractLocationByText(scope) {
    const text = scope ? getText(scope) : getText(document.body); // v1.5.47:改用 getText 应对字体反爬
    if (!text) return '';
    // v1.5.10:广西人才网等采用"省/市/区"斜杠格式(如"示例自治区/示例市/示例区")
    const m0 = text.match(/([\u4e00-\u9fa5]{2,8}(?:省|自治区))\s*\/\s*([\u4e00-\u9fa5]{2,8}市)\s*\/\s*([\u4e00-\u9fa5]{2,10}(?:区|县|市|镇))/);
    if (m0) return (m0[2] + m0[3]).trim();   // 返回"示例市示例区"
    const m = text.match(/([\u4e00-\u9fa5·]{2,15}(?:镇|区|市|县|街道|开发区|新城|新区))\s*(?:经验|学历|全职|兼职|招\d+人)/);
    if (m) return m[1].trim();
    const m2 = text.match(/工作地点[:：\s]*([\u4e00-\u9fa5·]{2,15}(?:镇|区|市|县|街道|开发区))/);
    if (m2) return m2[1].trim();
    return '';
  }

  // v1.5.5: 单区块内按【工作内容】/【任职要求】/【薪资待遇】等标题拆分
  //   用于智联校园版等"整段职位详情放在一个区块里"的页面,避免整块当作 description
  //   或把尾部"公司简介/VIP 促销/AI 简历"塞进 requirement
  // v1.5.6: 兼容冒号写法(工作职责：/任职要求：/福利待遇：)与方括号写法,切分点统一取标题【起始】位置
  function splitByBracketSections(scope, cfg) {
    const text = cleanText(getText(scope)); // v1.5.47:改用 getText 应对字体反爬
    if (!text || text.length < 20) return null;
    const dM = cfg.descHeader ? text.match(cfg.descHeader) : null;
    const rM = cfg.reqHeader ? text.match(cfg.reqHeader) : null;
    const sM = cfg.salaryHeader ? text.match(cfg.salaryHeader) : null;
    if (!dM && !rM) return null;   // 无任何标题 → 交给其他策略

    const dStart = dM ? dM.index + dM[0].length : -1;
    const rStart = rM ? rM.index : -1;        // 切在标题【起始】,描述/要求都不含标题本身
    const sStart = sM ? sM.index : -1;
    // v1.5.10:要求结束边界(可选)。优先于 salaryHeader 作为 requirement 终点,
    //   用于"要求后紧跟福利/工作地点/公司介绍"的页面(如广西人才网),避免整段吞进 requirement。
    const rEM = cfg.reqEndHeader ? text.match(cfg.reqEndHeader) : null;
    const rEStart = rEM ? rEM.index : -1;

    let description = '';
    let requirement = '';

    if (dM) {
      const end = rM ? rStart : (sM ? sStart : text.length);
      description = cleanText(text.substring(dStart, end));
    }
    if (rM) {
      // requirement 终点:reqEndHeader(须在 rStart 之后) > salaryHeader > 文本末尾
      const end = (rEStart !== -1 && rEStart > rStart) ? rEStart : (sM ? sStart : text.length);
      requirement = cleanText(text.substring(rStart, end));
    }

    // 去掉拆分残留:描述去掉前导标题/方括号;要求去掉其标题(如 "任职要求：")
    description = description.replace(/^[【\]】\s:：\-]+/, '').trim();
    if (rM) requirement = requirement.replace(rM[0], '').replace(/^[【\]】\s:：\-]+/, '').trim();
    return { description, requirement };
  }

  // 公司名是否已携带真实用工主体后缀(有限公司/集团/医院/学校等)
  const REAL_COMPANY_SUFFIX = /(?:有限公司|有限责任公司|股份公司|集团|医院|诊所|卫生院|学校|大学|学院|研究院|研究中心|协会|基金会)$/;

  // 提取公司名(限定作用域)
  // 支持 BOSS直聘的 "公司名 · 职位" 格式自动分割
  function extractCompany(scope) {
    const site = getSiteConfig();
    // v1.5.6: 校园版等无稳定公司选择器的站点,优先用文本启发式
    //   站点选择器(尤其通用 [class*="company"])常误命中"查看企业"按钮等 UI 元素,得到假公司名。
    //   文本启发式未命中时直接返回空,不回退到不可靠选择器。
    if (site && site.companyByText) {
      const byText = extractCompanyByText(document.body);
      if (byText) return byText;
      return '';
    }
    const el = pickSelector(getSelectors('company'), scope);
    if (!el) return '';
    let company = cleanText(getText(el)); // v1.5.47:改用 getText 应对字体反爬
    // 站点配置:分割公司名(如 BOSS直聘 .boss-info-attr 返回 "博发科技 · 人事")
    if (site && site.companySplit && company.includes(site.companySplit)) {
      const parts = company.split(site.companySplit);
      company = parts[0].trim();
    }

    // ⚠️ v1.5.4:剔除常见标签前缀(站点常把"公司名称:""单位名称 "等标签混进文本)
    //   例:"公司名称 拉萨恒大医院有限公司" → "拉萨恒大医院有限公司"
    company = company
      .replace(/^(公司名称|单位名称|企业名称|公司|单位|企业)[名称]?[:：\s]+/, '')
      .replace(/^名称[:：\s]+/, '')
      .trim();

    // ⚠️ 导航文本过滤:选择器匹配到导航栏/Tab栏元素时,innerText 是菜单项而非公司名
    //   常见误匹配: "单位简介 招聘职位(x) 联系我们" / "首页 登录 注册" 等
    const navPatterns = [
      /招聘职位|联系我们|单位简介|首页|登录|注册|加入收藏|意见反馈|网站地图|帮助中心/,
      /^.{0,5}(简介|职位|联系|首页|登录|注册|更多).{0,5}$/,
      /^\S+\s*\(\d+\)\s*\S+/,  // "招聘职位(2) 联系我们"
    ];
    const looksLikeNav = navPatterns.some(p => p.test(company));
    // 公司名长度异常长也可疑(正常公司名 < 30 字,导航栏往往更长)
    const tooLong = company.length > 30;
    if (looksLikeNav || tooLong) {
      return '';  // 返回空让调用方知道此值不可靠
    }

    // v1.5.56:BOSS直聘等站点常把截断品牌名(如"广西盛瑶健康")作为显示名,
    // 而工商信息卡片里有完整注册名("广西盛瑶健康产业有限公司")。
    // 如果选择器结果缺真实后缀,则回退到全文文本启发式,优先取"公司名称"锚点后的完整名。
    if (company && site && site.name === 'BOSS直聘' && !REAL_COMPANY_SUFFIX.test(company)) {
      const byText = extractCompanyByText(document.body);
      if (byText && byText.includes(company.replace(/[\s·]/g, '')) && REAL_COMPANY_SUFFIX.test(byText)) {
        return byText;
      }
    }

    return company;
  }

  // 提取薪资并解析为数值(限定作用域)
  // BOSS直聘等特殊站点薪资被字体混淆/SVG渲染隐藏,innerText 为空,需做兜底处理
  function extractSalary(scope) {
    const el = pickSelector(getSelectors('salary'), scope);
    let raw = el ? cleanText(getText(el)) : '';

    // 如果 raw 非空但不是合法薪资格式(如只有"元"或乱码),也视为空
    if (raw && !JT_CONFIG.salaryRegex.test(raw)) {
      // 可能只是单位,不作为薪资
      raw = '';
    }

    // 兜底1:innerText 为空时,在包含薪资关键词的上下文中用正则提取薪资
    if (!raw && scope) {
      raw = extractSalaryByContext(scope);
    }

    // 兜底2:从岗位描述中提取薪资(同样需要上下文验证)
    if (!raw) {
      const desc = extractDescription(scope);
      if (desc) {
        raw = extractSalaryByContext({ innerText: desc });
      }
    }

    // 兜底3:从标题文本提取薪资(部分站点如智联校园版薪资嵌在标题 "康复理疗师 7000-9000元")
    if (!raw) {
      const titleEl = pickSelector(getSelectors('title'), document.body);
      if (titleEl) {
        const salFromTitle = extractSalaryByContext({ innerText: getText(titleEl) }); // v1.5.47:改用 getText 应对字体反爬
        if (salFromTitle) raw = salFromTitle;
      }
    }

    // 兜底4(v1.5.8):扫描头部区块。智联校园版薪资"7000-9000元"常在 .app__main 顶部
    //   (与标题同行),既不在 job-info__desc 内,本页 h1 选择器又失效 → 前序兜底全空。
    //   取 .app__main (无则 body) 的前 500 字(头部区域)做上下文提取,安全避开正文数字。
    if (!raw) {
      let header = null;
      try { header = document.querySelector('.app__main'); } catch (e) { header = null; }
      const headerText = header ? getText(header) : getText(document.body); // v1.5.47:改用 getText 应对字体反爬
      if (headerText) {
        const salFromHeader = extractSalaryByContext({ innerText: headerText.substring(0, 500) });
        if (salFromHeader) raw = salFromHeader;
      }
    }

    // 如果仍然为空,标记为"薪资面议"
    if (!raw) {
      raw = '薪资面议';
    }

    const parsed = parseSalary(raw);
    return { raw, ...parsed };
  }

  // 在文本中结合薪资关键词提取薪资,避免误匹配(如"1-3年经验"/"2024-2026 年")
  function extractSalaryByContext(scope) {
    const text = scope ? cleanText(getText(scope)) : ''; // v1.5.47:改用 getText 应对字体反爬
    if (!text) return '';
    const keywords = JT_CONFIG.salaryKeywords || [];
    // 先找薪资关键词的位置,在其附近 30 字符内搜索薪资正则
    for (const kw of keywords) {
      const idx = text.indexOf(kw);
      if (idx !== -1) {
        // 在关键词前后 40 字符内搜索
        const start = Math.max(0, idx - 10);
        const end = Math.min(text.length, idx + kw.length + 30);
        const context = text.substring(start, end);
        const m = context.match(JT_CONFIG.salaryRegex);
        if (m) {
          const n1 = parseFloat(m[1]);
          const n2 = parseFloat(m[2]);
          const after = context.substring(m.index + m[0].length, m.index + m[0].length + 3);
          // 拒绝年份区间(如 "2024-2026 年"):两个数字都在年份范围且紧跟"年"
          if (n1 >= 1900 && n2 <= 2100 && (n2 - n1) <= 100 && /^\s*年/.test(after)) continue;
          if (/[kK千万元]|元|月|年/.test(m[0] + after)) return m[0];
          if (n1 >= 1000 && n2 >= n1 && n2 <= 200000) return m[0];
        }
      }
    }
    // 如果没找到关键词上下文,但正则能匹配,判断匹配结果是否像薪资
    const m2 = text.match(JT_CONFIG.salaryRegex);
    if (m2) {
      const matched = m2[0];
      const n1 = parseFloat(m2[1]);
      const n2 = parseFloat(m2[2]);
      const after = text.substring(m2.index + matched.length, m2.index + matched.length + 3);
      // 拒绝年份区间(如 "2024-2026 年")
      if (n1 >= 1900 && n2 <= 2100 && (n2 - n1) <= 100 && /^\s*年/.test(after)) return '';
      // 含单位(元/月/年/k/千/万) → 直接接受
      if (/[kK千万元]|元|月|年/.test(matched + after)) return matched;
      // 无单位但数字像薪资(如 "7000-9000") → 也接受
      if (n1 >= 1000 && n2 >= n1 && n2 <= 200000) return matched;
    }
    return '';
  }

  // 解析薪资字符串为 {min, max, unit}
  function parseSalary(str) {
    if (!str) return { min: 0, max: 0, unit: '' };
    const m = str.match(JT_CONFIG.salaryRegex);
    if (!m) return { min: 0, max: 0, unit: str };

    let min = parseFloat(m[1]);
    let max = parseFloat(m[2]);

    // 判断单位:k/K/千 → 乘1000
    const lower = str.toLowerCase();
    if (lower.includes('k') || lower.includes('千')) {
      min *= 1000;
      max *= 1000;
    }
    // 万 → 乘10000
    if (str.includes('万')) {
      min *= 10000;
      max *= 10000;
    }

    // 年薪转月薪
    if (/年|year|annual/i.test(str)) {
      min = Math.round(min / 12);
      max = Math.round(max / 12);
    }

    return { min: Math.round(min), max: Math.round(max), unit: str };
  }

  // 提取地点(限定作用域)
  function extractLocation(scope) {
    const site = getSiteConfig();
    // v1.5.6: 校园版等无稳定地点选择器的站点,优先用文本启发式(站点选择器常误命中"工作地点"地址如"华商大厦19楼")
    if (site && site.locationByText) {
      const byText = extractLocationByText(document.body);
      if (byText) return byText;
      return '';
    }
    const el = pickSelector(getSelectors('location'), scope);
    if (!el) return '';
    return cleanText(getText(el)); // v1.5.47:改用 getText 应对字体反爬
  }

  // 提取岗位描述全文(限定作用域)
  function extractDescription(scope) {
    const el = pickSelector(getSelectors('description'), scope);
    if (el) return cleanText(getText(el)); // v1.5.47:改用 getText 应对字体反爬
    // 兜底:容器内前 N 字(统一配置)
    const root = scope || getDetailContainer();
    return cleanText(getText(root)).substring(0, JT_CONFIG.limits.JOB_DESC_MAX); // v1.5.47:改用 getText 应对字体反爬
  }

  // 提取要求(限定作用域)
  function extractRequirement(scope) {
    const el = pickSelector(getSelectors('requirement'), scope);
    return el ? cleanText(getText(el)) : ''; // v1.5.47:改用 getText 应对字体反爬
  }

  // ----------------------------------------------------------
  // 多区块标题匹配提取(解决 BOSS直聘 等站点
  //   多个 .job-sec-text 区块导致 description/requirement 碰撞)
  //
  // 三层策略:
  //   1) DOM 兄弟前驱找标题元素(如 .job-sec-header)
  //   2) 父元素内找 header/title 类子元素
  //   3) 内容特征启发式(根据文本自身关键词判断类型)
  // ----------------------------------------------------------
  function extractBySectionHeader(scope, field) {
    const site = getSiteConfig();
    if (!site || !site.selectors || !site.selectors.sectionBasedExtraction) return '';

    const root = scope || getDetailContainer();
    const contentSel = (site.selectors.description && site.selectors.description[0]) || '.job-sec-text';

    // 找容器内所有内容区块元素
    let blocks;
    try {
      blocks = root.querySelectorAll(contentSel);
    } catch (e) { return ''; }
    if (!blocks || blocks.length === 0) return '';

    const descKw = site.selectors.descHeaders || ['岗位', '职责'];
    const reqKw = site.selectors.reqHeaders || ['任职', '要求'];

    // 要求区块内容特征词(策略3用)
    const reqContentPatterns = /证书|资格|经验|年限|学历|大专|本科|及以上|熟练|优先|具备|持有/i;

    const results = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const text = cleanText(getText(block)); // v1.5.46:改用 getText 应对 BOSS 字体反爬(innerText 空时回退 textContent)
      if (!text) continue;

      // 向上查找最近的标题元素(兄弟前驱 / 父级 header)
      let headerText = '';

      // 策略1:前一个兄弟元素(通常是 .job-sec-header)
      let prev = block.previousElementSibling;
      let depth = 0;
      while (prev && !headerText && depth < 5) {
        const t = cleanText(getText(prev)); // v1.5.47:改用 getText 应对字体反爬(原 innerText||textContent 兜底已含,统一用 getText)
        if (t && (t.includes('职责') || t.includes('要求') || t.includes('岗位') || t.includes('任职') || t.includes('描述') || t.includes('资格') || t.includes('条件'))) {
          headerText = t; break;
        }
        prev = prev.previousElementSibling;
        depth++;
      }

      // 策略2:父元素的标题子元素
      if (!headerText) {
        const parent = block.parentElement;
        if (parent) {
          const headerEl = parent.querySelector('[class*="header"], [class*="title"], .job-sec-header, h2, h3, h4, strong');
          if (headerEl) headerText = cleanText(getText(headerEl)); // v1.5.47:改用 getText 应对字体反爬
        }
      }

      // 策略3:向上遍历祖先找含标题关键词的元素
      if (!headerText) {
        let ancestor = block.parentElement;
        let aDepth = 0;
        while (ancestor && ancestor !== root && aDepth < 4) {
          const children = ancestor.children;
          for (let c = 0; c < children.length; c++) {
            const ch = children[c];
            if (ch === block || block.contains(ch)) continue;
            const t = cleanText(getText(ch)); // v1.5.47:改用 getText 应对字体反爬(原 innerText||textContent 兜底已含,统一用 getText)
            if (t && (t.includes('职责') || t.includes('要求') || t.includes('岗位') || t.includes('任职') || t.includes('描述') || t.includes('资格') || t.includes('条件'))) {
              headerText = t; break;
            }
          }
          if (headerText) break;
          ancestor = ancestor.parentElement;
          aDepth++;
        }
      }

      // 策略3补充:如果仍无标题,用内容特征推断类型
      const isReqByContent = !headerText && reqContentPatterns.test(text);

      results.push({ text, header: headerText, index: i, isReqByContent });
    }

    // 按标题关键词分类
    if (field === 'description') {
      // 先找含 descKw 标题的区块(排除"薪资/待遇/福利"伪描述区块)
      const matched = results.find(r => descKw.some(k => r.header.includes(k)) &&
        !/薪资|待遇|福利|薪/.test(r.header + '|' + r.text));
      if (matched) return matched.text;
      // v1.5.13:排除"薪资/待遇/福利"区块(它们不是职位描述),取剩余中最长者(通常是完整 JD)。
      //   注意:主 JD 区块若含"经验/学历"等词会被误标为要求型,故不依赖 isReqByContent,
      //   而是直接排除薪资类区块后取最长块,避免把"薪资详情"当成描述。
      const cand = results.filter(r => !/薪资|待遇|福利|薪/.test(r.header + '|' + r.text));
      if (cand.length) return cand.sort((a, b) => b.text.length - a.text.length)[0].text;
      return results.length ? results[0].text : '';
    }

    if (field === 'requirement') {
      // 先找含 reqKw 标题的区块(排除"薪资/待遇/福利"伪要求区块)
      const matched = results.find(r => reqKw.some(k => r.header.includes(k)) &&
        !/薪资|待遇|福利|发薪|奖金|补贴|薪/.test(r.header + '|' + r.text));
      if (matched) return matched.text;
      // 再找被内容特征标记为要求型、且确属任职要求的区块(排除薪资/待遇)
      const byContent = results.find(r => r.isReqByContent &&
        !/薪资|待遇|福利|发薪|奖金|补贴|薪/.test(r.header + '|' + r.text));
      if (byContent) return byContent.text;
      // v1.5.13:不再盲目取"第二个"区块(会误抓"薪资详情"段),
      //   找不到真实任职要求时返回空,交由 buildJobFromContainer 的拆分兜底处理
      return '';
    }

    return '';
  }

  // ----------------------------------------------------------
  // 全文关键词拆分兜底(当 DOM 选择器全部失败时使用)
  //
  // BOSS 直聘等站点经常修改 DOM 类名,导致 .job-sec-text 等选择器
  // 完全匹配不到。此时从容器 innerText 中按已知的"岗位职责/任职要求"
  // 等 section 标题关键词拆分文本,确保不丢失数据。
  // ----------------------------------------------------------
  function splitContainerTextByKeywords(scope) {
    const root = scope || getDetailContainer();
    if (!root) return null;

    const fullText = cleanText(getText(root)); // v1.5.46:改用 getText 应对 BOSS 字体反爬(innerText 空时回退 textContent)
    if (!fullText || fullText.length < 20) return null;

    // 匹配"岗位职责/职位描述/岗位描述/工作内容"等描述区标题
    // 以及"任职要求/岗位要求/招聘要求/资格条件/任职资格"等要求区标题
    // v1.5.4 收紧:移除宽泛的"详情|介绍"(会误匹配"单位简介"),补充职位详情/岗位说明等写法
    const descHeader = /(?:岗位职责|职位描述|岗位描述|工作内容|职位信息|岗位职能|工作职责|职位详情|岗位详情|岗位说明|职位说明|招聘信息)[\s:：\-\u2014]*\n?/;
    const reqHeader = /(?:任职要求|岗位要求|招聘要求|资格条件|任职资格|具体要求|我们需要你|你需要|能力要求|优先条件|岗位说明|职位说明)[\s:：\-\u2014]*\n?/;

    const descMatch = fullText.match(descHeader);
    const reqMatch = fullText.match(reqHeader);

    if (!descMatch && !reqMatch) return null;

    let description = '';
    let requirement = '';

    if (descMatch && reqMatch) {
      // 两个都有:按位置拆分
      const descStart = descMatch.index + descMatch[0].length;
      const reqStart = reqMatch.index + reqMatch[0].length;

      if (descMatch.index < reqMatch.index) {
        // 描述在前
        description = fullText.substring(descStart, reqMatch.index).trim();
        // v1.5.14:requirement 截断到下一个一级章节 / 无关区块边界,
        //   避免把"四．待遇 / 五、优势 / 六、期望 / 薪资详情 / 公司介绍"等塞进 requirement
        //   (否则整段会被判为垃圾而清空,导致 requirement 丢失)
        let req = fullText.substring(reqStart).trim();
        const reqCut = req.match(
          /(?:薪资详情|发薪日期|公司介绍|总部地址|我们的优势|我们的期望|职位推荐|相关职位|\s[一二三四五六七八九十][、．.][\s]*)/
        );
        if (reqCut && reqCut.index > 0) req = req.substring(0, reqCut.index).trim();
        requirement = req;
      } else {
        // 要求在前(较少见)
        requirement = fullText.substring(reqStart, descMatch.index).trim();
        description = fullText.substring(descStart).trim();
      }
    } else if (descMatch) {
      // 只有描述标题
      const start = descMatch.index + descMatch[0].length;
      description = fullText.substring(start).trim();
    } else if (reqMatch) {
      // 只有要求标题
      const start = reqMatch.index + reqMatch[0].length;
      requirement = fullText.substring(start).trim();
    }

    // v1.5.14:清理描述开头的职位标签行(如"康复理疗机构 推拿 接受无针灸/推拿相关经验 无销售性质"),
    //   这些 skill 标签常在"职位描述"标题与"一、工作内容"之间,不是正文,应剔除。
    if (description) {
      description = description.replace(/^[^\n]*?一[、．.]\s*工作内容/, '一、工作内容');
    }

    return { description, requirement };
  }

  // ==========================================================
  // Section 4: 页面类型判断
  //   - isJobDetailPage / isJobListPage / isPureListPage / isJobSite
  // ==========================================================

  // ----------------------------------------------------------
  // 页面类型判断
  // ----------------------------------------------------------

  // 判断当前页是否为岗位详情页(收紧:必须有详情容器且容器内有标题)
  function isJobDetailPage() {
    const site = getSiteConfig();
    const url = location.href;
    if (site && site.detailPattern) {
      if (site.detailPattern.test(url)) return true;
    }
    // 通用启发:URL 含 job/detail/position 且含 ID(数字或字母开头,如智联校园版 CCSxxxx)
    if (/\/(job|detail|position|showjob|jobinfo|job_detail)\/[A-Za-z0-9]+/i.test(url)) return true;
    // 详情容器内能提取到标题
    const container = getDetailContainer();
    if (container !== document.body && extractTitle(container)) return true;
    return false;
  }

  // 判断当前页是否为岗位列表页
  function isJobListPage() {
    const site = getSiteConfig();
    const url = location.href;
    if (site && site.listPattern) {
      if (site.listPattern.test(url)) return true;
    }
    if (/\/(list|search|sou|jobs|find)/i.test(url)) return true;
    // 启发:页面有足够多的岗位卡片才算列表页
    if (hasEnoughJobCards(JT_CONFIG.limits.BADGE_TEXT_THRESHOLD)) return true;
    return false;
  }

  // 是否为"纯列表页"(无详情容器/详情容器内无完整岗位)
  function isPureListPage() {
    if (isJobDetailPage()) return false;
    const container = getDetailContainer();
    if (container === document.body) return hasEnoughJobCards(2);
    // 容器内没有薪资 → 认为是纯列表
    return !extractSalary(container).raw;
  }

  // ==========================================================
  // Section 5: 岗位解析
  //   - parseJobFromDetailPage / getActiveJob: 详情页提取
  //   - buildJobFromContainer: 从容器构建岗位对象
  //   - parseJobFromCard / findJobCards / findActiveCard: 列表页卡片提取
  //   - generateId: 岗位 ID 生成
  // ==========================================================

  // ----------------------------------------------------------
  // 从详情页提取完整岗位对象(在详情容器范围内)
  // ----------------------------------------------------------
  function parseJobFromDetailPage() {
    const container = getDetailContainer();
    return buildJobFromContainer(container);
  }

  // ----------------------------------------------------------
  // 智能获取"当前用户正在看的岗位"
  // 1. 详情容器内能提取到有意义的标题 → 提取详情
  // 2. 列表页有"激活/选中"的卡片 → 提取该卡片
  // 3. 否则返回 null(列表页无具体岗位,或无法识别)
  // ----------------------------------------------------------
  function getActiveJob() {
    // 1. 尝试详情容器(只调一次 getDetailContainer)
    const container = getDetailContainer();
    if (container !== document.body) {
      const title = extractTitle(container);
      // 计算薪资和描述，供判断复用
      const salary = extractSalary(container);
      let desc = '';
      const hasInfo = salary.raw || (desc = extractDescription(container));
      if (title && hasInfo) {
        // 容器内有效信息 → 提取完整岗位
        // v1.5.43: SPA 列表页(如 BOSS /web/geek/jobs)点击不同卡片时 location.href 不变,
        // 若用 location.href 做 url → 同一搜索页所有岗位 jobKey 碰撞 → 互相覆盖。
        // 修复:列表页场景下从激活卡片提取真实详情 URL(/job_detail/xxx.html)。
        const site = getSiteConfig();
        const isListPage = site && site.listPattern ? site.listPattern.test(location.href) :
          /\/(jobs|recommend|search|list)/i.test(location.href);
        let urlOverride = null;
        if (isListPage) {
          const activeCard = findActiveCard();
          if (activeCard) {
            urlOverride = pickCardUrl(activeCard, title, site);
          }
        }
        return buildJobFromContainer(container, title, salary, desc, urlOverride);
      }
    }
    // 2. URL 明确是详情页,即使容器没定位到,也尝试全页面提取
    const site = getSiteConfig();
    const url = location.href;
    const urlIsDetail = (site && site.detailPattern && site.detailPattern.test(url)) ||
                        /\/(job|detail|position|showjob|jobinfo|job_detail)\/[A-Za-z0-9]+/i.test(url);
    if (urlIsDetail) {
      const job = parseJobFromDetailPage();
      if (job.title) return job;
    }
    // 3. 列表页:找激活/选中卡片
    const activeCard = findActiveCard();
    if (activeCard) {
      return parseJobFromCard(activeCard);
    }
    // 4. 无法确定当前岗位
    return null;
  }

  // ⚠️ v1.5.4:智能重定位提取作用域
  //   站点配置的 detailContainer 可能选到"公司侧栏/头部"而非职位正文
  //   (如康强 kq36.com 的 .job-detail 是公司信息盒),真实职位描述在另一区块。
  //   此时在 body 中搜索真正含职位正文的区块作为提取作用域。
  function resolveExtractionScope(container) {
    if (container === document.body) return container;
    const cText = getText(container); // v1.5.47:改用 getText 应对字体反爬
    const hasJobBody = /职位描述|岗位描述|工作内容|岗位职责|任职要求|岗位要求|招聘要求|任职资格|具体要求|我们需要你|你需要/i.test(cText);
    if (!hasJobBody) {
      const realContainer = findJobContentContainer();
      if (realContainer) return realContainer;
    }
    return container;
  }

  // 提取 description / requirement,含多级兜底(blockSplit → sectionHeader → 关键词拆分)
  function extractDescAndReq(scope, container, site) {
    const useSectionExtract = site && site.selectors && site.selectors.sectionBasedExtraction;
    let description = '';
    let requirement = '';

    // v1.5.5: 智联校园版等"单区块内含【工作内容】/【任职要求】/【薪资待遇】"的页面
    //   直接按方括号标题拆分,避免整块当作 description 或把尾部公司简介/VIP 促销塞进 requirement
    let blockSplitUsed = false;
    if (site && site.blockSplit) {
      const bs = splitByBracketSections(scope, site.blockSplit);
      if (bs && (bs.description || bs.requirement)) {
        description = bs.description;
        requirement = bs.requirement;
        blockSplitUsed = true;
      }
    }

    // 其余站点:多区块标题匹配 或 通用选择器提取
    if (!description && !requirement) {
      if (useSectionExtract) {
        description = extractBySectionHeader(scope, 'description');
        requirement = extractBySectionHeader(scope, 'requirement');

        // ⚠️ Fallback Level 1:若选择器提取全部失败(BOSS 直聘经常改 DOM 类名),
        //   则从容器全文按关键词拆分 —— 这是第一道兜底
        if (!description && !requirement) {
          const fallback = splitContainerTextByKeywords(scope);
          if (fallback) {
            description = fallback.description || '';
            requirement = fallback.requirement || '';
          }
        }
      } else {
        description = extractDescription(scope) || '';
        requirement = extractRequirement(scope);
      }
    }

    // v1.5.13:BOSS 等单区块内含"招聘要求"子标题的页面,description 已拿到整段 JD,
    //   但 requirement 因区块标题匹配不到(或误抓"薪资详情")而缺失。
    //   此时从 description 文本中按"招聘要求/任职要求"子标题拆分出真实 requirement,
    //   并把 description 截断到该子标题之前,避免重复与污染。
    if (useSectionExtract && description && !requirement) {
      const m = description.match(/(?:招聘要求|任职要求|岗位要求|任职资格|具体要求)[\s:：]*/);
      if (m && m.index > 0) {
        const splitAt = m.index + m[0].length;
        let req = description.substring(splitAt).trim();
        // 截断到下一个一级章节(四/五/六…或 待遇/优势/期望/薪资/公司介绍),
        // 避免把后续无关章节也塞进 requirement
        const cut = req.match(/\n\s*[四五六七八][、．.]|\n\s*(?:待遇|优势|期望|薪资|公司介绍|职位推荐|相关职位)/);
        if (cut && cut.index > 0) req = req.substring(0, cut.index).trim();
        if (req && !isJunkRequirement(req)) {
          requirement = req;
          description = description.substring(0, m.index).trim();
        }
      }
    }

    // ⚠️ Universal Fallback 前的质量重置:
    //   extractDescription() 选择器失败时有"返回容器前 N 字"的兜底逻辑,
    //   这会填入非空但未结构化拆分的原始文本,阻断后续的关键词拆分.
    //   requirement 若被识别为垃圾(表格表头/导航),同样清空。
    //
    //   触发条件(任一命中即清空,交由 splitContainerTextByKeywords 精确拆分):
    //     a) 容器退回 body(所有选择器全失败)
    //     b) requirement 为空或为垃圾(说明选择器精确提取没成功)
    //     c) description 超长且不含结构化标题特征(纯原始文本)
    //   ⚠️ v1.5.6:blockSplit 已产出结构化结果时跳过本段,避免把正确结果误清空
    if (!blockSplitUsed) {
      const descLooksRaw = description.length > 200 &&
        !/职位描述|岗位职责|工作内容|任职要求|岗位要求/.test(description);
      const reqJunk = isJunkRequirement(requirement);
      if (container === document.body || !requirement || reqJunk || descLooksRaw) {
        description = '';
        if (!requirement || container === document.body || reqJunk) requirement = '';
      }

      if (!description && !requirement && isJobSite()) {
        // 先试真实容器作用域,再退回整个 body
        let uf = splitContainerTextByKeywords(scope === document.body ? document.body : scope);
        if ((!uf || (!uf.description && !uf.requirement)) && scope !== document.body) {
          uf = splitContainerTextByKeywords(document.body);
        }
        if (uf) {
          description = uf.description || '';
          requirement = uf.requirement || '';
        }
      }
    }

    return { description, requirement };
  }

  // v1.5.6: 校园版标题形如 "康复理疗师（双休+可考证） 7000-9000元",薪资嵌在标题里。
  //   薪资已由 extractSalary 的"兜底3"从标题提取;此处把薪资部分从标题文本剔除,得到纯净职位名。
  function cleanInlineSalaryFromTitle(title, site) {
    if (!site || !site.inlineSalaryInTitle) return title;
    const titleEl = pickSelector(getSelectors('title'), document.body);
    if (!titleEl) return title;
    const rawTitle = cleanText(getText(titleEl)); // v1.5.47:改用 getText 应对字体反爬
    return rawTitle
      .replace(/\s*\d+\s*[-~至到]\s*\d+\s*[kK千万元]?/, '')
      .replace(/\s*\d+\s*[kK千万元](?!\S)/, '')
      .replace(/\s*元(?=\s*$)/, '')
      .replace(/\s+[-_|·]\s*$/, '')
      .trim();
  }

  // 从详情容器直接构建岗位对象(复用已算好的字段，避免重复查询)
  // urlOverride: 可选,SPA 列表页场景下从激活卡片提取的真实详情 URL(覆盖 location.href)
  function buildJobFromContainer(container, titleOpt, salaryOpt, descOpt, urlOverride) {
    let title = titleOpt !== undefined ? titleOpt : extractTitle(container);
    const salary = salaryOpt !== undefined ? salaryOpt : extractSalary(container);
    const desc = descOpt !== undefined ? descOpt : extractDescription(container);
    void desc; // descOpt 已传入时跳过自动提取(保留参数兼容性)

    const scope = resolveExtractionScope(container);
    const site = getSiteConfig();
    const { description, requirement } = extractDescAndReq(scope, container, site);
    title = cleanInlineSalaryFromTitle(title, site);

    // 最终垃圾过滤(防止垃圾 requirement 漏网)
    const finalReq = isJunkRequirement(requirement) ? '' : requirement;

    return {
      id: generateId(),
      url: urlOverride || location.href,
      title,
      company: extractCompany(scope),
      location: extractLocation(scope),
      salaryRaw: salary.raw,
      salaryMin: salary.min,
      salaryMax: salary.max,
      description,
      requirement: finalReq,
      site: site ? site.name : '未知站点',
      capturedAt: Date.now(),
      status: JT_STATUS.UNSEEN,
      score: 0,
      matchReasons: [],
      notes: ''
    };
  }

  // 在列表页找"激活/选中"的岗位卡片
  function findActiveCard() {
    // 1. 站点配置的卡片选择器(如 BOSS直聘 .job-card-wrap.active)
    const site = getSiteConfig();
    if (site && site.cardSelector) {
      const activeCls = site.activeCardClass || 'active';
      try {
        const sel = site.cardSelector + '.' + activeCls;
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) { /* skip */ }
      // 也尝试 .active 直接子元素
      try {
        const cards = document.querySelectorAll(site.cardSelector);
        for (const c of cards) {
          if (c.classList.contains(activeCls)) return c;
        }
      } catch (e) { /* skip */ }
    }
    // 2. 通用激活卡片选择器
    const activeSels = [
      '.job-card-wrap.active',
      '.job-card.active', '.job-item.active', '.list-item.active',
      '.job-card.selected', '.job-card.current',
      '.job-card-wrapper.active',
      '[class*="job-card"][class*="active"]',
      '[class*="job-item"][class*="active"]',
      '[aria-selected="true"]', '[aria-current="true"]',
      '.selected', '.current'
    ];
    for (const sel of activeSels) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  // 从列表页的某个卡片元素提取岗位(轻量)
  // v1.5.42: 智能选择卡片内的岗位详情链接,避免误取公司链接
  // 优先级:1.匹配站点 detailPattern 的链接 2.包含标题文本的链接 3.第一个链接
  function pickCardUrl(card, title, site) {
    const links = card.querySelectorAll('a[href]');
    if (!links || links.length === 0) return location.href;

    // 1. 优先选匹配站点 detailPattern 的链接(最可靠)
    if (site && site.detailPattern) {
      for (const a of links) {
        if (a.href && site.detailPattern.test(a.href)) return a.href;
      }
    }
    // 通用详情页 URL 模式兜底
    const detailRe = /\/(job|detail|position|showjob|jobinfo|job_detail)\//i;
    for (const a of links) {
      if (a.href && detailRe.test(a.href)) return a.href;
    }

    // 2. 选包含标题文本的链接(标题通常在岗位链接内)
    if (title) {
      const titleLower = title.trim().toLowerCase();
      for (const a of links) {
        const txt = (a.textContent || '').trim().toLowerCase();
        if (txt && txt.includes(titleLower)) return a.href;
      }
    }

    // 3. 兜底:第一个链接(可能是公司链接,但至少有 URL 区分度)
    return links[0].href || location.href;
  }

  function parseJobFromCard(card) {
    const getTextBySel = (sel) => {
      try {
        if (!sel) return '';
        const el = card.querySelector(sel);
        return el ? cleanText(getText(el)) : ''; // v1.5.47:改用模块级 getText 应对字体反爬(消除本地 getText 遮蔽)
      } catch (e) { return ''; }
    };

    // 使用站点选择器(优先),兜底用通用选择器
    const titleSels = getSelectors('title');
    const companySels = getSelectors('company');
    const salarySels = getSelectors('salary');
    const locationSels = getSelectors('location');

    // 标题:依次尝试站点选择器
    let title = '';
    for (const sel of titleSels) {
      title = getTextBySel(sel);
      if (title) break;
    }
    if (!title) title = card.getAttribute('data-title') || '';

    // 公司名:依次尝试站点选择器(如 BOSS直聘的 .boss-name)
    let company = '';
    for (const sel of companySels) {
      company = getTextBySel(sel);
      if (company) break;
    }
    // 站点后处理:分割公司名(如 "博发科技 · 人事" → "博发科技")
    const site = getSiteConfig();
    if (site && site.companySplit && company.includes(site.companySplit)) {
      company = company.split(site.companySplit)[0].trim();
    }

    // 薪资
    let salaryRaw = '';
    for (const sel of salarySels) {
      salaryRaw = getTextBySel(sel);
      if (salaryRaw) break;
    }

    // 地址
    let location = '';
    for (const sel of locationSels) {
      location = getTextBySel(sel);
      if (location) break;
    }

    if (!title) return null;

    // v1.5.42: 修复卡片链接误取公司链接导致同公司多岗位 jobKey 碰撞互相覆盖
    // 旧逻辑:card.querySelector('a[href]') 取第一个链接 → 可能是公司链接而非岗位详情链接
    // 新逻辑:1.优先选匹配站点 detailPattern 的链接 2.其次选包含标题文本的链接 3.兜底第一个链接
    const href = pickCardUrl(card, title, site);
    const parsed = parseSalary(salaryRaw);

    return {
      id: generateId(),
      url: href,
      title,
      company,
      location,
      salaryRaw,
      salaryMin: parsed.min,
      salaryMax: parsed.max,
      description: '',
      requirement: '',
      site: site ? site.name : '未知站点',
      capturedAt: Date.now(),
      status: JT_STATUS.UNSEEN,
      score: 0,
      matchReasons: [],
      notes: ''
    };
  }

  // 生成唯一ID
  function generateId() {
    return 'jt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
  }

  // 在列表页找出所有岗位卡片(缓存:按 URL+DOM 结构指纹)
  let _cardsCache = null;
  let _cardsCacheUrl = '';
  function findJobCards() {
    const url = location.href;
    if (url === _cardsCacheUrl && _cardsCache !== null) return _cardsCache;
    _cardsCacheUrl = url;
    // 站点配置的卡片选择器(如 BOSS直聘 .job-card-wrap)
    const site = getSiteConfig();
    const siteCardSel = (site && site.cardSelector) ? [site.cardSelector] : [];
    // 常见岗位卡片选择器
    const cardSels = [
      ...siteCardSel,
      '[class*="job-card"]',
      '[class*="job-item"]',
      '[class*="position"]',
      '[class*="list-item"]',
      '[class*="result"]',
      '.job-list li',
      '.job-list .item',
      '.sojob-list .item',
      '.el',
      'article'
    ];
    const seen = new Set();
    const cards = [];
    for (const sel of cardSels) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          if (!seen.has(el)) {
            seen.add(el);
            cards.push(el);
          }
        });
      } catch (e) { /* skip */ }
    }
    _cardsCache = cards.filter(c => {
      // 过滤掉明显不是岗位卡片的(没有链接的)
      return c.querySelector('a[href]') || c.querySelector('[class*="job"]');
    });
    return _cardsCache;
  }

  // 使卡片缓存失效(供 content.js 在 MutationObserver 回调中调用,
  // 解决 SPA 无限滚动新卡片加载后缓存返回旧列表、新卡片不注入徽章的问题)
  function invalidateCardsCache() {
    _cardsCache = null;
    _cardsCacheUrl = '';
  }

  // 列表页卡片计数(轻量:卡数量足够即返回 true，不计算完整卡片)
  function hasEnoughJobCards(threshold) {
    const site = getSiteConfig();
    if (site && site.cardSelector) {
      try {
        const count = document.querySelectorAll(site.cardSelector).length;
        if (count >= threshold) return true;
      } catch (e) { /* skip */ }
    }
    // 用通用选择器快速找一个，够数即可
    const fastSels = ['[class*="job-card"]', '[class*="job-item"]', '.job-list .item', 'article'];
    let total = 0;
    const seen = new Set();
    for (const sel of fastSels) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          if (!seen.has(el)) { seen.add(el); total++; }
        });
        if (total >= threshold) return true;
      } catch (e) { /* skip */ }
    }
    return false;
  }

  // 判断当前站点是否为已知招聘网站
  function isJobSite() {
    const host = location.hostname.replace(/^www\./, '');
    const patterns = JT_CONFIG.jobSitePatterns || [];
    for (const pattern of patterns) {
      if (host.includes(pattern) || host.endsWith(pattern)) return true;
    }
    return false;
  }

  // ----------------------------------------------------------
  // 诊断函数(getDomDiagnostics / getFullDiagnosticReport)已提取到 lib/diagnostic.js
  // diagnostic.js 作为 JTParser 的扩展模块,在 parser.js 之后加载,
  // 通过 JTParser.getDomDiagnostics / JTParser.getFullDiagnosticReport 挂载。
  // 对外 API 不变,调用方(content.js)无需修改。
  // ----------------------------------------------------------

  return {
    getSiteConfig,
    getDetailContainer,
    isJobDetailPage,
    isJobListPage,
    isPureListPage,
    isJobSite,
    parseJobFromDetailPage,
    getActiveJob,
    parseJobFromCard,
    findJobCards,
    invalidateCardsCache,
    extractTitle,
    parseSalary,
    cleanText,
    extractBySectionHeader,
    // getDomDiagnostics / getFullDiagnosticReport 由 lib/diagnostic.js 动态挂载
  };
})();
