// ============================================================
// setup.js — Jest 测试环境初始化
// 在 jsdom 环境下加载源码文件,提供 JT_CONFIG 等全局对象
// ============================================================

const fs = require('fs');
const path = require('path');

// jsdom 环境默认未提供 TextDecoder/TextEncoder(浏览器/Node 原生具备),
// 补全以匹配真实运行环境(SSE 解析等依赖 TextDecoder)。
const { TextDecoder, TextEncoder } = require('util');
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;

const rootDir = path.join(__dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(rootDir, rel), 'utf8');

// 在当前 realm 的全局作用域执行源码,并显式把顶层 const 暴露到 globalThis。
// 说明:源码用 `const X = ...` 声明顶层变量,这些声明不会自动成为全局对象的属性,
// 必须在同一段执行代码的末尾显式赋值 `globalThis.X = X`。
// 用间接 eval (0, eval) 确保在全局作用域执行,使 const 与赋值处于同一作用域。
// 注:vm.runInThisContext / Module._compile 虽能关联 filename 用于 V8 覆盖率,
//   但在 jest jsdom 环境下无法访问 jest 注入的 globalThis 上的 jsdom 全局变量(document 等),
//   会导致源码加载失败。因此仍用 (0, eval),覆盖率配置已就绪,迁移到 ES Module 后自动生效。
function loadSrc(rel, exportNames = []) {
  const code = readSrc(rel);
  const expose = exportNames
    .map(n => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
    .join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}

// 先加载 config.js(提供 JT_CONFIG / JT_STATUS / JT_STATUS_LABELS / JT_Utils)
loadSrc('lib/config.js', ['JT_CONFIG', 'JT_STATUS', 'JT_STATUS_LABELS', 'JT_Utils']);

// 再加载 filters.js(提供 JTFilters,依赖 JT_CONFIG)
loadSrc('lib/filters.js', ['JTFilters']);

// parser.js 在加载时会访问 location/document,jsdom 已提供这些全局对象
// 但 parser.js 内部有大量 DOM 操作,加载本身是安全的(IIFE 不立即执行 DOM 访问)
loadSrc('lib/parser.js', ['JTParser']);

// diagnostic.js 依赖 JTParser 公开 API,必须在 parser.js 之后加载
// 它把方法挂到 globalThis.JTParser 上,无需额外导出
loadSrc('lib/diagnostic.js', []);

// autoscan.js:自动扫描纯逻辑(依赖 JT_CONFIG)
loadSrc('lib/autoscan.js', ['JTAutoScan']);

// analyze-helper.js:AI 分析共享辅助(依赖 JTStorage / JTAutoScan,但测试中需 mock)
loadSrc('lib/analyze-helper.js', ['JTAnalyzeHelper']);

// 暴露给测试用例
global.fs = fs;
global.path = path;
global.readSrc = readSrc;
