// ============================================================
// ui-utils-xss-sim.test.js — renderAiAnalysisHtml XSS 转义验证
// 验证来自 LLM 的恶意字段(fitReasons/gaps/suggestions/summary/risks)
// 经 escapeHtml 实体化,不会被注入为可执行 HTML。同时验证 fitScore 降级、
// overallRisk 映射、escapeHtml/escapeAttr/safeUrl、gap>20 提示。
// ============================================================

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

function loadSrc(rel, names = []) {
  const code = readSrc(rel);
  const expose = names.map((n) => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`).join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}

describe('ui-utils XSS 与渲染仿真', () => {
  beforeAll(() => {
    loadSrc('lib/config.js', ['JT_CONFIG']);
    loadSrc('lib/filters.js', ['JTFilters']);
    loadSrc('lib/ui-utils.js', ['JTUi']);
  });

  test('escapeHtml:转义 < > & (基于 textContent,引号在文本节点中安全保留)', () => {
    const out = JTUi.escapeHtml('<script>"&\'</script>');
    expect(out).toContain('&lt;script&gt;'); // < > 转义
    expect(out).toContain('&amp;'); // & 转义
    expect(out).not.toContain('<script'); // 无可执行标签
  });

  test('escapeAttr:转义五个危险字符', () => {
    const out = JTUi.escapeAttr('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<');
    expect(out).toContain('&lt;');
  });

  test('safeUrl:javascript:/data: 协议拦截为 #', () => {
    expect(JTUi.safeUrl('javascript:alert(1)')).toBe('#');
    expect(JTUi.safeUrl('data:text/html,<script>')).toBe('#');
    expect(JTUi.safeUrl('https://x.com')).toBe('https://x.com');
    expect(JTUi.safeUrl('http://x.com')).toBe('http://x.com');
  });

  test('renderAiAnalysisHtml:恶意 fitReasons 被转义', () => {
    const a = {
      fitScore: 80,
      fitReasons: ['<script>alert(1)</script>'],
      gaps: ['<img src=x onerror=alert(2)>'],
      suggestions: ['</div><b>注入</b>'],
      summary: '<script>steal()</script>',
      risks: [{ type: '<b>风险</b>', severity: '高', detail: 'onmouseover=alert(3)', advice: 'x' }],
      overallRisk: '高',
    };
    const html = JTUi.renderAiAnalysisHtml(a);
    // 所有恶意载荷的尖括号都应被转义成实体,无法形成可执行标签
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/<img/);
    expect(html).not.toMatch(/<b>/); // 注入的 <b> 必须被转义
    // 确认原始标签骨架被实体化
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
    // onerror/onmouseover 即使作为纯文本留存(无尖括号包裹)也无害
    expect(html).toContain('onerror');
  });

  test('renderAiAnalysisHtml:通用岗位字段全部转义并分层展示', () => {
    const html = JTUi.renderAiAnalysisHtml({
      analysisVersion: 2,
      fitScore: 68,
      relationType: '跨行可迁移',
      relationSummary: '<img src=x onerror=alert(1)>',
      recommendation: '<script>投递</script>',
      careerValue: '<b>高</b>',
      transferableStrengths: ['<svg onload=alert(2)>'],
      entryBarriers: ['</li><iframe src=x>'],
      fitReasons: [], gaps: [], suggestions: [], risks: [],
      overallRisk: '信息不足',
      summary: '需要补充信息'
    });
    expect(html).toContain('与我关系：跨行可迁移');
    expect(html).toContain('可迁移能力');
    expect(html).toContain('入门门槛');
    expect(html).toContain('ai-risk-tag-info');
    expect(html).toContain('ai-no-risk');
    expect(html).not.toMatch(/<script>|<img|<svg|<iframe|<b>/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;svg');
  });

  test('renderAiAnalysisHtml:畸形数组和风险项安全降级', () => {
    const html = JTUi.renderAiAnalysisHtml({
      analysisVersion: 2,
      fitScore: 50,
      fitReasons: 'not-array',
      transferableStrengths: null,
      entryBarriers: {},
      gaps: [], suggestions: [],
      risks: ['纯文本风险'],
      overallRisk: '未知'
    });
    expect(html).toContain('岗位风险：信息不足');
    expect(html).toContain('纯文本风险');
    expect(html).not.toContain('not-array');
  });

  test('renderAiAnalysisHtml:fitScore 非数字或越界时降级为 ?', () => {
    const htmlNum = JTUi.renderAiAnalysisHtml({ fitScore: 75, overallRisk: '低' });
    expect(htmlNum).toContain('75');

    const htmlStr = JTUi.renderAiAnalysisHtml({ fitScore: ' malicious', overallRisk: '低' });
    expect(htmlStr).toContain('?'); // 非数字降级

    const htmlUndef = JTUi.renderAiAnalysisHtml({ overallRisk: '低' });
    expect(htmlUndef).toContain('?');

    const htmlInf = JTUi.renderAiAnalysisHtml({ fitScore: Infinity, overallRisk: '低' });
    expect(htmlInf).toContain('?');

    const htmlOver = JTUi.renderAiAnalysisHtml({ fitScore: 101, overallRisk: '低' });
    expect(htmlOver).toContain('?');
  });

  test('renderAiAnalysisHtml:overallRisk 高/中/低/未知 映射 risk class', () => {
    expect(JTUi.renderAiAnalysisHtml({ fitScore: 1, overallRisk: '高' })).toContain('ai-risk-tag-high');
    expect(JTUi.renderAiAnalysisHtml({ fitScore: 1, overallRisk: '中' })).toContain('ai-risk-tag-medium');
    expect(JTUi.renderAiAnalysisHtml({ fitScore: 1, overallRisk: '低' })).toContain('ai-risk-tag-low');
    expect(JTUi.renderAiAnalysisHtml({ fitScore: 1, overallRisk: '未知' })).toContain('ai-risk-tag-info');
  });

  test('renderAiAnalysisHtml:两维度 gap>20 输出 gap 提示', () => {
    const html = JTUi.renderAiAnalysisHtml({ fitScore: 90, overallRisk: '低' }, 50); // 差 40
    expect(html).toContain('ai-gap-hint');
  });

  test('renderAiAnalysisHtml:gap<=20 不输出提示', () => {
    const html = JTUi.renderAiAnalysisHtml({ fitScore: 80, overallRisk: '低' }, 70); // 差 10
    expect(html).not.toContain('ai-gap-hint');
  });

  test('renderAiAnalysisHtml:本地分维度(localScore)渲染块状', () => {
    const html = JTUi.renderAiAnalysisHtml({ fitScore: 80, overallRisk: '低' }, 80);
    expect(html).toContain('硬性匹配度');
    expect(html).toContain('ai-score-val');
  });
});
