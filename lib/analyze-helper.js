// ============================================================
// analyze-helper.js — AI 分析共享辅助模块
// 供 popup / dashboard / 导入功能三处复用
// 职责:单岗位分析消息封装 + 「保存/导入即自动分析」(受 autoAnalyze 开关 + analyzePerDay 日上限约束)
// 依赖:JTStorage(读配置/写分析结果)、JTAutoScan(跨日重置/日上限判断)
// 注意:本模块运行在前端页面(popup/dashboard),能用 JTStorage;
//   实际 LLM 调用由 background.js 的 JT_LLM_ANALYZE 处理(含 persistAiScore 写回)
// ============================================================

(function (root) {
  'use strict';

  const JTAnalyzeHelper = {};

  // 单岗位分析(发消息给 background,返回 Promise)
  // 复用后台 JT_LLM_ANALYZE;background 的 analyzeJob 内部会 persistAiScore 写回存储
  JTAnalyzeHelper.analyzeOne = function (job, force) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'JT_LLM_ANALYZE', job: job, force: !!force },
          (res) => {
            if (chrome.runtime.lastError || !res) resolve(null);
            else resolve(res);
          }
        );
      } catch (e) {
        resolve(null);
      }
    });
  };

  // 「保存/导入即自动分析」:检查 autoAnalyze 开关 + 日上限,通过则分析
  // 失败静默(不抛错),返回 { analyzed, reason, analysis }
  // analyzed=true 表示本次已调用 AI 分析(无论成功失败);analyzed=false 表示被拦截未调用
  JTAnalyzeHelper.maybeAutoAnalyze = async function (job) {
    if (!job) return { analyzed: false, reason: '无岗位对象' };
    try {
      const cfg = await JTStorage.getAutoScan();
      // 开关关闭 → 不分析
      if (!cfg || !cfg.autoAnalyze) {
        return { analyzed: false, reason: 'autoAnalyze 未开启' };
      }
      const perDay = cfg.analyzePerDay || 0;
      // 先原子占额度:占到才分析,确保与扫描并发时不超每日上限(失败不退额度,最坏多算一次)
      const q = await JTStorage.consumeAnalysisQuota(perDay);
      if (!q.ok) {
        return { analyzed: false, reason: '已达每日分析上限(' + perDay + ')' };
      }

      // 延时 1.2s 再发,避免与保存操作抢资源 + 降低 API 限频风险
      await new Promise(r => setTimeout(r, 1200));

      const res = await JTAnalyzeHelper.analyzeOne(job, false);
      if (res && res.ok && res.analysis && typeof res.analysis.fitScore === 'number') {
        return { analyzed: true, reason: 'ok', analysis: res.analysis, cached: !!res.cached };
      }
      // 分析失败(无 API Key / 模型异常等)→ 静默,仅记录原因
      const reason = res ? (res.error || '分析未返回有效结果') : '无响应';
      return { analyzed: true, reason: reason };
    } catch (e) {
      return { analyzed: false, reason: String(e) };
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = JTAnalyzeHelper;
  if (root) root.JTAnalyzeHelper = JTAnalyzeHelper;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
