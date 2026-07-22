// ============================================================
// settings-model-input-sim.test.js — AI 设置页模型字段 input 化回归
// v1.5.52 起,模型字段由 <select> 改为 <input type="text" list="modelList"> +
// <datalist>,用户可直接键入任意模型名,不再走 __custom__ 哨兵 + prompt 弹窗。
// 本测试从源码字符串断言核心行为点,与 html-scripts.test.js 风格一致(不引 jsdom)。
// 覆盖:
//   · settings.html 模型字段为 input + datalist,不再有 <select id="model">
//   · settings.js 不再含 __custom__ 哨兵 / window.prompt 调用
//   · settings.js 含 renderModelList(操作 datalist)、input 事件监听
//   · settings.js 在 save/testConnection 中调用 addCustomModel 持久化自定义模型
// v1.5.53 新增(修复"自定义模型保存不了"):
//   · 大模型接入卡片内联「保存配置」按钮(btnSaveInline)绑定 save()
//   · provider 切换时模型 input「非空保留」(不再无条件清空用户输入)
//   · model input blur 时即时 addCustomModel(自定义模型名即时进 datalist)
// ============================================================

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

describe('AI 设置页模型字段 input 化(v1.5.52+)', () => {
  const html = readSrc('settings/settings.html');
  const js = readSrc('settings/settings.js');

  test('settings.html:模型字段为 <input type="text" list="modelList"> + <datalist>', () => {
    // 不应再有 <select id="model">
    expect(html).not.toMatch(/<select[^>]*id=["']model["']/);
    // 应有 input + datalist
    expect(html).toMatch(/<input[^>]*id=["']model["'][^>]*list=["']modelList["']/);
    expect(html).toMatch(/<datalist[^>]*id=["']modelList["']/);
  });

  test('settings.html:label 含可输入提示', () => {
    // label for="model" 应含"可直接输入"或类似提示
    const labelMatch = html.match(/<label[^>]*for=["']model["'][^>]*>([\s\S]*?)<\/label>/);
    expect(labelMatch).toBeTruthy();
    expect(labelMatch[1]).toMatch(/可直接输入|可输入|直接输入/);
  });

  test('settings.js:不再含 __custom__ 哨兵 / prompt 弹窗', () => {
    expect(js).not.toContain('__custom__');
    // 旧的 prompt('请输入模型名 调用应已删除
    expect(js).not.toMatch(/prompt\(['"]请输入模型名/);
  });

  test('settings.js:含 renderModelList 函数(操作 datalist)', () => {
    expect(js).toMatch(/function\s+renderModelList\s*\(/);
    // renderModelList 应使用 getElementById('modelList')
    expect(js).toMatch(/getElementById\(['"]modelList['"]\)/);
  });

  test('settings.js:不再含 renderModels 函数(旧 select 版)', () => {
    // 旧函数名不应出现(避免新旧并存)
    expect(js).not.toMatch(/function\s+renderModels\s*\(/);
  });

  test('settings.js:model 元素监听 input 事件(非 change/__custom__ 分支)', () => {
    // 应有 input 事件监听
    expect(js).toMatch(/getElementById\(['"]model['"]\)\.addEventListener\(['"]input['"]/);
    // 不应有 __custom__ 分支判断
    expect(js).not.toMatch(/e\.target\.value\s*===\s*['"]__custom__['"]/);
  });

  test('settings.js:fillForm 调 renderModelList 并直接设 input.value', () => {
    // fillForm 应调用 renderModelList(无第二个参数)
    expect(js).toMatch(/renderModelList\(settings\.provider\)/);
    // 应直接设 input.value(而非依赖 select.value 兜底)
    expect(js).toMatch(/getElementById\(['"]model['"]\)\.value\s*=\s*settings\.model/);
  });

  test('settings.js:provider 切换时调 renderModelList + 设 input.value', () => {
    // provider change 回调里应调 renderModelList(newKey)
    expect(js).toMatch(/renderModelList\(newKey\)/);
    // 切换后设 model input 为 curModel || newModelVal(非空保留用户输入)
    expect(js).toMatch(/getElementById\(['"]model['"]\)\.value\s*=\s*curModel\s*\|\|\s*newModelVal/);
  });

  test('settings.js:save() 中调 addCustomModel 持久化非预设模型', () => {
    // save 函数应含 addCustomModel 调用
    expect(js).toMatch(/addCustomModel\(data\.provider,\s*data\.model\)/);
  });

  test('settings.js:testConnection() 也持久化自定义模型(与 save 对齐)', () => {
    expect(js).toMatch(/addCustomModel\(current\.provider,\s*current\.model\)/);
  });

  test('settings.js:updateModelHint 不含 __custom__ 判断', () => {
    // 旧逻辑:if (model && model !== '__custom__' && ...) — 应已删除 __custom__ 判断
    expect(js).not.toMatch(/model\s*!==\s*['"]__custom__['"]/);
  });
});

describe('AI 设置页模型字段保存可达性(v1.5.53 修复)', () => {
  const html = readSrc('settings/settings.html');
  const js = readSrc('settings/settings.js');

  test('settings.html:大模型接入卡片内含有「保存配置」内联按钮(btnSaveInline)', () => {
    expect(html).toMatch(/id=["']btnSaveInline["']/);
    expect(html).toMatch(/btnSaveInline["'][^>]*>保存配置/);
  });

  test('settings.js:btnSaveInline 绑定 save()(与底部 btnSave 共用)', () => {
    // 应先 getElementById('btnSaveInline') 取到变量,再 bind click → save
    expect(js).toMatch(/getElementById\(['"]btnSaveInline['"]\)/);
    expect(js).toMatch(/btnSaveInline\.addEventListener\(['"]click['"],\s*save\)/);
  });

  test('settings.js:provider 切换时模型 input「非空保留」(不再无条件清空)', () => {
    // 应先用 getElementById('model').value.trim() 取值到 curModel
    expect(js).toMatch(/const curModel\s*=\s*document\.getElementById\(['"]model['"]\)\.value\.trim\(\)/);
    // 再 curModel || newModelVal(空才填默认),而非直接覆盖
    expect(js).toMatch(/getElementById\(['"]model['"]\)\.value\s*=\s*curModel\s*\|\|\s*newModelVal/);
    // 不应存在无条件覆盖(旧版:document.getElementById('model').value = newModelVal;)
    expect(js).not.toMatch(/getElementById\(['"]model['"]\)\.value\s*=\s*newModelVal\s*;/);
  });

  test('settings.js:model input blur 时即时 addCustomModel + 重新渲染 datalist + 自动落盘 model', () => {
    // 应监听 blur 事件
    expect(js).toMatch(/getElementById\(['"]model['"]\)\.addEventListener\(['"]blur['"]/);
    // blur 回调里应调 addCustomModel(provider, m) 把自定义模型持久化
    expect(js).toMatch(/addCustomModel\(provider,\s*m\)/);
    // 关键点:addCustomModel 后必须重新渲染 datalist,否则下拉箭头(三角形)点了没反应
    expect(js).toMatch(/await renderModelList\(provider\)/);
    // 关键点:失焦即把 model 落到 aiSettings(无需点保存),修复"本次模型保存不住"
    expect(js).toMatch(/await JTStorage\.saveAiSettings\(data\)/);
    expect(js).toMatch(/data\.model\s*!==\s*\(settings && settings\.model\)/);
  });

  test('settings.js:save() 内联反馈区 saveResultInline 同步更新', () => {
    expect(js).toMatch(/getElementById\(['"]saveResultInline['"]\)/);
  });
});


describe('AI 设置页模型字段 input 化 — 不破坏现有架构', () => {
  const html = readSrc('settings/settings.html');
  const js = readSrc('settings/settings.js');

  test('settings.html:仍加载 config/autoscan/storage 脚本(未误删)', () => {
    expect(html).toContain('../lib/config.js');
    expect(html).toContain('../lib/autoscan.js');
    expect(html).toContain('../lib/storage.js');
  });

  test('settings.js:collect() 仍收集 model 字段(input.value 与 select.value 同效)', () => {
    expect(js).toMatch(/model:\s*document\.getElementById\(['"]model['"]\)\.value/);
  });

  test('settings.js:provider 下拉仍是 <select>(只改 model,不动 provider)', () => {
    // renderProviders 仍操作 <select id="provider">
    expect(js).toMatch(/getElementById\(['"]provider['"]\)/);
  });
});
