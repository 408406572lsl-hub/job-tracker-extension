// ============================================================
// storage.js — 本地存储封装(chrome.storage.local)
// 供 popup / dashboard / background 使用(content script 直接调 chrome.storage)
// ============================================================

const JTStorage = (() => {

  // v1.5.55 以前的康复方向默认值。仅当已保存值与历史默认值完全一致时迁移，
  // 避免覆盖用户主动填写的康复意向、筛选词或扫描关键词。
  const LEGACY_DEFAULTS = {
    includeKeywords: ['康复', '康复治疗', 'PT', 'OT', 'ST', '物理治疗', '作业治疗', '言语治疗', '理疗'],
    excludeKeywords: ['销售', '保险', '中介'],
    jobIntent: '求职意向示例：前端开发岗位，一线城市优先，接受应届生',
    autoScanKeywords: '康复 推拿'
  };

  function sameStringArray(a, b) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((value, index) => value === b[index]);
  }

  // 为岗位保证一个稳定唯一 id(导入/补全场景可能缺 id)
  // 自包含生成器,不依赖 lib/parser.js 闭包,前端与 SW 均可使用
  function ensureJobId(job) {
    if (job && !job.id) {
      job.id = 'jt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
    }
    return job;
  }

  // 获取所有已记录岗位
  async function getJobs() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.jobs], (res) => {
        resolve(res[JT_CONFIG.storageKeys.jobs] || []);
      });
    });
  }

  // 保存岗位(去重)
  // 统一使用 JT_Utils.jobKey 做去重(background 与 storage 共用同一逻辑)
  // opts.respectTombstone=true 时,若岗位 key 在"已删除墓碑"中则跳过(防止删除后又被扫描加回)
  async function saveJob(job, opts) {
    if (!job || (!job.url && !job.title)) {
      return { action: 'error', error: '岗位信息不完整,无法保存' };
    }
    ensureJobId(job); // 保证入库岗位始终有可引用的 id(M9 修复)
    const jobs = await getJobs();
    const existIdx = JT_Utils.findDuplicate(jobs, job);
    if (existIdx >= 0) {
      // 已存在则更新:以旧记录为底,合并新字段,但保留用户态(status/notes/id)、
      // 采集时间(capturedAt)与既有 AI 分析结果(aiFitScore/aiAnalysis/aiAnalyzedAt),
      // 避免更新去重时静默丢失 AI 评分(次日重扫同岗不会把分清空)
      jobs[existIdx] = JT_Utils.mergeJobForUpdate(jobs[existIdx], job);
      await persist(jobs);
      return { action: 'updated', job: jobs[existIdx] };
    }
    if (opts && opts.respectTombstone) {
      const del = await getDeletedKeys();
      if (del.includes(JT_Utils.jobKey(job))) {
        return { action: 'skipped', reason: 'tombstone' };
      }
    }
    jobs.unshift(job);
    await persist(jobs);
    return { action: 'added', job };
  }

  // 批量保存(去重)
  // opts.respectTombstone=true 时,墓碑中的岗位不再被加回(用于自动扫描)
  async function saveJobs(newJobs, opts) {
    const jobs = await getJobs();
    const del = (opts && opts.respectTombstone) ? await getDeletedKeys() : [];
    let added = 0, updated = 0, skipped = 0;
    for (const job of newJobs) {
      ensureJobId(job); // 保证入库岗位始终有可引用的 id(M9 修复)
      const existIdx = JT_Utils.findDuplicate(jobs, job);
      if (existIdx >= 0) {
        // 更新:保留用户态 + 采集时间 + 既有 AI 分析结果(同 saveJob)
        jobs[existIdx] = JT_Utils.mergeJobForUpdate(jobs[existIdx], job);
        updated++;
      } else if (opts && opts.respectTombstone && del.includes(JT_Utils.jobKey(job))) {
        skipped++;
      } else {
        jobs.unshift(job);
        added++;
      }
    }
    await persist(jobs);
    return { added, updated, skipped, total: jobs.length };
  }

  // 获取"已删除墓碑"(记录被用户删除过的岗位 key,扫描时不再复活)
  async function getDeletedKeys() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.deletedJobs], (res) => {
        resolve(res[JT_CONFIG.storageKeys.deletedJobs] || []);
      });
    });
  }

  // 把岗位 key 追加进墓碑(去重)
  async function addDeletedKeys(keys) {
    if (!keys || !keys.length) return;
    const cur = await getDeletedKeys();
    const set = new Set(cur);
    keys.forEach(k => { if (k) set.add(k); });
    const arr = [...set];
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.deletedJobs]: arr }, () => resolve(arr));
    });
  }

  // 删除单个岗位(同时记入墓碑)
  async function deleteJob(id) {
    const jobs = await getJobs();
    const job = jobs.find(j => j.id === id);
    const filtered = jobs.filter(j => j.id !== id);
    if (job) await addDeletedKeys([JT_Utils.jobKey(job)]);
    await persist(filtered);
    return filtered.length;
  }

  // 批量删除(同时记入墓碑)
  async function deleteJobs(ids) {
    const jobs = await getJobs();
    const idSet = new Set(ids);
    const removed = jobs.filter(j => idSet.has(j.id));
    const filtered = jobs.filter(j => !idSet.has(j.id));
    if (removed.length) await addDeletedKeys(removed.map(j => JT_Utils.jobKey(j)));
    await persist(filtered);
    return filtered.length;
  }

  // 更新岗位状态
  async function updateStatus(id, status) {
    const jobs = await getJobs();
    const job = jobs.find(j => j.id === id);
    if (job) {
      job.status = status;
      await persist(jobs);
    }
    return job;
  }

  // 更新笔记
  async function updateNotes(id, notes) {
    const jobs = await getJobs();
    const job = jobs.find(j => j.id === id);
    if (job) {
      job.notes = notes;
      await persist(jobs);
    }
    return job;
  }

  // 写入 AI 分析结果(适配度分数 + 完整分析对象)到岗位记录
  // 供管理面板以 AI 分作为主评分(排序/筛选/分数标签)使用
  async function updateAiAnalysis(id, fitScore, analysis) {
    const jobs = await getJobs();
    const job = jobs.find(j => j.id === id);
    if (job) {
      if (typeof fitScore === 'number') job.aiFitScore = fitScore;
      job.aiAnalysis = analysis || null;
      job.aiAnalyzedAt = Date.now();
      await persist(jobs);
    }
    return job;
  }

  // 清空所有岗位
  // 注意:默认【不】清空墓碑(已删除记录),保留用户删除意图,防止自动扫描复活
  // opts.tombstone=true 时(如管理面板"清空所有"按钮),把被清空的岗位 key 追加进墓碑,
  // 使它们之后扫描也不会再被加回 —— 等同于"永久删除当前所有岗位"
  async function clearAll(opts) {
    const cur = await getJobs();
    await persist([]);
    if (opts && opts.tombstone) {
      const keys = cur.map(j => JT_Utils.jobKey(j)).filter(Boolean);
      await addDeletedKeys(keys);
    }
    return cur.length;
  }

  // 清空删除墓碑(用于"重置删除记录",之后扫描可重新收录之前删过的岗位)
  async function clearDeletedJobs() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.deletedJobs]: [] }, () => resolve());
    });
  }

  // 彻底重置:回到首次使用状态。【仅保留】API Key(jt_ai_keys),其余使用数据全部删除。
  // 用 remove 彻底删除(而非设为空对象),确保「连扫过多少都不知道」——统计与 AI 缓存均无残留,
  // 之后无论手动还是自动扫描,都不会再命中任何旧缓存 / 旧计数。
  async function resetUsageData() {
    const usageKeys = [
      JT_CONFIG.storageKeys.jobs,
      JT_CONFIG.storageKeys.deletedJobs,
      JT_CONFIG.storageKeys.filters,
      JT_CONFIG.storageKeys.aiCache,
      JT_CONFIG.storageKeys.autoScan,
      JT_CONFIG.storageKeys.profile,
      JT_CONFIG.storageKeys.aiSettings,
      JT_CONFIG.storageKeys.customModels,
    ];
    // 1. 彻底删除所有使用数据(岗位/墓碑/筛选/AI缓存/扫描配置/档案/AI设置)
    await new Promise((resolve) => {
      chrome.storage.local.remove(usageKeys, () => resolve());
    });
    // 2. 岗位兜底为空数组(getter 不返回 undefined)
    await persist([]);
    // 3. 写回干净的默认配置(各 getter 取到默认值,而非缺省 undefined)
    await saveFilters(JT_CONFIG.defaultFilters);
    await saveAutoScan(JTAutoScan.merge({}));
    await saveProfile(DEFAULT_PROFILE, { replace: true });
    // 4. AI 设置清回默认 —— 仅保留 API Key(不动 jt_ai_keys),确保重置后可重新配置
    await saveAiSettings({});
    return true;
  }

  // 软重置:仅清空「岗位数据 + AI 分析缓存 + 扫描统计」,完整保留 AI 配置。
  // —— 保留:API Key(jt_ai_keys)、服务商/模型/Base URL(jt_ai_settings)、简历档案、求职意向、
  //         沟通偏好、筛选条件、已删除记录(墓碑)。
  // —— 清空:已记录岗位、AI 分析缓存、自动扫描统计。
  // 适合「想清空岗位但不想重配 AI」的场景,重置后无需重新选服务商/模型即可直接分析。
  // 注意:自动扫描的【配置】也保留(enabled/maxJobsPerRun 等不动),仅把【统计】字段清零,
  // 因此之前「关闭自动扫描」的状态不会被重新打开。
  async function softResetData() {
    const usageKeys = [
      JT_CONFIG.storageKeys.jobs,
      JT_CONFIG.storageKeys.aiCache
    ];
    // 1. 彻底删除岗位 + AI 缓存(用 remove,确保不残留旧计数/旧缓存)
    await new Promise((resolve) => {
      chrome.storage.local.remove(usageKeys, () => resolve());
    });
    // 2. 岗位兜底为空数组(getter 不返回 undefined)
    await persist([]);
    // 3. 扫描统计清零,但保留自动扫描配置
    const cur = await getAutoScan();
    const statsCleared = Object.assign({}, cur, {
      lastScanAt: 0,
      lastDate: '',
      analyzedToday: 0,
      totalCollected: 0,
      lastScanAdded: 0
    });
    await saveAutoScan(statsCleared);
    return true;
  }

  // 获取筛选条件
  async function getFilters() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.filters], (res) => {
        const stored = res[JT_CONFIG.storageKeys.filters];
        if (!stored) {
          resolve({ ...JT_CONFIG.defaultFilters });
          return;
        }
        const migrated = { ...JT_CONFIG.defaultFilters, ...stored };
        let changed = false;
        if (sameStringArray(stored.includeKeywords, LEGACY_DEFAULTS.includeKeywords)) {
          migrated.includeKeywords = [];
          changed = true;
        }
        if (sameStringArray(stored.excludeKeywords, LEGACY_DEFAULTS.excludeKeywords)) {
          migrated.excludeKeywords = [];
          changed = true;
        }
        if (changed) {
          chrome.storage.local.set({ [JT_CONFIG.storageKeys.filters]: migrated }, () => resolve(migrated));
          return;
        }
        resolve(migrated);
      });
    });
  }

  // 保存筛选条件
  async function saveFilters(filters) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.filters]: filters }, () => resolve(filters));
    });
  }

  // 获取设置
  async function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.settings], (res) => {
        resolve(res[JT_CONFIG.storageKeys.settings] || { showBadges: true });
      });
    });
  }

  // 保存设置
  async function saveSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.settings]: settings }, () => resolve(settings));
    });
  }

  // AI 设置默认值(统一从 config.js 引用，保持与 background.js 同步)
  const DEFAULT_AI_SETTINGS = JT_CONFIG.defaultAiSettings;

  // 读取按服务商分别保存的 API Key 映射 { providerKey: apiKey }
  async function getProviderKeys() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.aiKeys], (res) => {
        resolve(res[JT_CONFIG.storageKeys.aiKeys] || {});
      });
    });
  }

  // 保存 API Key 映射
  async function saveProviderKeys(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.aiKeys]: keys }, () => resolve(keys));
    });
  }

  // 获取 AI 设置(合并默认值)。
  // apiKey 按「当前服务商」从 providerKeys 解析,实现每个服务商记住自己的 Key,
  // 切换服务商不会丢失其它服务商的 Key。
  async function getAiSettings() {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.aiSettings], (res) => {
        resolve(res[JT_CONFIG.storageKeys.aiSettings] || {});
      });
    });
    const merged = { ...DEFAULT_AI_SETTINGS, ...stored };

    // 迁移:v1.5.54 及以前的内置康复意向仅是产品默认，不代表用户主动选择。
    // 只有精确命中历史默认值时才清空；用户自行填写的任何意向（包括康复方向）原样保留。
    if (stored.jobIntent === LEGACY_DEFAULTS.jobIntent) {
      merged.jobIntent = DEFAULT_AI_SETTINGS.jobIntent;
      await new Promise((resolve) => chrome.storage.local.set({
        [JT_CONFIG.storageKeys.aiSettings]: { ...stored, jobIntent: merged.jobIntent }
      }, resolve));
    }

    // 迁移:旧的单一 apiKey 字段 → 按服务商存入 providerKeys(仅一次)
    if (merged.apiKey && merged.provider) {
      const keys = await getProviderKeys();
      if (!keys[merged.provider]) keys[merged.provider] = merged.apiKey;
      await saveProviderKeys(keys);
      delete merged.apiKey;
      await new Promise((resolve) => chrome.storage.local.set({ [JT_CONFIG.storageKeys.aiSettings]: merged }, resolve));
    }

    // apiKey 从 providerKeys 取。安全策略:不在代码中内置任何默认 Key,缺省返回空字符串。
    const keys = await getProviderKeys();
    merged.apiKey = keys[merged.provider] || '';
    return merged;
  }

  // 保存 AI 设置:把 apiKey 按服务商分别存入 providerKeys,其余字段存入 jt_ai_settings
  // 注意:apiKey 为空时【不】删除已存的 Key(避免仅修改其它设置就清空 Key)
  async function saveAiSettings(settings) {
    const provider = settings.provider;
    const apiKey = settings.apiKey;
    if (provider && apiKey) {
      const keys = await getProviderKeys();
      keys[provider] = apiKey;
      await saveProviderKeys(keys);
    }
    // 其余字段(去掉 apiKey,避免与 providerKeys 不一致)
    const rest = { ...settings };
    delete rest.apiKey;
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.aiSettings]: rest }, () => resolve(rest));
    });
  }

  // 简历档案默认值
  const DEFAULT_PROFILE = {
    name: '', gender: '', phone: '', email: '', age: '',
    education: '', school: '', major: '', graduationDate: '',
    certifications: [], skills: [],
    workExperience: [], internship: [],
    selfSummary: '', jobTarget: '', expectedSalary: '', expectedCity: '',
    resumeText: '', updatedAt: 0
  };

  // 获取简历档案
  async function getProfile() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.profile], (res) => {
        resolve({ ...DEFAULT_PROFILE, ...(res[JT_CONFIG.storageKeys.profile] || {}) });
      });
    });
  }

  // 保存简历档案。默认按“部分更新”合并现有档案，避免设置页只编辑可见字段时
  // 清空 AI 提取的 workExperience / internship / jobTarget 及未来扩展字段。
  // opts.replace=true 仅用于彻底重置等明确需要整份覆盖的场景。
  // 同一页面内用 Promise 队列串行化 read-modify-write，避免并发部分更新互相覆盖。
  let profileSaveQueue = Promise.resolve();

  async function saveProfileLocked(profile, opts) {
    const current = opts && opts.replace ? {} : await getProfile();
    const data = { ...DEFAULT_PROFILE, ...current, ...(profile || {}), updatedAt: Date.now() };
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.profile]: data }, () => resolve(data));
    });
  }

  function saveProfile(profile, opts) {
    const task = profileSaveQueue.then(() => saveProfileLocked(profile, opts));
    profileSaveQueue = task.catch(() => undefined);
    return task;
  }

  // 持久化岗位列表
  async function persist(jobs) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.jobs]: jobs }, () => resolve(jobs));
    });
  }

  // 导出为 CSV
  function exportCSV(jobs) {
    const headers = ['标题', '公司', '地点', '薪资', '最低月薪', '最高月薪', '来源', '匹配分', '匹配原因', '状态', '链接', '记录时间', '备注'];
    const rows = jobs.map(j => [
      escapeCSV(j.title),
      escapeCSV(j.company),
      escapeCSV(j.location),
      escapeCSV(j.salaryRaw),
      j.salaryMin || '',
      j.salaryMax || '',
      escapeCSV(j.site),
      j.score || '',
      escapeCSV((j.matchReasons || []).join('; ')),
      JT_STATUS_LABELS[j.status] || j.status,
      j.url,
      new Date(j.capturedAt).toLocaleString('zh-CN'),
      escapeCSV(j.notes || '')
    ]);
    const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    return csv;
  }

  function escapeCSV(val) {
    if (val == null) return '';
    let s = String(val);
    // 防 CSV Formula Injection:Excel/表格软件会把这些前缀当公式执行。
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // 导出为 JSON
  function exportJSON(jobs) {
    return JSON.stringify(jobs, null, 2);
  }

  // 统计
  function getStats(jobs) {
    const stats = {
      total: jobs.length,
      matched: jobs.filter(j => (j.score || 0) >= 40).length,
      high: jobs.filter(j => (j.score || 0) >= 70).length,
      byStatus: {}
    };
    Object.values(JT_STATUS).forEach(s => { stats.byStatus[s] = 0; });
    jobs.forEach(j => { if (j.status && stats.byStatus.hasOwnProperty(j.status)) stats.byStatus[j.status]++; });
    return stats;
  }

  // 获取自动扫描配置(与默认合并)
  async function getAutoScan() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.autoScan], (res) => {
        const stored = res[JT_CONFIG.storageKeys.autoScan];
        const saved = stored || {};
        const merged = JTAutoScan.merge(saved);
        // 仅迁移历史内置关键词；用户自行填写的任意关键词（包括康复方向）不改动。
        if (stored && stored.keywords === LEGACY_DEFAULTS.autoScanKeywords) {
          merged.keywords = JT_CONFIG.defaultAutoScan.keywords;
          chrome.storage.local.set({ [JT_CONFIG.storageKeys.autoScan]: merged }, () => resolve(merged));
          return;
        }
        resolve(merged);
      });
    });
  }

  // 保存自动扫描配置
  async function saveAutoScan(cfg) {
    const merged = JTAutoScan.merge(cfg);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.autoScan]: merged }, () => resolve(merged));
    });
  }

  // 同一页面上下文内串行化额度占用,避免两个 Promise 同时 get 到旧值后各自 +1 覆盖。
  let analysisQuotaQueue = Promise.resolve();

  async function consumeAnalysisQuotaLocked(perDay) {
    perDay = perDay || 0;
    const cfg = await getAutoScan();
    JTAutoScan.resetDailyIfNeeded(cfg);
    const cur = cfg.analyzedToday || 0;
    if (perDay > 0 && cur >= perDay) {
      return { ok: false, reason: 'limit', analyzedToday: cur };
    }
    cfg.analyzedToday = cur + 1;
    await saveAutoScan(cfg);
    return { ok: true, analyzedToday: cfg.analyzedToday };
  }

  // 原子占每日分析额度:读最新配置 → 跨日重置 → 检查上限 → +1 → 保存。
  // chrome.storage.local 本身不提供事务,get/set 回调串行并不等于 read-modify-write 原子；
  // 因此用 Promise 队列保护同一 JTStorage 实例内的并发调用。
  function consumeAnalysisQuota(perDay) {
    const task = analysisQuotaQueue.then(() => consumeAnalysisQuotaLocked(perDay));
    analysisQuotaQueue = task.catch(() => undefined); // 单次失败不阻塞后续占额
    return task;
  }

  // 获取自定义模型名列表(按服务商分组)
  async function getCustomModels() {
    return new Promise((resolve) => {
      chrome.storage.local.get([JT_CONFIG.storageKeys.customModels], (res) => {
        resolve(res[JT_CONFIG.storageKeys.customModels] || {});
      });
    });
  }

  // 保存自定义模型名列表(按服务商分组)
  async function saveCustomModels(models) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [JT_CONFIG.storageKeys.customModels]: models }, () => resolve(models));
    });
  }

  // 添加一个自定义模型名到指定服务商的列表(去重)
  async function addCustomModel(providerKey, modelName) {
    if (!providerKey || !modelName) return;
    const all = await getCustomModels();
    if (!all[providerKey]) all[providerKey] = [];
    if (!all[providerKey].includes(modelName)) {
      all[providerKey].push(modelName);
      await saveCustomModels(all);
    }
    return all[providerKey];
  }

  return {
    getJobs, saveJob, saveJobs, deleteJob, deleteJobs, getDeletedKeys, addDeletedKeys, updateStatus, updateNotes, updateAiAnalysis, clearAll, clearDeletedJobs, resetUsageData, softResetData,
    getFilters, saveFilters, getSettings, saveSettings,
    getAiSettings, saveAiSettings, getProviderKeys, saveProviderKeys,
    getProfile, saveProfile,
    getAutoScan, saveAutoScan, consumeAnalysisQuota,
    getCustomModels, saveCustomModels, addCustomModel,
    exportCSV, exportJSON, getStats
  };
})();
