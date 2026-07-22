// ============================================================
// form-filler-sim.test.js — 申请表单自动填充仿真
// 用 jsdom 构建真实表单 DOM,桩接 getComputedStyle / getBoundingClientRect,
// 覆盖:detectForms / findFillableFields / fillForm(含 select·textarea·checkbox) /
//   injectFillButton / isAgreementCheckbox(条款框判定)。
// 不依赖真实页面,所有可见性判定由测试桩控。
// ============================================================

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

function loadSrc(rel, names = []) {
  const code = readSrc(rel);
  const expose = names
    .map((n) => `globalThis.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`)
    .join('\n');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n' + expose);
}

// 让所有元素"可见":getBoundingClientRect 返回非零尺寸,getComputedStyle 返正常样式
function stubVisibility() {
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 24, top: 0, left: 0, right: 100, bottom: 24, x: 0, y: 0 };
  };
  window.getComputedStyle = function () {
    return { display: 'block', visibility: 'visible', opacity: '1' };
  };
  // jsdom 可能未实现 CSS.escape(form-filler 的 label 关联分支会用到)
  if (typeof window.CSS === 'undefined') window.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
  else if (typeof window.CSS.escape !== 'function') window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

beforeEach(() => {
  // 重置 DOM
  document.body.innerHTML = '';
  stubVisibility();
  loadSrc('lib/form-filler.js', ['JTFormFiller']);
});

afterEach(() => {
  delete global.JTFormFiller;
});

