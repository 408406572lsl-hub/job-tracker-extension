// ============================================================
// config.js — 默认筛选配置 & 站点规则
// ============================================================

const JT_CONFIG = {
  // 默认筛选条件(行业中立；用户可按自己的方向配置关键词)
  defaultFilters: {
    // 必须包含的关键词(任一命中即可,空=不过滤)
    includeKeywords: [],
    // 排除关键词(命中任一则标记不匹配；默认不预判任何行业)
    excludeKeywords: [],
    // 目标城市(空=不限)
    cities: ['北京', '上海', '广州'],
    // 最低月薪(元,0=不限)
    minSalary: 0,
    // 最高月薪(元,0=不限)
    maxSalary: 0,
    // 是否排除"要求证书"的岗位
    excludeCertRequired: true,
    // 证书排除词
    certKeywords: ['执业证', '资格证', '持证', '须有证', '需要证书', '康复师证', '技师证'],
    // 是否排除"要求工作经验"的岗位
    excludeExpRequired: false,
    // 工作经验排除词
    expKeywords: ['1年以上经验', '2年以上经验', '3年以上经验', '5年以上经验', '需有工作经验', '有工作经验者优先'],
    // 最低匹配分(0-100)
    minScore: 40
  },

  // 站点适配器:按域名匹配解析规则
  sites: {
    // ⚠️ 智联校园版(xiaoyuan.zhaopin.com)与智联主站 DOM 完全不同,必须放在 zhaopin.com 之前
    //   否则 host.includes('zhaopin.com') 会先命中主站配置,导致校园版选择器全部失效
    'xiaoyuan.zhaopin.com': {
      name: '智联招聘校园版',
      detailPattern: /\/job\//i,
      listPattern: /\/jobs\/|\/sou|\/search|\/job\//i,
      // 真实职位正文在 .job-info__desc(最干净,仅含【工作内容】/【任职要求】/【薪资待遇】)
      // 逐级兜底: .main-body__left / .main-body / .app__main / main
      detailContainer: ['.job-info__desc', '.main-body__left', '.main-body', '.app__main', 'main', '[role="main"]'],
      selectors: {
        title: ['h1', '.job-title', '.position-name'],
        company: ['.company-name', '.co-name', '[class*="company"]'],
        salary: ['.job-salary', '.salary', '[class*="salary"]'],
        location: ['.job-area', '.location', '.address', '[class*="area"]', '[class*="location"]'],
        description: ['.job-info__desc'],
        requirement: ['.job-info__desc']
      },
      // 校园版职位详情是"单个区块内嵌标题",需按标题拆分。
      // ⚠️ 两种写法并存:方括号(【工作内容】)与冒号(工作职责：),必须都兼容
      blockSplit: {
        descHeader: /【?工作内容】?[:：\s]*|【?岗位职责】?[:：\s]*|【?工作职责】?[:：\s]*|【?职位描述】?[:：\s]*|【?岗位描述】?[:：\s]*/,
        reqHeader: /【?任职要求】?[:：\s]*|【?岗位要求】?[:：\s]*|【?招聘要求】?[:：\s]*/,
        salaryHeader: /【?薪资待遇】?[:：\s]*|【?薪酬福利】?[:：\s]*|【?薪资福利】?[:：\s]*|【?福利待遇】?[:：\s]*/
      },
      // 校园版薪资常嵌在标题里(如 "康复理疗师（双休+可考证） 7000-9000元"),需从标题提取并剔除
      inlineSalaryInTitle: true,
      // 校园版公司名/地点无稳定 class 选择器,改从正文关键词附近文本启发式提取
      companyByText: true,
      locationByText: true
    },
    // ⚠️ 广西人才网:无稳定 class 选择器,标题/薪资/公司/地点均为纯文本,
    //   走 blockSplit(按「职位描述/任职要求」拆) + 文本启发式(companyByText/locationByText) + inlineSalaryInTitle
    'gxrc.com': {
      name: '广西人才网',
      detailPattern: /\/jobDetail\//i,
      listPattern: /\/jobList|\/search|\/jobs|\/listJobs/i,
      // 真实职位正文在 .job-detail(#jobDetail) 内(含「职位描述/任职要求/工作地点」)
      detailContainer: ['.job-detail', '#jobDetail', '.main-content', 'main', '[role="main"]'],
      selectors: {
        // 标题优先取 h1 / .job-name;薪资"3-4K"常嵌在标题行,由 inlineSalaryInTitle 提取并剔除
        title: ['h1', '.job-name', '.job-title', '.position-name', '[class*="job-title"]', 'title'],
        // 以下站点无稳定 class,强制走文本启发式(companyByText/locationByText)与薪资兜底
        company: [],
        salary: [],
        location: [],
        description: [],
        requirement: []
      },
      // 单区块内含「职位描述/任职要求」,按标题拆分。
      // reqEndHeader:要求结束边界(福利/工作地点/公司介绍等),
      //   避免把"五险 节日福利…工作地点 公司简介…职位推荐"整段吞进 requirement。
      blockSplit: {
        descHeader: /职位描述[\s:：]*/,
        reqHeader: /任职要求[\s:：]*/,
        reqEndHeader: /五险|福利待遇|工作地点|公司介绍|联系方式|职位推荐|其它要求/
      },
      // 薪资嵌在标题行("儿科康复 3-4K"),从标题提取并剔除
      inlineSalaryInTitle: true,
      // 公司名/地点无稳定 class 选择器,改从正文关键词附近文本启发式提取
      companyByText: true,
      locationByText: true
    },
    'kq36.com': {
      name: '康强医疗人才网',
      // 岗位详情页 URL 特征
      detailPattern: /\/job\/|\/jobdetail|\/showjob/i,
      // 列表页 URL 特征
      listPattern: /\/job\/|\/list|\/search/i,
      // 详情区容器选择器(parser 在此范围内提取,避免抓到列表第一个)
      detailContainer: ['.job-detail', '.detail-content', '.job_detail', '.content', '.detail', 'main', '[role="main"]'],
      selectors: {
        title: ['h1', '.job-title', '.position-title', '.job_name', 'title'],
        company: ['.company-name', '.co-name', '.company', '.ent-name'],
        salary: ['.salary', '.job-salary', '.wage', '.pay'],
        location: ['.location', '.job-area', '.work-place', '.city'],
        description: ['.job-desc', '.job-detail', '.description', '.content', '.detail-content'],
        requirement: ['.requirement', '.job-req', '.condition']
      }
    },
    'zhaopin.com': {
      name: '智联招聘',
      detailPattern: /\/jobs\/|\/job\/|\/jobinfo/i,
      listPattern: /\/jobs\/|\/sou|\/search/i,
      detailContainer: ['.jobinfo-main', '.job-detail-box', '.describtion', '.jobinfo-detail', 'main', '[role="main"]'],
      selectors: {
        title: ['.jobinfo-tit', '.position-name', 'h1'],
        company: ['.company-name', '.co-name', '.company_info'],
        salary: ['.jobinfo-money', '.salary', '.wage'],
        location: ['.jobinfo-area', '.job-area', '.location'],
        description: ['.jobinfo-desc', '.describtion', '.job-detail'],
        requirement: ['.jobinfo-req', '.require']
      }
    },
    '51job.com': {
      name: '前程无忧',
      detailPattern: /\/job\//i,
      listPattern: /\/list|\/search/i,
      detailContainer: ['.tCompany_main', '.job-detail', '.cn', 'main', '[role="main"]'],
      selectors: {
        title: ['.job_title', '.tH', 'h1', '.el'],
        company: ['.company_name', '.tCompany_sidebar a', '.cname'],
        salary: ['.money', '.salary'],
        location: ['.lname', '.location', '.info'],
        description: ['.job_detail', '.bmsg', '.tmsg'],
        requirement: ['.job_req', '.req']
      }
    },
    'zhipin.com': {
      name: 'BOSS直聘',
      // 列表页 /web/geek/jobs 或 /web/geek/recommend
      // 详情页 /job_detail/xxx.html
      detailPattern: /\/job_detail\//i,
      listPattern: /\/web\/geek\/(jobs|recommend|search)/i,
      // BOSS 直聘:详情面板容器
      // ⚠️ .job-banner 仅为头部标题区(含标题/薪资/标签),不含职位描述/任职要求正文!
      //    必须放在列表末尾,否则会被 isReasonableContainer 选中导致 description/requirement 全空
      detailContainer: ['.job-detail-box', '.job-detail', '.job-box', '.job-content', '.detail-content', '.job-detail-body', 'main', '[role="main"]', '.job-banner'],
      // 列表页岗位卡片选择器(parser 找激活卡片用)
      cardSelector: '.job-card-wrap',
      // 列表页激活卡片类名
      activeCardClass: 'active',
      selectors: {
        // 公司名在 .boss-name(卡片)或 .boss-info-attr(详情面板,格式"公司名 · 职位")
        // ⚠️ 切勿用 .name 作标题选择器!BOSS 把招聘者昵称写在 .name(H2) 里(如"郭女士 刚刚活跃"),
        //   真实岗位标题在 .job-banner 内的 .job-name / h1(常不在 .job-detail 容器内,靠全页回退命中)
        title: ['.job-name', '.job-title .job-name', 'h1', '[class*="job-name"]', '[class*="job-title"]', 'title'],
        company: ['.boss-name', '.boss-info-attr', '.company-info .name', '.company-name'],
        // 薪资被反爬隐藏,但仍尝试提取
        salary: ['.job-salary', '.salary', '.red'],
        // 地址在 .company-location(卡片)或 .tag-list li:first-child(详情面板)
        location: ['.company-location', '.tag-list li:first-child', '.job-area', '.location'],
        // ⚠️ BOSS直聘有多个 .job-sec-text 区块(岗位职责/任职要求等)
        //   不能用同一选择器否则 description 和 requirement 会拿到相同文本!
        //   解析器会对本站走"多区块标题匹配"逻辑(见 parser.js extractBySectionHeader)
        description: ['.job-sec-text', '.job-detail-section .desc', '.desc', '.text'],
        requirement: ['.job-sec-text', '.job-tags', '.tag-list'],
        // 告知解析器本站需要按区块标题区分(非空即启用)
        sectionBasedExtraction: true,
        // 区块标题关键词映射(用于定位正确的 .job-sec-text)
        descHeaders: ['岗位', '职责', '内容', '描述'],
        reqHeaders: ['任职', '要求', '资格', '条件']
      },
      // 公司名后处理:从 "公司名 · 职位" 中提取公司名
      companySplit: '·',
      // 公司名提取后取第一段
      companyFirstPart: true
    },
    '58.com': {
      name: '58同城',
      detailPattern: /\/job\//i,
      listPattern: /\/job\//i,
      detailContainer: ['.detail', '.job-desc', '.main', 'main', '[role="main"]'],
      selectors: {
        title: ['.job-name', 'h1', '.title'],
        company: ['.company-name', '.comp-name'],
        salary: ['.salary', '.pay'],
        location: ['.area', '.address', '.pos'],
        description: ['.desc', '.description', '.detail'],
        requirement: ['.req', '.requirement']
      }
    },
    'liepin.com': {
      name: '猎聘',
      detailPattern: /\/job\//i,
      listPattern: /\/job\//i,
      detailContainer: ['.job-info', '.job-detail', '.main', 'main', '[role="main"]'],
      selectors: {
        title: ['.job-title', 'h1', '.name'],
        company: ['.company-name', '.ent-name'],
        salary: ['.salary', '.job-salary'],
        location: ['.job-area', '.location'],
        description: ['.job-description', '.content'],
        requirement: ['.job-requirement', '.req']
      }
    }
  },

  // 通用详情容器选择器(parser 兜底用)
  genericDetailContainer: [
    'main', '[role="main"]', 'article',
    '.job-detail', '.detail-content', '.job-detail-box',
    '.jobinfo-main', '.job-detail-body', '.job-box',
    '.detail', '.content', '.main', '#main', '#content'
  ],

  // 通用启发式选择器(所有站点兜底)
  // 注意:company 排除了 [class*="location"] 避免匹配 .company-location(地址)
  genericSelectors: {
    title: ['h1', '[class*="job-title"]', '[class*="position"]', '[class*="job-name"]', 'title'],
    company: ['[class*="company-name"]', '[class*="company-info"]', '[class*="ent-name"]', '[class*="co-name"]', '[class*="firm"]', '.boss-name', '[class*="company"]:not([class*="location"]):not([class*="address"]):not([class*="area"])'],
    salary: ['[class*="salary"]', '[class*="money"]', '[class*="wage"]', '[class*="pay"]'],
    location: ['[class*="location"]', '[class*="area"]', '[class*="city"]', '[class*="address"]', '[class*="company-location"]'],
    description: ['[class*="desc"]', '[class*="detail"]', '[class*="content"]', 'article', '.main'],
    requirement: ['[class*="req"]', '[class*="condition"]', '[class*="qualif"]']
  },

  // 已知招聘网站域名模式(非这些站点的页面不触发岗位自动检测)
  // 表单自动填充不受此限制,仍可在所有网页生效
  jobSitePatterns: [
    'zhipin.com', '51job.com', 'zhaopin.com', 'kq36.com',
    '58.com', 'liepin.com', 'lagou.com', 'jobui.com',
    'kanzhun.com', 'linkedin.com', 'indeed.com', 'glassdoor.com',
    'chinahr.com', 'shixiseng.com', 'dajie.com', 'job5156.com',
    'zhaopinhui.net', 'job1001.com', 'ylzp.com', 'gdfwqi.com', 'gxrc.com'
  ],

  // 薪资正则(支持 3k-5k / 3000-5000 / 3千-5千 / 3K~5K / 1万-1.5万 等)
  // 优化:第二个数字后必须有 k/K/千/万 或 上下文含薪资关键词,避免误匹配"1-3年"
  salaryRegex: /(\d+(?:\.\d+)?)\s*[kK万千]?\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*[kK万千]?/,
  // 薪资关键词(用于确认正则匹配确实是薪资)
  salaryKeywords: ['薪', '工资', '月薪', '年薪', '待遇', 'k', 'K', '千', '万', '元/月', '元/年', '/月', '/年'],

  // 大模型配置(OpenAI 兼容接口)
  llm: {
    providers: {
      deepseek: {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-r1']
      },
      qwen: {
        name: '通义千问',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen-plus',
        models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwq-plus', 'qwen3-max-thinking']
      },
      glm: {
        name: '智谱GLM',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-4-flash',
        models: ['glm-4-flash', 'glm-4', 'glm-4-air', 'glm-4-plus', 'glm-5.2', 'glm-z1-flash']
      },
      openai: {
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o-mini', 'gpt-4o', 'o1-mini', 'o1', 'o3-mini']
      },
      openrouter: {
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'openai/gpt-4o-mini',
        // OpenRouter 聚合多厂商模型,命名形如 "厂商/模型";下列为常用且便宜的几种
        models: [
          'openai/gpt-4o-mini',
          'openai/gpt-4o',
          'anthropic/claude-3.5-sonnet',
          'google/gemini-flash-1.5',
          'meta-llama/llama-3.1-8b-instruct',
          'deepseek/deepseek-chat',
          'deepseek/deepseek-r1',
          'openai/o1',
          'qwen/qwq-32b',
          'anthropic/claude-3.7-sonnet:thinking'
        ]
      },
      hunyuan: {
        name: '混元 (Hunyuan)',
        baseUrl: 'https://tokenhub.tencentmaas.com/v1',
        defaultModel: 'hy3',
        models: ['hy3']
        // 安全策略:本插件不在代码中内置任何 API Key。用户必须自行在设置页填写。
        // 如需新增内置服务商，请保持此原则，避免密钥泄露。
      },
      custom: {
        name: '自定义(OpenAI 兼容)',
        baseUrl: '',
        defaultModel: '',
        models: []
      }
    },
    defaultProvider: 'deepseek',
    // 调用参数
    // 评分是确定性任务,低温锁定结果、消除同岗位多次调用分数漂移
    temperature: 0.0,
    top_p: 1.0,
    maxTokens: 1200,
    // 推理模型专用 max_tokens:思考过程会消耗大量 token,1200 远不够(GLM-5.2 等会因 token 用尽
    // 导致 finish_reason=length、content 为空、reasoning 中 JSON 被截断)。
    // 8000 足够"思考 + 输出最终 JSON 答案"。
    reasoningMaxTokens: 8000,
    // 超时(毫秒)——推理模型思考时间更长,需放宽
    timeout: 45000,
    // AI 分析缓存(按 岗位+简历+意向 维度,降低漂移与 token 成本)
    aiCacheKey: 'jt_ai_cache',
    aiCacheTtlMs: 24 * 60 * 60 * 1000,

    // 推理模型识别:返回 true 表示 model 为推理/思考类模型(答案可能放在 reasoning 字段,
    // 且多数不支持/不推荐 response_format=json_object)。后台会据此:①跳过 JSON 模式(改用提示词约束);
    // ②从 content 或 reasoning 字段多源提取 JSON;③HR 回复取最后一段作为正文。
    // 匹配规则覆盖:DeepSeek-R1/reasoner、OpenAI o1/o3、Qwen QwQ、智谱 GLM-Z1、OpenRouter 的 *-r1/*:thinking 等。
    isReasoningModel(model) {
      if (!model) return false;
      const m = String(model).toLowerCase();
      // 精确段匹配,避免误伤(如 gpt-4o 不含 o1,glm-4 不含 z1)
      // o1/o3 作为独立段:位于开头、或跟在 / - 之后,且后接 - 或结尾(覆盖 standalone / openai/o1 / openai/o3-mini)
      if (/(^|[/-])(o1|o3)(-|$)/.test(m)) return true;
      if (/^qwq/.test(m)) return true;
      if (/^glm-z1/.test(m)) return true;
      if (/^glm-?5/.test(m)) return true; // 智谱 GLM-5 系列(5/5.2/5.x)为思考模型,答案在 reasoning、content 常为空
      if (/deepseek-r1/.test(m)) return true;
      const keywords = ['reasoner', 'r1', 'thinking', 'z1', '-r', 'qwq'];
      return keywords.some(k => m.includes(k));
    }
  },

  // 存储键名
  storageKeys: {
    jobs: 'jt_jobs',
    filters: 'jt_filters',
    settings: 'jt_settings',
    aiSettings: 'jt_ai_settings',
    profile: 'jt_resume_profile',
    aiCache: 'jt_ai_cache',
    aiKeys: 'jt_ai_keys',
    autoScan: 'jt_auto_scan',
    deletedJobs: 'jt_deleted_jobs',
    aiDebug: 'jt_ai_debug',          // 诊断:保存最近一次 LLM 原始响应(前 2000 字符),供设置页排查推理模型返回结构
    customModels: 'jt_custom_models', // 用户自定义模型名列表,按服务商分组 { deepseek: ['model-a'], custom: ['model-b'] }
    tycApiKey: 'jt_tyc_api_key'     // 天眼查(企业分析)Key:使用者自填,存本地浏览器;桥接握手时推给 mcp-bridge,优先级高于 .env
  },

  // AI 设置默认值(background 与 storage 共用，保持同步)
  defaultAiSettings: {
    provider: 'deepseek',
    apiKey: '',
    model: '',
    baseUrl: '',
    resumeText: '',
    jobIntent: '',
    chatStyle: 'formal',
    extraNotes: '',
    disableReasoning: false      // 关闭思考过程:JSON 分析任务用推理模型时,跳过思维链直接输出答案(OpenRouter 部分模型支持 reasoning.enabled=false)
  },

  // 自动扫描默认配置(全自动定时扫描岗位)
  defaultAutoScan: {
    enabled: false,
    keywords: '',                   // 空格分隔的多个关键词,每个单独跑一轮；空值不会发起扫描
    city: '100010000',             // BOSS 城市码(南宁,与默认筛选城市 北京/上海/广州 一致);常用:北京100010000 上海101020100 广州101280100 深圳101280600 南宁101300100 长沙101270100
    cityName: '北京',
    intervalMin: 60,               // 扫描周期(分钟),最小 5
    maxPerScan: 20,                // 每轮最多处理的岗位数(内部上限,仅用于补全/分析,不暴露给用户)
    maxJobsPerRun: 0,              // 本次扫描最多采集岗位数(0 = 不限制,扫满为止);用户改用"数量"控制替代"轮数"
    enrichDetails: true,           // 自动开后台标签页补全 JD/要求
    autoAnalyze: true,             // 采集后自动跑 AI 适配度分析
    analyzePerDay: 30,             // 每日 AI 分析上限(控制 API 额度)
    // —— 运行态计数(由 background 维护) ——
    lastScanAt: 0,
    lastDate: '',
    analyzedToday: 0,
    totalCollected: 0,
    lastScanAdded: 0
  },

  // 统一魔法数字(性能/防抖/截断阈值,避免散布在各文件)
  timing: {
    SPA_URL_DEBOUNCE: 700,        // content.js: SPA URL 变化后防抖等待
    MUTATION_DEBOUNCE: 1200,      // content.js: MutationObserver 触发后防抖等待
    FILL_BUTTON_DELAY: 2000,      // content.js: 表单检测按钮注入延迟
    RESCAN_DELAY: 300,             // content.js: 重新扫描延迟
  },
  limits: {
    RESUME_TEXT_MAX: 8000,         // background.js: 简历文本截断长度
    RAW_ERROR_PREVIEW: 800,        // background.js: 错误原始返回截断
    JOB_DESC_MAX: 3000,            // parser.js: 岗位描述截断
    BADGE_TEXT_THRESHOLD: 3,       // parser.js: 判定列表页所需最少卡片数
  },

  // 匹配分权重(加权归一模型):各维度子分 0~1,最终 = Σ(权重×子分)/Σ(已启用权重) ×100
  // 未配置的维度(未设关键词/未设城市/未设薪资过滤)不参与评分,既不送分也不扣分
  scoreWeights: {
    keyword: 40,                  // 关键词相关度(标题命中权重最高)
    location: 25,                 // 目标城市
    salary: 15,                   // 薪资区间
    cert: 10,                     // 证书偏好(仅开启 excludeCertRequired 时计入)
    exp: 10,                      // 经验偏好(仅开启 excludeExpRequired 时计入)
    excludePenaltyTitle: 35,      // 排除词命中标题:每个扣此分
    excludePenaltyBody: 20,       // 排除词命中描述/要求:每个扣此分
    excludePenaltyCap: 50,        // 排除词扣分上限
    neutralBaseline: 55,          // 未配置任何有效维度时的中性基线分
    // 关键词子分映射:标题命中 [0.85,1.0],任职要求命中 [0.55,0.75],描述命中 [0.30,0.50],未命中 0
    keywordTitleBase: 0.85,
    keywordTitleStep: 0.15,       // 每多一个标题命中(最多按 3 个计)递增
    keywordReqBase: 0.55,         // 任职要求区域命中基分(雇主明确要求的条件匹配)
    keywordReqStep: 0.20,
    keywordReqMax: 0.75,
    keywordBodyBase: 0.30,
    keywordBodyStep: 0.15,
    keywordBodyMax: 0.50,         // 描述命中上限(降低,与要求区区分)
    salaryBufferRatio: 0.20,      // 薪资略超区间(20%内)给半分
    salaryUnknownSub: 0.50,       // 薪资面议/未知:无法判断,给中性半分
    certSoftSub: 0.50,            // 证书为"优先/加分"项时的子分(非硬性门槛)
    certMentionedSub: 0.30,       // 描述中提及证书但未明确要求时的子分
    expSoftSub: 0.50,             // 经验为"优先"项时的子分
    expMentionedSub: 0.30         // 描述中提及经验但未明确要求时的子分
  }
};

