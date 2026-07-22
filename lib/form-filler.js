// ============================================================
// form-filler.js — 申请表单自动检测与填充
// 在 content script 中运行,检测页面上的求职申请表单,
// 将简历档案字段映射到表单字段并自动填充
// ============================================================

const JTFormFiller = (() => {

  // ----------------------------------------------------------
  // 字段映射规则:profile 字段 → 匹配规则(选择器/关键词)
  // ----------------------------------------------------------
  const FIELD_RULES = [
    {
      profile: 'name',
      label: '姓名',
      selectors: [
        'input[name*="name" i]', 'input[name*="xm"]',
        'input[id*="name" i]', 'input[placeholder*="姓名"]',
        'input[placeholder*="名字"]'
      ],
      keywords: ['姓名', '名字', 'name', '你的名字', '真实姓名']
    },
    {
      profile: 'phone',
      label: '电话',
      selectors: [
        'input[name*="phone" i]', 'input[name*="tel" i]', 'input[name*="mobile" i]',
        'input[id*="phone" i]', 'input[id*="tel" i]', 'input[id*="mobile" i]',
        'input[type="tel"]',
        'input[placeholder*="电话"]', 'input[placeholder*="手机"]'
      ],
      keywords: ['电话', '手机', '联系方式', '手机号', 'phone', 'tel', 'mobile', '联系电话']
    },
    {
      profile: 'email',
      label: '邮箱',
      selectors: [
        'input[name*="email" i]', 'input[name*="mail" i]',
        'input[id*="email" i]', 'input[id*="mail" i]',
        'input[type="email"]',
        'input[placeholder*="邮箱"]', 'input[placeholder*="email" i]'
      ],
      keywords: ['邮箱', 'email', 'e-mail', '电子邮箱', '邮件地址']
    },
    {
      profile: 'gender',
      label: '性别',
      selectors: [
        'select[name*="gender" i]', 'select[name*="sex" i]',
        'select[id*="gender" i]', 'select[id*="sex" i]',
        'input[name*="gender" i]', 'input[name*="sex" i]'
      ],
      keywords: ['性别', 'gender', 'sex'],
      type: 'select-or-radio'
    },
    {
      profile: 'age',
      label: '年龄',
      selectors: [
        'input[name*="age" i]', 'input[id*="age" i]',
        'input[placeholder*="年龄"]'
      ],
      keywords: ['年龄', 'age', '出生年月', '生日']
    },
    {
      profile: 'education',
      label: '学历',
      selectors: [
        'select[name*="education" i]', 'select[name*="degree" i]', 'select[name*="xueli" i]',
        'select[id*="education" i]', 'select[id*="degree" i]',
        'input[name*="education" i]', 'input[name*="degree" i]'
      ],
      keywords: ['学历', 'education', 'degree', '文化程度', '最高学历'],
      type: 'select-or-text'
    },
    {
      profile: 'school',
      label: '毕业院校',
      selectors: [
        'input[name*="school" i]', 'input[name*="college" i]', 'input[name*="university" i]',
        'input[id*="school" i]', 'input[id*="college" i]',
        'input[placeholder*="学校"]', 'input[placeholder*="院校"]', 'input[placeholder*="毕业"]'
      ],
      keywords: ['毕业院校', '学校', '院校', 'school', 'college', 'university', '毕业学校', '就读学校']
    },
    {
      profile: 'major',
      label: '专业',
      selectors: [
        'input[name*="major" i]', 'input[name*="specialty" i]', 'input[name*="profession" i]',
        'input[id*="major" i]', 'input[id*="specialty" i]',
        'input[placeholder*="专业"]'
      ],
      keywords: ['专业', 'major', 'specialty', '所学专业', '专业名称']
    },
    {
      profile: 'graduationDate',
      label: '毕业时间',
      selectors: [
        'input[name*="graduat" i]', 'input[name*="biye" i]',
        'input[id*="graduat" i]',
        'input[placeholder*="毕业"]'
      ],
      keywords: ['毕业时间', '毕业日期', 'graduation', '毕业年月']
    },
    {
      profile: 'expectedSalary',
      label: '期望薪资',
      selectors: [
        'input[name*="salary" i]', 'input[name*="pay" i]', 'input[name*="wage" i]',
        'input[id*="salary" i]', 'input[id*="pay" i]',
        'input[placeholder*="薪资"]', 'input[placeholder*="期望"]'
      ],
      keywords: ['期望薪资', '薪资要求', 'salary', '待遇要求', '月薪要求']
    },
    {
      profile: 'expectedCity',
      label: '期望城市',
      selectors: [
        'input[name*="city" i]', 'input[name*="area" i]', 'input[name*="location" i]',
        'input[id*="city" i]', 'input[id*="area" i]',
        'input[placeholder*="城市"]', 'input[placeholder*="地点"]',
        'select[name*="city" i]', 'select[id*="city" i]'
      ],
      keywords: ['期望城市', '意向城市', '工作城市', 'city', '工作地点', '意向地点']
    },
    {
      profile: 'selfSummary',
      label: '自我介绍',
      selectors: [
        'textarea[name*="summary" i]', 'textarea[name*="intro" i]', 'textarea[name*="desc" i]',
        'textarea[name*="self" i]', 'textarea[name*="pingjia" i]',
        'textarea[id*="summary" i]', 'textarea[id*="intro" i]', 'textarea[id*="desc" i]',
        'textarea[placeholder*="自我"]', 'textarea[placeholder*="介绍"]',
        'textarea[placeholder*="评价"]', 'textarea[placeholder*="描述"]'
      ],
      keywords: ['自我介绍', '自我评价', '个人简介', '个人描述', '自我描述', 'self', 'summary', '简介']
    }
  ];

  // ----------------------------------------------------------
  // 检测页面是否有申请表单
  // ----------------------------------------------------------
  // 检测页面是否有申请表单
  // 简单缓存:同一 URL+DOM 状态下不重复检测
  let _formCache = null;
  let _formCacheTime = 0;
  function detectForms() {
    // 缓存有效期 500ms,避免 MutationObserver 防抖内多次调用
    const now = Date.now();
    if (_formCache && now - _formCacheTime < 500) return _formCache;
    _formCacheTime = now;

    const results = [];
    // 1. 找所有 form 元素
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
      const fields = findFillableFields(form);
      if (fields.length >= 2) {
        results.push({ element: form, fields, type: 'form' });
      }
    });
    // 2. 没有 form 但有大量输入框的区域(可能是 SPA 表单)
    if (results.length === 0) {
      const inputs = document.querySelectorAll('input, textarea, select');
      const visibleInputs = Array.from(inputs).filter(isVisible);
      if (visibleInputs.length >= 3) {
        const fields = findFillableFields(document.body);
        if (fields.length >= 2) {
          results.push({ element: document.body, fields, type: 'section' });
        }
      }
    }
    _formCache = results;
    return results;
  }

  // 在指定范围内查找可填充字段
  function findFillableFields(scope) {
    const found = [];
    const usedElements = new Set();

    for (const rule of FIELD_RULES) {
      const el = findField(scope, rule);
      if (el && !usedElements.has(el)) {
        usedElements.add(el);
        found.push({
          element: el,
          profileKey: rule.profile,
          label: rule.label,
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          current: el.value || ''
        });
      }
    }
    return found;
  }

  // 按规则查找单个字段
  function findField(scope, rule) {
    // 1. CSS 选择器匹配
    for (const sel of rule.selectors) {
      try {
        const el = scope.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch (e) { /* 无效选择器 */ }
    }
    // 2. 关键词匹配:找 label/placeholder/name 中含关键词的
    const keywords = rule.keywords;
    // 2a. label 关联
    const labels = scope.querySelectorAll('label');
    for (const label of labels) {
      const text = (label.textContent || '').trim().toLowerCase();
      if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
        const forId = label.getAttribute('for');
        if (forId) {
          const el = scope.querySelector('#' + CSS.escape(forId));
          if (el && isVisible(el)) return el;
        }
        // label 内部的 input
        const inner = label.querySelector('input, textarea, select');
        if (inner && isVisible(inner)) return inner;
      }
    }
    // 2b. placeholder 匹配
    const inputs = scope.querySelectorAll('input, textarea, select');
    for (const inp of inputs) {
      if (!isVisible(inp)) continue;
      const placeholder = (inp.placeholder || '').toLowerCase();
      const name = (inp.name || '').toLowerCase();
      const id = (inp.id || '').toLowerCase();
      if (keywords.some(kw =>
        placeholder.includes(kw.toLowerCase()) ||
        name.includes(kw.toLowerCase()) ||
        id.includes(kw.toLowerCase())
      )) {
        return inp;
      }
    }
    // 2c. 相邻文本节点匹配(有些表单没有 label,用纯文本做标签)
    for (const inp of inputs) {
      if (!isVisible(inp)) continue;
      const prev = inp.previousElementSibling;
      if (prev) {
        const text = (prev.textContent || '').trim().toLowerCase();
        if (keywords.some(kw => text.includes(kw.toLowerCase()))) return inp;
      }
    }
    return null;
  }

  // 判断元素是否可见
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;
    return true;
  }

  // ----------------------------------------------------------
  // 填充表单
  // ----------------------------------------------------------
  function fillForm(profile) {
    if (!profile) return { filled: 0, skipped: 0, details: [] };

    const forms = detectForms();
    if (forms.length === 0) {
      return { filled: 0, skipped: 0, details: [], error: '未检测到可填充的申请表单' };
    }

    let filled = 0, skipped = 0;
    const details = [];

    // 对所有检测到的表单都填充
    for (const form of forms) {
      for (const field of form.fields) {
        const value = profile[field.profileKey];
        if (!value) {
          skipped++;
          details.push({ label: field.label, status: 'skip', reason: '档案中无此信息' });
          continue;
        }

        // 数组类型(证书/技能)→ 拼接
        let fillValue = Array.isArray(value) ? value.join('、') : String(value);

        const result = setFieldValue(field.element, fillValue, field.profileKey);
        if (result) {
          filled++;
          details.push({ label: field.label, status: 'filled', value: fillValue.substring(0, 50) });
        } else {
          skipped++;
          details.push({ label: field.label, status: 'skip', reason: '字段类型不支持自动填充' });
        }
      }

      // 独立处理:自动勾选"同意条款"类复选框(不计入 profile 字段)
      const agreed = autoCheckAgreements(form.element);
      agreed.forEach((box) => {
        filled++;
        const label = (box.getAttribute('aria-label') || box.id || 'agreement').toString();
        details.push({ label: '同意条款(' + label + ')', status: 'checked' });
      });
    }

    return { filled, skipped, details };
  }

  // 设置字段值(兼容 input / textarea / select / radio)
  function setFieldValue(el, value, profileKey) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();

    try {
      if (tag === 'textarea') {
        el.value = value;
        triggerEvents(el);
        return true;
      }
      if (tag === 'select') {
        // 尝试匹配 option
        const options = el.options;
        for (let i = 0; i < options.length; i++) {
          if (options[i].text.includes(value) || options[i].value === value ||
              options[i].text === value) {
            el.selectedIndex = i;
            triggerEvents(el);
            return true;
          }
        }
        // 部分匹配
        for (let i = 0; i < options.length; i++) {
          if (options[i].text.includes(value) || value.includes(options[i].text)) {
            el.selectedIndex = i;
            triggerEvents(el);
            return true;
          }
        }
        return false;
      }
      if (tag === 'input') {
        // 性别/学历等可能用 radio
        if (el.type === 'radio') {
          const radios = document.querySelectorAll(`input[name="${el.name}"]`);
          for (const radio of radios) {
            const label = findRadioLabel(radio);
            if (label) {
              // 精确匹配或 label 是 value 的完整单词(避免"男女不限"误匹配"男")
              const normLabel = label.trim().toLowerCase();
              const normValue = String(value).trim().toLowerCase();
              if (normLabel === normValue || normLabel === normValue.replace(/[男女]/g, '')) {
                radio.checked = true;
                triggerEvents(radio);
                return true;
              }
            }
          }
          return false;
        }
        // checkbox:仅自动勾选"同意条款/隐私政策/用户协议"类,避免误勾业务复选框
        if (el.type === 'checkbox') {
          if (isAgreementCheckbox(el)) {
            el.checked = true;
            triggerEvents(el);
            return true;
          }
          return false;
        }
        // 普通文本输入
        el.value = value;
        triggerEvents(el);
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  // 判断 checkbox 是否为"同意条款/隐私政策/用户协议"类
  // 仅这类 checkbox 才自动勾选,避免误勾业务选项(如"接收营销信息""接受夜班"等)
  function isAgreementCheckbox(el) {
    // 收集所有可能的文本来源:name、id、aria-label、相邻 label、父元素文本
    const sources = [
      el.name || '', el.id || '', el.getAttribute('aria-label') || ''
    ];
    // 相邻 label(紧跟 checkbox 的兄弟节点,最可靠)
    const next = el.nextElementSibling;
    if (next) sources.push((next.textContent || '').trim());
    // label[for=el.id]
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) sources.push((label.textContent || '').trim());
    }
    // 注意:不抓取 parentElement.textContent——当 checkbox 直接挂在短表单内时,
    //   父表单文本会包含其他 checkbox 的"同意/协议"字样,导致业务 checkbox 误判为条款框。
    //   相邻 label 与 label[for] 已能覆盖绝大多数招聘表单的真实场景。

    const text = sources.join(' ').toLowerCase();
    // 命中"同意/阅读并同意/接受协议/同意条款"等关键词才视为条款勾选框
    return /(同意|阅读并同意|接受.{0,4}协议|同意.{0,4}条款|agree|terms|privacy|policy)/i.test(text);
  }

  // 自动勾选"同意条款/隐私政策/用户协议"类复选框
  // fillForm 主循环只处理 FIELD_RULES 命中的 profile 字段(无 checkbox 类),
  // 故此处独立扫描表单内复选框,命中条款型才勾选,避免误勾业务选项。
  function autoCheckAgreements(scope) {
    const checked = [];
    const boxes = scope.querySelectorAll('input[type="checkbox"]');
    boxes.forEach((box) => {
      if (!isVisible(box)) return;
      if (box.checked) return;
      if (isAgreementCheckbox(box)) {
        if (setFieldValue(box, true, 'agreement')) checked.push(box);
      }
    });
    return checked;
  }

  // 找 radio 按钮对应的文本标签
  function findRadioLabel(radio) {
    // 1. 父元素文本
    const parent = radio.parentElement;
    if (parent) {
      const text = (parent.textContent || '').trim();
      if (text && text.length < 20) return text;
    }
    // 2. 相邻元素
    const next = radio.nextElementSibling;
    if (next) {
      const text = (next.textContent || '').trim();
      if (text) return text;
    }
    // 3. 关联 label
    if (radio.id) {
      const label = document.querySelector(`label[for="${radio.id}"]`);
      if (label) return (label.textContent || '').trim();
    }
    return '';
  }

  // 触发 input/change 事件,让页面 JS 感知到值变化
  // React/Vue 兼容:使用原生 setter 设置 value,再触发事件
  function triggerEvents(el) {
    const events = ['input', 'change', 'blur'];
    events.forEach(type => {
      try {
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      } catch (e) { /* 忽略 */ }
    });
    // React 兼容:React 内部追踪 _valueTracker,需调用原生 setter 才能感知变化
    try {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter && el._valueTracker) {
        nativeSetter.call(el, el.value);
        el._valueTracker.setValue(el.value);
      }
    } catch (e) { /* 忽略 */ }
  }

  // ----------------------------------------------------------
  // 在页面上注入浮动填充按钮
  // ----------------------------------------------------------
  function injectFillButton(profile, onFill) {
    // 移除旧按钮
    const old = document.getElementById('jt-fill-btn');
    if (old) old.remove();

    // 检测是否有表单
    const forms = detectForms();
    if (forms.length === 0) return;

    const btn = document.createElement('div');
    btn.id = 'jt-fill-btn';
    btn.innerHTML = `
      <div class="jt-fill-btn-icon">✍</div>
      <div class="jt-fill-btn-text">自动填表</div>
    `;
    btn.title = '点击用简历信息自动填充此表单';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onFill === 'function') onFill();
    });

    document.body.appendChild(btn);
  }

  function removeFillButton() {
    const btn = document.getElementById('jt-fill-btn');
    if (btn) btn.remove();
  }

  return {
    detectForms,
    findFillableFields,
    fillForm,
    injectFillButton,
    removeFillButton,
    FIELD_RULES
  };
})();
