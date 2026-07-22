// ============================================================
// resume-parser-sim.test.js — 简历解析单元测试
// 注入假 pdfjsLib / mammoth 全局,验证 TXT/PDF/Word 解析、格式路由分发、
// 旧 .doc 拒识、未知格式拒识、cleanResumeText 归一化。
// 不依赖真实 pdf.js / mammoth 库。
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

describe('resume-parser 仿真测试', () => {
  let origPdfjs, origMammoth, origGetURL, origBlob;

  beforeAll(() => {
    // 保存原始全局
    origPdfjs = global.pdfjsLib;
    origMammoth = global.mammoth;
    origGetURL = global.chrome && global.chrome.runtime && global.chrome.runtime.getURL;
    origBlob = global.Blob;

    // —— 假 pdfjsLib:单页,两行文本,带 transform(y,x,str) ——
    const fakePdfText = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [
            { transform: [1, 0, 0, 1, 10, 100], str: '测试用户' },
            { transform: [1, 0, 0, 1, 10, 80], str: '康复治疗技术' },
            { transform: [1, 0, 0, 1, 10, 60], str: '南宁医科大学' },
          ],
        }),
      }),
    };
    global.pdfjsLib = {
      GlobalWorkerOptions: {},
      getDocument: () => ({ promise: Promise.resolve(fakePdfText) }),
    };

    // —— 假 mammoth ——
    global.mammoth = {
      extractRawText: async () => ({ value: '姓名 测试用户\n专业 康复治疗\n电话 13800000000' }),
    };

    // chrome.runtime.getURL 桩
    global.chrome = global.chrome || {};
    global.chrome.runtime = global.chrome.runtime || {};
    global.chrome.runtime.getURL = (p) => 'chrome-extension://test/' + p;

    // Blob 桩(若 jsdom 未实现 .text)
    if (typeof global.Blob === 'undefined' || !global.Blob.prototype || !global.Blob.prototype.text) {
      global.Blob = class { constructor(parts) { this._parts = parts || []; } text() { return Promise.resolve(this._parts.map((p) => String(p)).join('')); } };
    }

    loadSrc('lib/resume-parser.js', ['JTResumeParser']);
  });

  afterAll(() => {
    global.pdfjsLib = origPdfjs;
    global.mammoth = origMammoth;
    if (origGetURL !== undefined) global.chrome.runtime.getURL = origGetURL;
    if (origBlob !== undefined) global.Blob = origBlob;
  });

  test('parseTXT:返回文本与 format=TXT', async () => {
    const file = { name: 'resume.txt', type: 'text/plain', text: async () => '康复治疗专业应届生\n南宁' };
    const r = await JTResumeParser.parseTXT(file);
    expect(r).toBe('康复治疗专业应届生\n南宁');
    const full = await JTResumeParser.parse(file);
    expect(full.format).toBe('TXT');
    expect(full.text).toContain('康复治疗');
  });

  test('parsePDF:按 transform 行组装文本', async () => {
    const file = { name: 'resume.pdf', type: 'application/pdf', arrayBuffer: async () => new Uint8Array([]) };
    const r = await JTResumeParser.parsePDF(file);
    expect(r).toContain('测试用户');
    expect(r).toContain('康复治疗技术');
    expect(r).toContain('南宁医科大学');
    const full = await JTResumeParser.parse(file);
    expect(full.format).toBe('PDF');
  });

  test('parseWord:走 mammoth 提取', async () => {
    const file = { name: 'resume.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', arrayBuffer: async () => new Uint8Array([]) };
    const r = await JTResumeParser.parseWord(file);
    expect(r).toContain('测试用户');
    const full = await JTResumeParser.parse(file);
    expect(full.format).toBe('Word');
  });

  test('parse 路由:按扩展名分发 PDF/Word/TXT', async () => {
    expect((await JTResumeParser.parse({ name: 'a.PDF', type: '', arrayBuffer: async () => new Uint8Array([]) })).format).toBe('PDF');
    expect((await JTResumeParser.parse({ name: 'b.docx', type: '', arrayBuffer: async () => new Uint8Array([]) })).format).toBe('Word');
    expect((await JTResumeParser.parse({ name: 'c.txt', type: 'text/plain', text: async () => 'x' })).format).toBe('TXT');
  });

  test('parse 拒绝超过 10 MB 的简历文件', async () => {
    await expect(JTResumeParser.parse({
      name: 'huge.pdf', type: 'application/pdf', size: 10 * 1024 * 1024 + 1,
      arrayBuffer: async () => new Uint8Array([])
    })).rejects.toThrow(/10 MB|过大/);
  });

  test('parsePDF 拒绝超过 100 页的 PDF', async () => {
    const originalGetDocument = global.pdfjsLib.getDocument;
    global.pdfjsLib.getDocument = () => ({ promise: Promise.resolve({ numPages: 101 }) });
    try {
      await expect(JTResumeParser.parsePDF({ arrayBuffer: async () => new Uint8Array([]) }))
        .rejects.toThrow(/100 页|页数过多/);
    } finally {
      global.pdfjsLib.getDocument = originalGetDocument;
    }
  });

  test('parse 拒识旧版 .doc 格式', async () => {
    await expect(JTResumeParser.parse({ name: 'old.doc', type: 'application/msword', arrayBuffer: async () => new Uint8Array([]) }))
      .rejects.toThrow(/旧版 .doc|不支持/);
  });

  test('parse 拒识未知格式', async () => {
    await expect(JTResumeParser.parse({ name: 'x.png', type: 'image/png', arrayBuffer: async () => new Uint8Array([]) }))
      .rejects.toThrow(/不支持/);
  });

  test('cleanResumeText:合并断行/多空格/多空行', () => {
    const dirty = '康复治疗\n技术 大专\n\n\n\n  实习 经历   ';
    const clean = JTResumeParser.cleanResumeText(dirty);
    expect(clean).not.toMatch(/\n{3,}/); // 无 3+ 连续空行
    expect(clean).not.toMatch(/[ \t]{2,}/); // 无连续多空格
    expect(clean.startsWith('康复治疗')).toBe(true);
  });
});
