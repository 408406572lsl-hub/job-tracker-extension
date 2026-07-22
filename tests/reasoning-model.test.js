// 推理模型支持:isReasoningModel 识别 + 各服务商模型清单已含推理模型
// setup.js 已把 lib/config.js 的 JT_CONFIG 暴露到全局

describe('推理模型识别 isReasoningModel', () => {
  const fn = () => JT_CONFIG.llm.isReasoningModel;

  test('应识别常见推理模型', () => {
    expect(fn()('deepseek-reasoner')).toBe(true);
    expect(fn()('deepseek-r1')).toBe(true);
    expect(fn()('o1')).toBe(true);
    expect(fn()('o1-mini')).toBe(true);
    expect(fn()('o3-mini')).toBe(true);
    expect(fn()('qwq-plus')).toBe(true);
    expect(fn()('qwen/qwq-32b')).toBe(true);
    expect(fn()('glm-z1-flash')).toBe(true);
    expect(fn()('openai/o1')).toBe(true);
    expect(fn()('deepseek/deepseek-r1')).toBe(true);
    expect(fn()('anthropic/claude-3.7-sonnet:thinking')).toBe(true);
    expect(fn()('qwen3-max-thinking')).toBe(true);
  });

  test('不应误伤普通模型', () => {
    expect(fn()('deepseek-chat')).toBe(false);
    expect(fn()('gpt-4o-mini')).toBe(false);
    expect(fn()('gpt-4o')).toBe(false);
    expect(fn()('qwen-plus')).toBe(false);
    expect(fn()('glm-4-flash')).toBe(false);
    expect(fn()('openai/gpt-4o')).toBe(false);
    expect(fn()('')).toBe(false);
    expect(fn()(null)).toBe(false);
  });
});

describe('模型清单应包含推理模型', () => {
  const p = JT_CONFIG.llm.providers;

  test('deepseek 含 deepseek-reasoner', () => {
    expect(p.deepseek.models).toContain('deepseek-reasoner');
  });
  test('openai 含 o1 / o3', () => {
    expect(p.openai.models).toEqual(expect.arrayContaining(['o1', 'o3-mini']));
  });
  test('openrouter 含 deepseek-r1 与 openai/o1', () => {
    expect(p.openrouter.models).toEqual(expect.arrayContaining(['deepseek/deepseek-r1', 'openai/o1']));
  });
  test('qwen 含 qwq-plus', () => {
    expect(p.qwen.models).toContain('qwq-plus');
  });
  test('glm 含 glm-z1-flash', () => {
    expect(p.glm.models).toContain('glm-z1-flash');
  });
});