// 应用状态枚举
const JT_STATUS = {
  UNSEEN: 'unseen',       // 未查看
  INTERESTED: 'interested', // 感兴趣
  APPLIED: 'applied',     // 已投递
  INTERVIEW: 'interview', // 面试中
  REJECTED: 'rejected',   // 已拒绝
  OFFER: 'offer'          // 录用
};

const JT_STATUS_LABELS = {
  unseen: '待看',
  interested: '感兴趣',
  applied: '已投递',
  interview: '面试中',
  rejected: '已拒绝',
  offer: '录用'
};

// ============================================================
// 统一工具函数(background.js / storage.js 共用,避免去重逻辑分叉)
// ============================================================
const JT_Utils = {
  // 规范化 URL:去 hash、去末尾斜杠、去常见跟踪参数,降低同岗不同 URL 的重复
  // 保留 path 与业务参数(如 jobid),仅剔除营销/追踪类 query
  // 安全:拒绝 javascript:/data:/vbscript: 等危险协议,仅放行 http/https,避免 XSS
  normalizeUrl(url) {
    if (!url) return '';
    const raw = String(url).trim();
    // 危险协议一律拒绝(即便写在属性里也会执行)
    if (/^\s*(javascript|data|vbscript):/i.test(raw)) return '';
    try {
      const u = new URL(raw);
      // 仅允许 http/https(扩展内部 chrome:// 不在此场景使用)
      if (!/^https?:$/i.test(u.protocol)) return '';
      // 剔除已知跟踪参数(utm_*、from、source、ref 等)
      // 跟踪/营销参数黑名单(命中即剔除),使「同岗不同跟踪参数」的 URL 归并为同一 key
      // 关键:BOSS 岗位详情链接常带 ?ka=search_list_1 这类随列表位置漂移的参数,
      // 若不剔除会导致同一岗位每次扫描 key 不同 → 去重失效(重复入库)+ 墓碑失效(删了又复活)
      const trackKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'from', 'source', 'ref', 'refid', 'share', 'platform',
        'ka', 'spm', 'spm-code', 'spm_code', 'sessionid', 'sessionId', 'sid',
        'trace', 'traceId', 'trace_id', '_t', 'ts', 'timestamp', 'track', 'trackId',
        'uid', 'userid', 'userId', 'v', 'ver', 'cache', 'bc'];
      trackKeys.forEach(k => u.searchParams.delete(k));
      // 去 hash、统一末尾无斜杠、统一小写 host
      let s = u.protocol + '//' + u.host.toLowerCase() + u.pathname + u.search;
      s = s.replace(/\/+$/, '');
      return s;
    } catch (e) {
      // 非标准 URL 直接 trim + 去末尾斜杠
      return raw.replace(/#.*$/, '').replace(/\/+$/, '').trim();
    }
  },

  // 生成岗位去重键:normalizeUrl(url) 为主,title+company 为兜底
  // 返回字符串,相同键视为同一岗位
  // v1.5.43: SPA 列表页(如 BOSS /web/geek/jobs?query=xxx)location.href 不随卡片切换变化,
  //   若卡片内无详情链接导致 url 仍是搜索 URL → 同页所有岗位 jobKey 碰撞 → 互相覆盖。
  //   保护:当 URL 明显是列表/搜索页(非详情页)时,拼接 title+company 增强区分度。
  jobKey(job) {
    if (!job) return '';
    const url = JT_Utils.normalizeUrl(job.url);
    if (url) {
      // 判断是否为详情页 URL(含 /job_detail/、/job/、/detail/ 等路径)
      const isDetailUrl = /\/(job_detail|job|detail|position|showjob|jobinfo|job_detail)\/[A-Za-z0-9]/i.test(url) ||
                          /\/(job_detail|job|detail|position|showjob|jobinfo)\.html/i.test(url);
      if (isDetailUrl) {
        return 'u:' + url;
      }
      // 列表/搜索页 URL → 拼接 title+company 防碰撞
      const t = (job.title || '').trim().toLowerCase();
      const c = (job.company || '').trim().toLowerCase();
      if (t || c) return 'u:' + url + '|t:' + t + '|' + c;
      return 'u:' + url;
    }
    // URL 缺失时用标题+公司名兜底(均 trim+小写)
    const t = (job.title || '').trim().toLowerCase();
    const c = (job.company || '').trim().toLowerCase();
    if (t || c) return 't:' + t + '|' + c;
    return '';
  },

  // 在岗位列表中查找与 target 同键的索引(无则返回 -1)
  // 统一供 background.saveJobDedup 与 storage.saveJob 使用
  findDuplicate(jobs, target) {
    if (!jobs || !jobs.length || !target) return -1;
    const key = JT_Utils.jobKey(target);
    if (!key) return -1;
    return jobs.findIndex(j => JT_Utils.jobKey(j) === key);
  },

  // 合并岗位用于去重更新:以旧记录为底,合并新字段,但保留用户态(status/notes/id)、
  // 采集时间(capturedAt)与既有 AI 分析结果(aiFitScore/aiAnalysis/aiAnalyzedAt)。
  // 统一供 background.saveJobDedup 与 storage.saveJob/saveJobs 使用,消除两套合并逻辑分叉。
  mergeJobForUpdate(oldJob, newJob) {
    return {
      ...oldJob,
      ...newJob,
      status: oldJob.status,
      notes: oldJob.notes,
      id: oldJob.id,
      capturedAt: oldJob.capturedAt,
      aiFitScore: oldJob.aiFitScore,
      aiAnalysis: oldJob.aiAnalysis,
      aiAnalyzedAt: oldJob.aiAnalyzedAt
    };
  }
};
