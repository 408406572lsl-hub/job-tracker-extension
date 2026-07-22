// ============================================================
// settings.js — AI 设置页逻辑
// ============================================================

(function () {
  'use strict';

  let settings = null;
  let currentProviderKey = null; // 记录当前选中的服务商,用于切换时判断 Key 是否为自动填充

  document.addEventListener('DOMContentLoaded', async () => {
    // 先绑定返回键:即使后续初始化(getAiSettings 等)抛错,用户也总能返回管理面板
    const backBtn = document.getElementById('btnBack');
    if (backBtn) backBtn.addEventListener('click', () => {
      window.location.href = '../dashboard/dashboard.html';
    });

    try {
      settings = await JTStorage.getAiSettings();
      renderProviders();
      await fillForm();
      bindEvents();
      await loadProfile();
      await fillTycKey();
      bindTycEvents();
    } catch (e) {
      console.error('[岗位猎手] AI 设置初始化失败:', e);
    }
  });

  // 渲染服务商下拉
  function renderProviders() {
    const sel = document.getElementById('provider');
    sel.innerHTML = '';
    Object.entries(JT_CONFIG.llm.providers).forEach(([key, p]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
  }

  // 根据服务商渲染模型预选列表(datalist)— 用户可直接在 input 里键入任意模型名
  // 预选列表 = 服务商预设模型 + 该服务商已保存的自定义模型(去重)
  async function renderModelList(providerKey) {
    const dl = document.getElementById('modelList');
    if (!dl) return;
    const p = JT_CONFIG.llm.providers[providerKey];
    dl.innerHTML = '';

    // 预设模型
    if (p && p.models && p.models.length) {
      p.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        // 推理模型加标识,提示用户该模型已受支持(自动跳过 JSON 模式,依赖提示词约束输出)
        const isR = JT_CONFIG.llm.isReasoningModel(m);
        opt.textContent = isR ? m + ' 🧠推理' : m;
        dl.appendChild(opt);
      });
    }

    // 持久化自定义模型列表(用户之前键入并保存过的模型名)
    const allCustom = await JTStorage.getCustomModels();
    const customList = (allCustom[providerKey] || []).filter(m =>
      !(p && p.models && p.models.includes(m)) // 避免与预设模型重复
    );
    customList.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      const isR = JT_CONFIG.llm.isReasoningModel(m);
      opt.textContent = isR ? m + ' 🧠推理' : m;
      dl.appendChild(opt);
    });
  }

  // 模型提示:选中推理模型时显示说明(已自动跳过 JSON 模式,依赖提示词约束输出)
  function updateModelHint() {
    const hint = document.getElementById('modelHint');
    if (!hint) return;
    const model = document.getElementById('model').value;
    if (model && JT_CONFIG.llm.isReasoningModel(model)) {
      hint.textContent = '🧠 推理模型:已自动跳过 JSON 模式 + 增大 token 上限(8000)。若 content 为空会自动从思考过程(reasoning)提取 JSON,提取失败还会自动关思考重试一次。若仍失败,请勾选上方「关闭思考过程」或换非推理模型(如 glm-4-flash / gpt-4o-mini / deepseek-chat)。';
      hint.style.display = '';
    } else {
      hint.textContent = '';
      hint.style.display = 'none';
    }
  }

  // 填充表单
  async function fillForm() {
    currentProviderKey = settings.provider || JT_CONFIG.llm.defaultProvider;
    document.getElementById('provider').value = currentProviderKey;
    await renderModelList(settings.provider);
    // input 可直接设任意值(无论是否在 datalist 预选里),不再需要兜底 option
    const p0 = JT_CONFIG.llm.providers[settings.provider];
    document.getElementById('model').value = settings.model || (p0 && p0.defaultModel) || '';
    updateModelHint();
    const p = JT_CONFIG.llm.providers[settings.provider];
    // apiKey:仅使用用户已保存的 Key。安全策略:不在代码中内置任何默认 API Key。
    document.getElementById('apiKey').value = settings.apiKey || '';
    document.getElementById('baseUrl').value = settings.baseUrl || (p && p.baseUrl) || '';
    document.getElementById('resumeText').value = settings.resumeText || '';
    document.getElementById('jobIntent').value = settings.jobIntent || '';
    document.getElementById('chatStyle').value = settings.chatStyle || 'formal';
    document.getElementById('extraNotes').value = settings.extraNotes || '';
    const drEl = document.getElementById('disableReasoning');
    if (drEl) drEl.checked = !!settings.disableReasoning;
  }

  // 绑定事件(天眼查企业分析卡片)
  function bindTycEvents() {
    const tycInput = document.getElementById('tycApiKey');
    const toggleTyc = document.getElementById('toggleTycKey');
    if (toggleTyc && tycInput) {
      toggleTyc.addEventListener('click', () => {
        if (tycInput.type === 'password') { tycInput.type = 'text'; toggleTyc.textContent = '隐藏'; }
        else { tycInput.type = 'password'; toggleTyc.textContent = '显示'; }
      });
    }

    const btnSaveTyc = document.getElementById('btnSaveTycKey');
    if (btnSaveTyc) btnSaveTyc.addEventListener('click', saveTycKey);

    const btnTestTyc = document.getElementById('btnTestTyc');
    if (btnTestTyc) btnTestTyc.addEventListener('click', testTycConnection);
  }

  // 填充天眼查 Key(初始化时)
  async function fillTycKey() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.tycApiKey], (res) => {
        const v = (res && res[JT_CONFIG.storageKeys.tycApiKey]) || '';
        const el = document.getElementById('tycApiKey');
        if (el) el.value = v;
        resolve();
      });
    });
  }

  // 保存天眼查 Key(存本地浏览器,不进包/不进 git)
  async function saveTycKey() {
    const el = document.getElementById('tycApiKey');
    const key = (el && el.value || '').trim();
    await new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.tycApiKey]: key }, resolve);
    });
    const r = document.getElementById('tycSaveResult');
    if (r) {
      r.textContent = key ? '✓ 已保存天眼查 Key' : '✓ 已清空(将降级为不查企业信息)';
      r.style.color = '#16a34a';
      setTimeout(() => { r.textContent = ''; }, 2500);
    }
  }

  // 测试天眼查连接:扩展直连天眼AI(方案 A,不依赖 mcp-bridge / 8765 端口)
  async function testTycConnection() {
    const el = document.getElementById('tycApiKey');
    const key = (el && el.value || '').trim();
    const r = document.getElementById('tycTestResult');
    const btn = document.getElementById('btnTestTyc');
    if (!key) {
      if (r) { r.textContent = '请先填写天眼查 Key'; r.className = 'test-result err'; }
      return;
    }
    // 先保存,确保后续 AI 分析用此 Key
    await new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.tycApiKey]: key }, resolve);
    });
    if (btn) btn.disabled = true;
    if (r) { r.textContent = '正在直连天眼查…'; r.className = 'test-result loading'; }
    try {
      // 直连验证 Key 有效性:用一家确定存在的公司做探针
      const probe = await JTTyc.enrich('示例健康科技有限公司', { city: '南宁', jobIndustry: '康复治疗' }, key);
      if (btn) btn.disabled = false;
      if (probe && probe.skipped) {
        if (r) { r.textContent = '✗ ' + (probe.note || '连接失败'); r.className = 'test-result err'; }
      } else if (probe && probe.unifiedCode) {
        if (r) { r.textContent = '✓ 连接成功：' + (probe.legalName || probe.unifiedCode) + ' · 风险' + (probe.riskLevel || '未知'); r.className = 'test-result ok'; }
      } else {
        if (r) { r.textContent = '✓ 连接成功(该示例公司未匹配到工商数据): ' + (probe && probe.note || ''); r.className = 'test-result ok'; }
      }
    } catch (e) {
      if (btn) btn.disabled = false;
      if (r) { r.textContent = '✗ 连接异常: ' + e.message; r.className = 'test-result err'; }
    }
  }

  // 绑定事件
  function bindEvents() {
    // 服务商切换 → 同步模型 / Base URL / Key 到新服务商
    // 关键:每个服务商记住自己的 Key,切走前先暂存当前 Key,切到后还原该服务商已存 Key
    document.getElementById('provider').addEventListener('change', async (e) => {
      const newKey = e.target.value;
      const oldKey = currentProviderKey;
      const oldP = JT_CONFIG.llm.providers[oldKey];
      const newP = JT_CONFIG.llm.providers[newKey];
      const baseUrlEl = document.getElementById('baseUrl');
      const apiKeyEl = document.getElementById('apiKey');

      // ① 切走前,把当前字段里的 Key 存回「旧服务商」(未点保存就切走也不丢)
      const curApiKey = apiKeyEl.value.trim();
      if (oldKey && oldKey !== newKey && curApiKey) {
        const keys = await JTStorage.getProviderKeys();
        keys[oldKey] = curApiKey;
        await JTStorage.saveProviderKeys(keys);
      }

      await renderModelList(newKey);

      // 切换服务商后:用户已输入模型名 → 保留(避免误清);为空才填新服务商 defaultModel
      const curModel = document.getElementById('model').value.trim();
      const newModelVal = (newP && newP.defaultModel) ? newP.defaultModel : '';
      document.getElementById('model').value = curModel || newModelVal;
      updateModelHint();

      if (newKey === 'custom') {
        // 自定义服务商:仅更新 placeholder,保留用户已填内容
        baseUrlEl.placeholder = 'https://api.example.com/v1';
      } else if (newP) {
        // 已知服务商:Base URL 始终同步为该服务商的默认值(避免残留上一个服务商的地址)
        baseUrlEl.value = newP.baseUrl || '';
        baseUrlEl.placeholder = '留空使用默认:' + newP.baseUrl;
      }

      // ② 切到新服务商:优先还原该服务商已存的 Key。安全策略:不使用任何内置默认 Key。
      const keys = await JTStorage.getProviderKeys();
      apiKeyEl.value = keys[newKey] || '';

      currentProviderKey = newKey;
    });

    // 模型输入:input 事件即时更新推理模型提示(用户可直接键入任意模型名)
    // 失焦(blur)时把非预设模型名即时持久化到该服务商的自定义模型列表,
    // 让自定义模型名即时出现在 datalist 预选里(给予"已记住"的反馈,无需等点保存)
    document.getElementById('model').addEventListener('input', () => {
      updateModelHint();
    });
    document.getElementById('model').addEventListener('blur', async () => {
      const modelEl = document.getElementById('model');
      const m = modelEl.value.trim();
      const provider = document.getElementById('provider').value;
      const p = JT_CONFIG.llm.providers[provider];
      const presetModels = (p && p.models) || [];
      // 非预设模型:持久化到该服务商自定义模型列表,并【立刻重新渲染 datalist】,
      // 让"旁边的三角形"(原生下拉箭头)马上能展开刚输入的模型(修复下拉箭头点击无反应)
      if (m && !presetModels.includes(m)) {
        await JTStorage.addCustomModel(provider, m);
        await renderModelList(provider);
      }
      // 失焦即把当前模型名落到 aiSettings.model——用户无需再点保存,
      // 直接修复"本次输入的模型保存不住"(之前 blur 只加下拉、不落活动模型)
      const data = collect();
      if (data.model !== (settings && settings.model)) {
        await JTStorage.saveAiSettings(data);
        settings = { ...settings, ...data };
        const inline = document.getElementById('saveResultInline');
        if (inline) {
          inline.textContent = '✓ 已记住模型';
          inline.style.color = '#16a34a';
          setTimeout(() => { if (inline.textContent === '✓ 已记住模型') inline.textContent = ''; }, 1500);
        }
      }
    });

    // 显示/隐藏 Key
    document.getElementById('toggleKey').addEventListener('click', () => {
      const inp = document.getElementById('apiKey');
      const eye = document.getElementById('toggleKey');
      if (inp.type === 'password') { inp.type = 'text'; eye.textContent = '隐藏'; }
      else { inp.type = 'password'; eye.textContent = '显示'; }
    });

    // 测试连接
    document.getElementById('btnTest').addEventListener('click', testConnection);

    // 保存(底部主按钮 + 大模型接入卡片内联按钮,共用 save())
    document.getElementById('btnSave').addEventListener('click', save);
    const btnSaveInline = document.getElementById('btnSaveInline');
    if (btnSaveInline) btnSaveInline.addEventListener('click', save);

    // 重置插件(清空使用记录,保留 AI 配置)
    document.getElementById('btnReset').addEventListener('click', onResetClick);
    const btnSoftReset = document.getElementById('btnSoftReset');
    if (btnSoftReset) btnSoftReset.addEventListener('click', onSoftResetClick);

    // 诊断:查看上次 AI 原始响应
    const btnShowDebug = document.getElementById('btnShowDebug');
    const debugBox = document.getElementById('debugBox');
    if (btnShowDebug && debugBox) {
      btnShowDebug.addEventListener('click', () => {
        if (debugBox.style.display === 'none') {
          chrome.storage.local.get(['jt_ai_debug'], (res) => {
            const raw = res.jt_ai_debug;
            if (!raw) { debugBox.textContent = '（暂无记录,请先运行一次 AI 分析/简历分析）'; }
            else {
              try {
                const pretty = JSON.stringify(JSON.parse(raw), null, 2);
                debugBox.textContent = pretty;
              } catch (e) { debugBox.textContent = raw; }
            }
            debugBox.style.display = 'block';
            btnShowDebug.textContent = '隐藏原始响应';
          });
        } else {
          debugBox.style.display = 'none';
          btnShowDebug.textContent = '查看上次 AI 原始响应(排查用)';
        }
      });
    }

    // —— 简历上传 ——
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('resumeFile');
    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) handleFileUpload(e.target.files[0]);
    });
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
    });

    // 档案保存/重新分析
    document.getElementById('btnSaveProfile').addEventListener('click', saveProfileFromForm);
    document.getElementById('btnReparseProfile').addEventListener('click', () => {
      const text = document.getElementById('resumeText').value.trim();
      if (text) analyzeResume(text);
      else alert('请先上传简历文件或粘贴简历文本');
    });
  }

  // 收集表单
  function collect() {
    return {
      provider: document.getElementById('provider').value,
      apiKey: document.getElementById('apiKey').value.trim(),
      model: document.getElementById('model').value,
      baseUrl: document.getElementById('baseUrl').value.trim(),
      resumeText: document.getElementById('resumeText').value,
      jobIntent: document.getElementById('jobIntent').value.trim(),
      chatStyle: document.getElementById('chatStyle').value,
      extraNotes: document.getElementById('extraNotes').value.trim(),
      disableReasoning: !!(document.getElementById('disableReasoning') || {}).checked
    };
  }

  // 测试连接
  async function testConnection() {
    // 先保存当前表单(测试用的是当前填的值)
    const current = collect();
    if (!current.apiKey) {
      showTest('请先填写 API Key', 'err');
      return;
    }
    // 临时保存,让 background 读到
    await JTStorage.saveAiSettings(current);
    settings = { ...settings, ...current };

    // 测试连接时也把自定义模型持久化(与 save() 对齐,方便测试后无需再点保存)
    const pTest = JT_CONFIG.llm.providers[current.provider];
    const presetModelsTest = (pTest && pTest.models) || [];
    if (current.model && !presetModelsTest.includes(current.model)) {
      await JTStorage.addCustomModel(current.provider, current.model);
    }

    const btn = document.getElementById('btnTest');
    btn.disabled = true;
    showTest('正在测试连接…', 'loading');

    chrome.runtime.sendMessage({ type: 'JT_LLM_TEST' }, (res) => {
      btn.disabled = false;
      if (chrome.runtime.lastError || !res) {
        showTest('测试失败:无法连接到插件后台', 'err');
        return;
      }
      if (res.ok) {
        showTest('✓ 连接成功!模型回复:' + (res.reply || ''), 'ok');
      } else {
        showTest('✗ ' + (res.error || '连接失败'), 'err');
      }
    });
  }

  function showTest(text, type) {
    const el = document.getElementById('testResult');
    el.textContent = text;
    el.className = 'test-result ' + (type || '');
  }

  // 保存
  async function save() {
    const data = collect();
    // 说明:API Key 非必填——只改求职意向/语气/补充说明等其它项也能保存。
    // 若填了 Key 则更新;留空则保留已保存的 Key(见 storage.saveAiSettings:空 Key 不删除)。
    await JTStorage.saveAiSettings(data);
    settings = { ...settings, ...data };

    // 若模型名不在预设列表里,持久化为该服务商的自定义模型,并刷新 datalist 让下拉箭头立即可用
    const p = JT_CONFIG.llm.providers[data.provider];
    const presetModels = (p && p.models) || [];
    if (data.model && !presetModels.includes(data.model)) {
      await JTStorage.addCustomModel(data.provider, data.model);
      await renderModelList(data.provider);
    }

    const result = document.getElementById('saveResult');
    result.textContent = '✓ 已保存';
    result.style.color = '#16a34a';
    // 卡片内联保存按钮的反馈区也同步更新(两个入口共用 save())
    const inline = document.getElementById('saveResultInline');
    if (inline) {
      inline.textContent = '✓ 已保存';
      inline.style.color = '#16a34a';
    }
    setTimeout(() => { result.textContent = ''; if (inline) inline.textContent = ''; }, 2000);
  }

  // 软重置:仅清岗位数据 + AI 缓存 + 扫描统计,完整保留 AI 配置(服务商/模型/Base URL/Key)、简历档案等
  async function onSoftResetClick() {
    if (!confirm('确定「仅清岗位数据」吗?\n\n将清空:已记录的岗位、AI 分析缓存、扫描统计。\n\n完整保留:API Key、服务商、模型、Base URL、简历档案、求职意向、沟通偏好、筛选条件。\n\n此操作不可撤销(岗位数据将丢失,但 AI 配置无需重新设置)。')) return;
    await JTStorage.softResetData();
    showResetResult('✓ 已清空岗位数据,AI 配置完整保留(无需重新设置)');
  }

  // 彻底重置:清空所有使用记录,【仅保留】API Key,其余(AI 配置/简历/扫描统计/岗位等)全部清空
  async function onResetClick() {
    if (!confirm('确定要彻底重置吗?\n\n将清空:所有已记录岗位、删除记录、筛选条件、自动扫描配置、AI 服务商/模型设置、简历档案。\n\n仅保留你的 API Key。\n\n此操作不可撤销!')) return;
    if (!confirm('再次确认:真的要清空所有使用记录并回到首次使用状态?(仅 API Key 保留,需重新选服务商/模型)')) return;
    await JTStorage.resetUsageData();
    showResetResult('✓ 已彻底重置,使用记录已清空(仅保留 API Key)');
  }

  function showResetResult(text) {
    const el = document.getElementById('resetResult');
    el.textContent = text;
    el.style.color = '#16a34a';
    setTimeout(() => { el.textContent = ''; }, 4000);
  }

  // ----------------------------------------------------------
  // 简历文件上传 + 解析 + AI 分析
  // ----------------------------------------------------------
  async function handleFileUpload(file) {
    const statusEl = document.getElementById('parseStatus');
    statusEl.style.display = 'block';
    statusEl.className = 'parse-status loading';
    statusEl.textContent = `正在解析 ${file.name} ...`;

    try {
      // 1. 解析文件
      const { text, format } = await JTResumeParser.parse(file);
      if (!text || text.trim().length < 20) {
        throw new Error('文件解析后文本内容太少,可能是扫描版 PDF(图片),请用文字版 PDF');
      }
      const cleaned = JTResumeParser.cleanResumeText(text);
      // 填入文本框
      document.getElementById('resumeText').value = cleaned;

      statusEl.textContent = `${format} 解析成功(${cleaned.length} 字),正在调用 AI 提取结构化档案...`;

      // 2. AI 分析
      await analyzeResume(cleaned);
    } catch (e) {
      statusEl.className = 'parse-status error';
      statusEl.textContent = '解析失败: ' + (e.message || String(e));
    }
  }

  // 调用 AI 分析简历文本
  async function analyzeResume(resumeText) {
    const statusEl = document.getElementById('parseStatus');
    statusEl.style.display = 'block';
    statusEl.className = 'parse-status loading';
    statusEl.textContent = 'AI 正在分析简历,约需 10-30 秒...';

    const jobIntent = document.getElementById('jobIntent').value.trim();

    chrome.runtime.sendMessage(
      { type: 'JT_LLM_RESUME', resumeText, jobIntent },
      (res) => {
        if (chrome.runtime.lastError || !res) {
          statusEl.className = 'parse-status error';
          statusEl.textContent = '分析失败:无法连接到插件后台';
          return;
        }
        if (!res.ok) {
          statusEl.className = 'parse-status error';
          statusEl.textContent = res.error || '分析失败';
          if (res.raw) {
            statusEl.textContent += '\n(模型返回格式异常,可重试或换个模型)';
          }
          return;
        }
        // 保存档案
        const profile = res.profile;
        JTStorage.saveProfile(profile).then(() => {
          renderProfile(profile);
          statusEl.className = 'parse-status success';
          statusEl.textContent = 'AI 分析完成!档案已提取,可在下方编辑后保存。';
        });
      }
    );
  }

  // 加载已保存的档案
  async function loadProfile() {
    const profile = await JTStorage.getProfile();
    if (profile && profile.name) {
      renderProfile(profile);
    }
  }

  // 渲染档案到表单
  function renderProfile(profile) {
    const section = document.getElementById('profileSection');
    section.style.display = 'block';

    const fields = ['name', 'gender', 'phone', 'email', 'age', 'education',
      'school', 'major', 'graduationDate', 'expectedSalary', 'expectedCity',
      'selfSummary'];
    fields.forEach(f => {
      const el = document.getElementById('pf_' + f);
      if (el) el.value = profile[f] || '';
    });
    // 数组字段
    document.getElementById('pf_certifications').value = (profile.certifications || []).join('、');
    document.getElementById('pf_skills').value = (profile.skills || []).join('、');
  }

  // 从表单收集档案并保存
  async function saveProfileFromForm() {
    const profile = {
      name: val('pf_name'),
      gender: val('pf_gender'),
      phone: val('pf_phone'),
      email: val('pf_email'),
      age: val('pf_age'),
      education: val('pf_education'),
      school: val('pf_school'),
      major: val('pf_major'),
      graduationDate: val('pf_graduationDate'),
      expectedSalary: val('pf_expectedSalary'),
      expectedCity: val('pf_expectedCity'),
      certifications: val('pf_certifications').split(/[,，、\n]/).map(s => s.trim()).filter(Boolean),
      skills: val('pf_skills').split(/[,，、\n]/).map(s => s.trim()).filter(Boolean),
      selfSummary: val('pf_selfSummary'),
      resumeText: document.getElementById('resumeText').value
    };
    await JTStorage.saveProfile(profile);

    // 同步到 AI 设置的 resumeText
    settings.resumeText = profile.resumeText;
    await JTStorage.saveAiSettings(settings);

    const btn = document.getElementById('btnSaveProfile');
    const orig = btn.textContent;
    btn.textContent = '已保存 ✓';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }

  function val(id) {
    return (document.getElementById(id).value || '').trim();
  }
})();
