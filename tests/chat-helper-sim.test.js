// ============================================================
// chat-helper-sim.test.js — BOSS 聊天页半自动回复辅助仿真
// 用 jsdom 构建聊天页 DOM,桩接 getBoundingClientRect 控制可见性,
// 覆盖:isBossChatPage / extractChatContext(区分 HR 与 自己) /
//   fillChatInput(textarea / contenteditable) / getChatDebugInfo / isOtherMessage。
// 不触网:extractJobInfo 的 fetch 分支不在此套件覆盖(另见 background-llm 仿真)。
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

beforeEach(() => {
  document.body.innerHTML = '';
  // 可见性:getBoundingClientRect 返回非零尺寸
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40, x: 0, y: 0 };
  };
  // jsdom 默认 location 不易改,这里统一劫持为 BOSS 聊天页
  Object.defineProperty(window, 'location', {
    value: { href: 'https://www.zhipin.com/web/geek/chat/12345' },
    configurable: true
  });
  // jsdom 未必实现 execCommand,contenteditable 填充需要它
  if (typeof document.execCommand !== 'function') document.execCommand = () => true;
  loadSrc('lib/chat-helper.js', ['JTChatHelper']);
});

afterEach(() => {
  delete global.JTChatHelper;
});

// 构建一个标准 BOSS 聊天页 DOM
function buildChatPage() {
  document.body.innerHTML = `
    <div class="job-name">康复治疗师</div>
    <div class="chat-message">
      <div class="message-item other"><span class="text">你好,看到你的简历了</span></div>
      <div class="message-item mine"><span class="text">您好,我对这个岗位很感兴趣</span></div>
      <div class="message-item other"><span class="text">方便聊聊你的实习经历吗</span></div>
    </div>
    <textarea class="chat-input" placeholder="回复消息"></textarea>`;
}

describe('P6 · BOSS 聊天页半自动回复仿真', () => {
  // ---------- isBossChatPage ----------
  test('isBossChatPage 正确识别聊天页 URL', () => {
    expect(JTChatHelper.isBossChatPage()).toBe(true);
  });

  test('isBossChatPage 非聊天页返回 false', () => {
    Object.defineProperty(window, 'location', {
      value: { href: 'https://www.zhipin.com/web/geek/job?query=康复' },
      configurable: true
    });
    expect(JTChatHelper.isBossChatPage()).toBe(false);
  });

  // ---------- isOtherMessage(经 extractChatContext 的 role 分类间接验证) ----------
  test('extractChatContext 正确区分 HR(other)与 自己(mine)消息', () => {
    buildChatPage();
    const ctx = JTChatHelper.extractChatContext();
    const roles = ctx.allMessages.map((m) => m.role);
    expect(roles).toEqual(['hr', 'self', 'hr']);
    expect(ctx.hrMessages.every((m) => m.role === 'hr')).toBe(true);
  });

  // ---------- extractChatContext ----------
  test('extractChatContext 抓取 HR 消息与岗位标题', () => {
    buildChatPage();
    const ctx = JTChatHelper.extractChatContext();
    expect(ctx.jobTitle).toBe('康复治疗师');
    expect(ctx.allMessages.length).toBe(3);
    // HR 消息应为 2 条(两条 other)
    expect(ctx.hrMessages.length).toBe(2);
    expect(ctx.hrMessages.every((m) => m.role === 'hr')).toBe(true);
    expect(ctx.latestHrMessage).toContain('实习经历');
  });

  test('extractChatContext 无消息列表容器时返回调试信息', () => {
    document.body.innerHTML = `<div class="job-name">康复</div>`;
    const ctx = JTChatHelper.extractChatContext();
    expect(ctx.hrMessages).toEqual([]);
    expect(ctx.debug).toContain('未找到消息列表容器');
  });

  test('extractChatContext 过滤过短噪声消息(单字如"·")', () => {
    document.body.innerHTML = `
      <div class="job-name">康复</div>
      <div class="chat-message">
        <div class="message-item other"><span class="text">你好</span></div>
        <div class="message-item other"><span class="text">·</span></div>
      </div>
      <textarea class="chat-input"></textarea>`;
    const ctx = JTChatHelper.extractChatContext();
    // "·" 仅 1 字,extractMessageText 过滤(<2)→ 只剩"你好"
    expect(ctx.hrMessages.length).toBe(1);
    expect(ctx.hrMessages[0].text).toBe('你好');
  });

  // ---------- fillChatInput ----------
  test('fillChatInput 填充 textarea 输入框', () => {
    buildChatPage();
    const res = JTChatHelper.fillChatInput('感谢您的回复,我有过 10 个月三甲医院实习经验。');
    expect(res.ok).toBe(true);
    const ta = document.querySelector('textarea.chat-input');
    expect(ta.value).toBe('感谢您的回复,我有过 10 个月三甲医院实习经验。');
  });

  test('fillChatInput 内容为空时返回错误', () => {
    buildChatPage();
    const res = JTChatHelper.fillChatInput('');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('回复内容为空');
  });

  test('fillChatInput 找不到输入框时返回错误', () => {
    document.body.innerHTML = `<div class="chat-message"><div class="message-item other">hi</div></div>`;
    const res = JTChatHelper.fillChatInput('你好');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未找到聊天输入框');
  });

  test('fillChatInput 填充 contenteditable 输入框', () => {
    document.body.innerHTML = `
      <div class="job-name">康复</div>
      <div class="chat-message"><div class="message-item other">你好</div></div>
      <div class="edit-area" contenteditable="true"></div>`;
    const res = JTChatHelper.fillChatInput('您好,我是康复治疗专业。');
    expect(res.ok).toBe(true);
    const ed = document.querySelector('[contenteditable="true"]');
    expect(ed.textContent).toContain('康复治疗专业');
  });

  // ---------- getChatDebugInfo ----------
  test('getChatDebugInfo 输出输入框与消息列表信息', () => {
    buildChatPage();
    const info = JTChatHelper.getChatDebugInfo();
    expect(info.isChatUrl).toBe(true);
    expect(info.jobTitle).toBe('康复治疗师');
    expect(info.inputElement).not.toBeNull();
    expect(info.inputElement.tag).toBe('TEXTAREA');
    expect(info.messageListContainer).not.toBeNull();
    expect(info.messageCount).toBe(3);
  });

  test('getChatDebugInfo 关键元素缺失时收集候选', () => {
    document.body.innerHTML = `<div class="sidebar">岗位</div>`;
    Object.defineProperty(window, 'location', {
      value: { href: 'https://www.zhipin.com/web/geek/chat/999' },
      configurable: true
    });
    const info = JTChatHelper.getChatDebugInfo();
    expect(info.inputElement).toBeNull();
    expect(info.messageListContainer).toBeNull();
    expect(info.candidates).toBeDefined();
  });
});
