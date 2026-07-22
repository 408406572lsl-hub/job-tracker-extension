// ============================================================
// scan-controller.js — 前端扫描控制器
// 在 dashboard / popup 等常驻前端页面中运行
// 持有扫描循环(真实的 await delay,在页面 JS 里跑,不会被 SW 杀)
// 编排:换关键词 → 开可见 tab 加载搜索 URL →
//   发 JT_SCAN_PAGE → 收 jobs → JTStorage 存 →
//   可选 enrich/analyze → 更新进度 → 下一关键词
// ============================================================

(function (root) {
  'use strict';

  // 延迟工具(前端页面上下文,不会被系统杀)
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }

  // 扫描状态
  let running = false;
  let stopped = false;
  let progressCb = null;

  // 是否正在扫描
  function isRunning() { return running; }

  // 注册进度回调
  function onProgress(cb) { progressCb = cb; }

  // 报告进度
  function report(progress) {
    if (progressCb) {
      try { progressCb(progress); } catch (e) { /* 回调异常不影响扫描 */ }
    }
  }

  // 停止扫描
  function stop() { stopped = true; }

  // ----------------------------------------------------------
  // 工具:打开可见 tab 并等待加载
  // ----------------------------------------------------------
  function openVisibleTab(url) {
    return new Promise((resolve) => {
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.id == null) {
          resolve(null);
          return;
        }
        resolve(tab);
      });
    });
  }

  // 等待 tab 页面加载完成(content script 就绪)
  function waitForLoad(tabId, minWait) {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = () => { if (!resolved) { resolved = true; resolve(); } };
      // 最少等待 minWait 毫秒(让 SPA 渲染)
      setTimeout(finish, minWait || 3000);
    });
  }

  // 向 tab 发消息(带超时)
  function sendToTab(tabId, msg, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish(null), timeoutMs || 25000);
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { finish(null); return; }
        finish(res);
      });
    });
  }

  // 向 background 发消息
  function sendToBg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res);
      });
    });
  }

  // 关闭 tab
  function closeTab(tabId) {
    try { chrome.tabs.remove(tabId); } catch (e) { /* ignore */ }
  }

  // ----------------------------------------------------------
  // 检查是否有下一页(在 content script 中执行)
  // ----------------------------------------------------------
  async function hasNextPage(tabId) {
    const res = await sendToTab(tabId, { type: 'JT_SCAN_HAS_NEXT' }, 10000);
    return !!(res && res.ok && res.hasNext);
  }

  // 跳到下一页(在 content script 中执行)
  async function gotoNextPage(tabId) {
    const res = await sendToTab(tabId, { type: 'JT_SCAN_NEXT_PAGE' }, 10000);
    if (res && res.ok) {
      await delay(rand(1200, 2200)); // 等页面渲染
    }
    return !!(res && res.ok);
  }

  // ----------------------------------------------------------
  // 采集单页岗位
  // ----------------------------------------------------------
  async function collectPage(tabId) {
    const res = await sendToTab(tabId, { type: 'JT_SCAN_PAGE' }, 25000);
    if (!res || !res.ok) return [];
    return res.jobs || [];
  }

  // ----------------------------------------------------------
  // 补全详情(开可见 tab 抓 JD)
  // ----------------------------------------------------------
  async function enrichJob(job) {
    if (!job || !job.url) return job;
    const tab = await openVisibleTab(job.url);
    if (!tab) return job;
    try {
      await waitForLoad(tab.id, 3500);
      const res = await sendToTab(tab.id, { type: 'JT_GET_PAGE_JOB' }, 30000);
      if (res && res.job) {
        // 合并详情字段(保留原始 url/id)
        return Object.assign({}, job, {
          description: res.job.description || job.description,
          requirement: res.job.requirement || job.requirement,
          salaryRaw: res.job.salaryRaw || job.salaryRaw,
          salaryMin: res.job.salaryMin || job.salaryMin,
          salaryMax: res.job.salaryMax || job.salaryMax,
        });
      }
      return job;
    } finally {
      // 页面加载/消息异常也必须关闭详情 tab,避免扫描失败后遗留标签页。
      closeTab(tab.id);
    }
  }

  // ----------------------------------------------------------
  // 启动扫描
  // cfg: 自动扫描配置(从 JTStorage.getAutoScan 获取)
  // ----------------------------------------------------------
  async function start(cfg) {
    if (running) return { ok: false, error: '扫描正在进行中' };
    running = true;
    stopped = false;

    // 提升到 try 块外,使 finally 能访问(异常时也保存已分析计数)
    let totalAdded = 0;
    let analyzedToday = cfg.analyzedToday || 0;

    try {
      // 跨日重置当日分析计数
      JTAutoScan.resetDailyIfNeeded(cfg);

      const urls = JTAutoScan.buildBossSearchUrls(cfg);
      const maxPer = cfg.maxPerScan || 20;
      const maxJobs = cfg.maxJobsPerRun || 0; // 0 = 不限制
      const maxPages = 5; // 每个关键词最多翻 5 页

      for (let i = 0; i < urls.length; i++) {
        if (stopped) break;
        const url = urls[i];

        report({ phase: 'loading', keyword: url, page: 0, added: 0, total: totalAdded });

        // 开可见 tab 加载搜索页
        const tab = await openVisibleTab(url);
        if (!tab) {
          report({ phase: 'error', error: '无法打开搜索页', url });
          continue;
        }

        try {
          await waitForLoad(tab.id, 3000);

          let page = 1;
          let keywordAdded = 0;

          while (page <= maxPages && !stopped) {
            report({ phase: 'collecting', page, added: keywordAdded, total: totalAdded });

            // 采集当前页
            const cards = await collectPage(tab.id);
            if (!cards || cards.length === 0) {
              break; // 无更多岗位
            }

            const norm = JTAutoScan.normalizeCollected(cards);

            // 把当前页所有卡片都送去重——不再按剩余配额预切片。
            // saveJobs 内部用 jobKey 去重,已存在的只更新不计数。
            // 预切片会导致"恰好前 N 张都是重复,后面有新的却被丢弃"的 bug。
            const saved = await JTStorage.saveJobs(norm.slice(0, maxPer), { respectTombstone: true });
            totalAdded += saved.added;
            keywordAdded += saved.added;

            report({
              phase: 'page_done',
              page,
              pageCollected: cards.length,
              pageAdded: saved.added,
              added: keywordAdded,
              total: totalAdded,
              capReached: maxJobs > 0 && totalAdded >= maxJobs
            });

            // 补全详情:仅对实际新增数量的岗位执行
            if (cfg.enrichDetails && saved.added > 0) {
              let enriched = 0;
              for (const j of norm) {
                if (stopped || enriched >= saved.added) break;
                const detailed = await enrichJob(j);
                if (detailed && (detailed.description || detailed.requirement)) {
                  await JTStorage.saveJob(detailed, { respectTombstone: true });
                  enriched++;
                }
                await delay(rand(1200, 2200));
              }
            }

            // 自动 AI 分析:对本页岗位执行(逐个原子占额度,占满即停,根治与手动分析并发竞态)
            if (cfg.autoAnalyze && saved.added > 0) {
              const perDay = cfg.analyzePerDay || 0;
              const toAnalyze = JTAutoScan.pickJobsForAnalysis(norm, cfg, analyzedToday);
              for (const j of toAnalyze) {
                if (stopped) break;
                const q = await JTStorage.consumeAnalysisQuota(perDay);
                if (!q.ok) break; // 已达上限(含并发手动分析已占满)
                analyzedToday = q.analyzedToday; // 同步内存仅用于 report
                report({ phase: 'analyzing', job: j.title, analyzedToday });
                const res = await sendToBg({ type: 'JT_LLM_ANALYZE', job: j, force: !!cfg.forceAnalyze });
                if (!res || !res.ok) break;
                await delay(rand(800, 1600));
              }
            }

            // 达到上限则停止(允许微量超量,不再翻到下一页)
            if (maxJobs > 0 && totalAdded >= maxJobs) {
              stopped = true;
            }

            // 翻页
            if (stopped) break;
            const hasNext = await hasNextPage(tab.id);
            if (!hasNext) break;
            const went = await gotoNextPage(tab.id);
            if (!went) break;
            page++;
          }
        } finally {
          // 无论正常结束还是异常,都关闭搜索 tab,避免泄漏
          closeTab(tab.id);
        }

        // 关键词之间随机延迟
        if (i < urls.length - 1 && !stopped) {
          await delay(rand(1200, 2200));
        }
      }

      // 通知完成
      report({ phase: 'done', added: totalAdded, total: cfg.totalCollected });

      // 发通知
      try {
        const title = totalAdded > 0 ? '岗位猎手:自动扫描 +' + totalAdded : '岗位猎手:自动扫描完成';
        const msg = totalAdded > 0
          ? '本轮新增 ' + totalAdded + ' 个岗位(累计自动采集 ' + (cfg.totalCollected || 0) + ')'
          : '本轮无新岗位(可能已记录或页面需登录)';
        sendToBg({ type: 'JT_NOTIFY', title, message: msg });
      } catch (e) { /* ignore */ }

      return { ok: true, added: totalAdded };
    } catch (e) {
      report({ phase: 'error', error: String(e) });
      return { ok: false, error: String(e) };
    } finally {
      // 只合并本轮统计,不要用扫描开始时的旧 cfg 覆盖期间被设置页/额度占用更新的配置。
      // analyzedToday 已由 consumeAnalysisQuota 实时持久化,这里以最新存储值为准。
      const finishedAt = Date.now();
      try {
        const latest = await JTStorage.getAutoScan();
        const merged = Object.assign({}, latest, {
          lastScanAt: finishedAt,
          lastScanAdded: totalAdded,
          totalCollected: Math.max(latest.totalCollected || 0, cfg.totalCollected || 0) + totalAdded
        });
        await JTStorage.saveAutoScan(merged);
        // 保持调用方持有的 cfg 统计字段同步,不反向覆盖其它设置。
        cfg.lastScanAt = merged.lastScanAt;
        cfg.lastScanAdded = merged.lastScanAdded;
        cfg.totalCollected = merged.totalCollected;
        cfg.analyzedToday = merged.analyzedToday;
      } catch (e) { /* 保存失败不阻塞 */ }
      running = false;
    }
  }

  // ----------------------------------------------------------
  // 导出
  // ----------------------------------------------------------
  const JTScanController = {
    start,
    stop,
    isRunning,
    onProgress,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = JTScanController;
  if (root) root.JTScanController = JTScanController;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
