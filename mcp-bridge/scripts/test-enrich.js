// 临时验证脚本:连天眼AI,打印真实 tool 名与一次 enrich 结果
'use strict';
const { CompanyEnricher } = require('../company-enricher.js');

(async () => {
  const e = new CompanyEnricher();
  await e.init();
  console.log('=== TOOLS ===');
  console.log(e.tools.map(t => t.name + ' :: ' + JSON.stringify(Object.keys((t.inputSchema || {}).properties || {}))).join('\n'));
  console.log('=== toolMap ===');
  console.log(JSON.stringify(e.toolMap, null, 2));
  console.log('=== ENRICH 示例健康科技有限公司 ===');
  const r = await e.enrich('示例健康科技有限公司', { city: '南宁', jobIndustry: '康复治疗' });
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(err => {
  console.error('ERR', err);
  process.exit(1);
});