describe('P5 · 申请表单自动填充仿真', () => {
  // ---------- detectForms ----------
  test('detectForms 找到含多字段的 form', () => {
    document.body.innerHTML = `
      <form id="apply">
        <input name="name" placeholder="姓名">
        <input name="phone" placeholder="电话">
        <input name="email" placeholder="邮箱">
        <button>提交</button>
      </form>`;
    const forms = JTFormFiller.detectForms();
    expect(forms.length).toBe(1);
    expect(forms[0].type).toBe('form');
    expect(forms[0].fields.length).toBeGreaterThanOrEqual(3);
  });

  test('detectForms 找不到字段过少的 form', () => {
    document.body.innerHTML = `
      <form id="search"><input name="q" placeholder="搜索"><button>搜</button></form>`;
    const forms = JTFormFiller.detectForms();
    expect(forms.length).toBe(0);
  });

  test('detectForms 无 form 但大量输入框(SPA 区域)也能识别', () => {
    document.body.innerHTML = `
      <div id="root">
        <input name="name" placeholder="姓名">
        <input name="phone" placeholder="电话">
        <input name="email" placeholder="邮箱">
        <input name="school" placeholder="学校">
      </div>`;
    const forms = JTFormFiller.detectForms();
    expect(forms.length).toBe(1);
    expect(forms[0].type).toBe('section');
  });

  // ---------- findFillableFields ----------
  test('findFillableFields 按规则识别 姓名/电话/邮箱', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input name="name" placeholder="姓名">
      <input name="phone" placeholder="电话">
      <input name="email" placeholder="邮箱">`;
    document.body.appendChild(form);
    const fields = JTFormFiller.findFillableFields(form);
    const keys = fields.map((f) => f.profileKey);
    expect(keys).toContain('name');
    expect(keys).toContain('phone');
    expect(keys).toContain('email');
  });

  test('findFillableFields 通过 label 关键词匹配字段', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <label for="xm">姓名</label><input id="xm">
      <label for="tel">手机号</label><input id="tel">`;
    document.body.appendChild(form);
    const fields = JTFormFiller.findFillableFields(form);
    const keys = fields.map((f) => f.profileKey);
    expect(keys).toContain('name');
    expect(keys).toContain('phone');
  });

  // ---------- fillForm ----------
  test('fillForm 用档案填充文本框 / textarea', () => {
    document.body.innerHTML = `
      <form id="apply">
        <input name="name">
        <input name="phone">
        <input name="email">
        <textarea name="summary" placeholder="自我介绍"></textarea>
      </form>`;
    const profile = {
      name: '测试用户', phone: '13800000000', email: 'z@test.com',
      selfSummary: '康复治疗技术专业,熟练掌握 PT/OT。'
    };
    const res = JTFormFiller.fillForm(profile);
    expect(res.filled).toBe(4);
    expect(res.skipped).toBe(0);
    expect(document.querySelector('input[name="name"]').value).toBe('测试用户');
    expect(document.querySelector('input[name="phone"]').value).toBe('13800000000');
    expect(document.querySelector('input[name="email"]').value).toBe('z@test.com');
    expect(document.querySelector('textarea[name="summary"]').value).toBe('康复治疗技术专业,熟练掌握 PT/OT。');
  });

  test('fillForm 档案缺字段时 skip 并记原因', () => {
    document.body.innerHTML = `
      <form id="apply"><input name="name"><input name="phone"></form>`;
    const res = JTFormFiller.fillForm({ name: '测试用户' }); // 无 phone
    expect(res.filled).toBe(1);
    expect(res.skipped).toBe(1);
    const skip = res.details.find((d) => d.status === 'skip');
    expect(skip.reason).toContain('档案中无此信息');
  });

  test('fillForm 填充 select(学历)做选项匹配', () => {
    document.body.innerHTML = `
      <form id="apply">
        <input name="name" placeholder="姓名">
        <select name="education">
          <option value="">请选择</option>
          <option value="college">大专</option>
          <option value="bachelor">本科</option>
        </select>
      </form>`;
    const res = JTFormFiller.fillForm({ name: '测试用户', education: '大专' });
    expect(res.filled).toBe(2);
    expect(document.querySelector('select[name="education"]').value).toBe('college');
  });

  test('fillForm 数组字段(技能)拼接为顿号分隔', () => {
    document.body.innerHTML = `
      <form id="apply">
        <input name="name" placeholder="姓名">
        <input name="major" placeholder="专业">
      </form>`;
    const res = JTFormFiller.fillForm({ name: '测试用户', major: ['康复治疗', '运动康复'] });
    expect(res.filled).toBe(2);
    expect(document.querySelector('input[name="major"]').value).toBe('康复治疗、运动康复');
  });

  // ---------- checkbox 处理行为 ----------
  // 修复后:fillForm 在主循环外独立扫描表单内复选框,
  //   命中「同意条款/隐私政策」类的才自动勾选,业务 checkbox(如接收营销)不误勾。
  test('fillForm 自动勾选「同意条款」类 checkbox,不误勾业务 checkbox', () => {
    document.body.innerHTML = `
      <form id="apply">
        <input name="name" placeholder="姓名">
        <input name="phone" placeholder="电话">
        <input type="checkbox" id="agree"><label for="agree">我已阅读并同意隐私政策</label>
        <input type="checkbox" id="market"><label for="market">接收营销信息</label>
      </form>`;
    const res = JTFormFiller.fillForm({ name: '测试用户', phone: '13800000000' });
    // 2 个文本字段 + 1 个同意条款 checkbox = 3
    expect(res.filled).toBe(3);
    expect(document.querySelector('input[name="name"]').value).toBe('测试用户');
    // 同意条款类 → 自动勾选
    expect(document.getElementById('agree').checked).toBe(true);
    // 业务 checkbox(无同意/协议关键词)→ 不误勾
    expect(document.getElementById('market').checked).toBe(false);
  });

  test('fillForm 对"接受夜班安排"等非条款 checkbox 保持不勾', () => {
    document.body.innerHTML = `
      <form id="apply">
        <input name="name" placeholder="姓名">
        <input name="phone" placeholder="电话">
        <input type="checkbox" id="shift"><label for="shift">接受夜班安排</label>
      </form>`;
    const res = JTFormFiller.fillForm({ name: '测试用户', phone: '13800000000' });
    expect(document.getElementById('shift').checked).toBe(false);
    // 只有 2 个文本字段被填充,checkbox 不计入
    expect(res.filled).toBe(2);
  });

  // ---------- injectFillButton ----------
  test('injectFillButton 在有表单时注入按钮,点击触发 onFill', () => {
    document.body.innerHTML = `
      <form id="apply"><input name="name" placeholder="姓名"><input name="phone" placeholder="电话"></form>`;
    let clicked = false;
    JTFormFiller.injectFillButton({ name: '测试用户' }, () => { clicked = true; });
    const btn = document.getElementById('jt-fill-btn');
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(clicked).toBe(true);
  });

  test('injectFillButton 无表单时不注入按钮', () => {
    document.body.innerHTML = `<div><p>没有表单</p></div>`;
    JTFormFiller.injectFillButton({ name: '测试用户' }, () => {});
    expect(document.getElementById('jt-fill-btn')).toBeNull();
  });

  test('removeFillButton 移除已注入按钮', () => {
    document.body.innerHTML = `
      <form id="apply"><input name="name" placeholder="姓名"><input name="phone" placeholder="电话"></form>`;
    JTFormFiller.injectFillButton({ name: '测试用户' }, () => {});
    expect(document.getElementById('jt-fill-btn')).not.toBeNull();
    JTFormFiller.removeFillButton();
    expect(document.getElementById('jt-fill-btn')).toBeNull();
  });
});
