// 防回归:页面必须加载其所依赖的 lib 脚本,否则会像 v1.5.32 之前那样,
// settings.html 漏加载 autoscan.js 导致重置时 JTAutoScan 为 undefined、resetUsageData 抛错中断。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function scriptsOf(htmlFile) {
  const html = fs.readFileSync(path.join(root, htmlFile), 'utf8');
  const re = /<script\s+src=["']([^"']+)["']/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

describe('页面脚本加载完整性', () => {
  test('settings.html 必须加载 config + autoscan + storage', () => {
    const s = scriptsOf('settings/settings.html');
    expect(s).toContain('../lib/config.js');
    // v1.5.32 修复:此前漏加载 autoscan.js,导致重置时 JTAutoScan 为 undefined、抛错中断
    expect(s).toContain('../lib/autoscan.js');
    expect(s).toContain('../lib/storage.js');
    // 顺序:autoscan 依赖 config,必须在 config 之后
    expect(s.indexOf('../lib/config.js')).toBeLessThan(s.indexOf('../lib/autoscan.js'));
  });

  test('autoscan.html 必须加载 config + autoscan + storage', () => {
    const s = scriptsOf('settings/autoscan.html');
    expect(s).toContain('../lib/config.js');
    expect(s).toContain('../lib/autoscan.js');
    expect(s).toContain('../lib/storage.js');
  });

  test('popup.html / dashboard.html 必须加载 storage', () => {
    expect(scriptsOf('popup/popup.html')).toContain('../lib/storage.js');
    expect(scriptsOf('dashboard/dashboard.html')).toContain('../lib/storage.js');
  });
});
