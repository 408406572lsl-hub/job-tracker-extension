// ============================================================
// resume-parser.js — 简历文件解析
// 支持 PDF (pdf.js) / Word (mammoth.js) / TXT
// 在扩展页面(如 settings)中运行,需要先通过 <script> 加载 vendor 库
// ============================================================

const JTResumeParser = (() => {
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB,避免大文件耗尽页面内存
  const MAX_PDF_PAGES = 100;

  function assertFileWithinLimits(file) {
    if (file && typeof file.size === 'number' && file.size > MAX_FILE_SIZE) {
      throw new Error('简历文件过大,请上传不超过 10 MB 的文件');
    }
  }

  // ----------------------------------------------------------
  // 解析 PDF → 纯文本
  // 依赖全局 pdfjsLib(由 lib/vendor/pdf.min.js 提供)
  // ----------------------------------------------------------
  async function parsePDF(file) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('PDF 解析库未加载');
    }
    // 设置 worker 路径
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/vendor/pdf.worker.min.js');

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new Error('PDF 页数过多,请上传不超过 100 页的简历');
    }
    let text = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // 按行组装:textContent items 有 transform,用 y 坐标分行
      const lines = {};
      content.items.forEach(item => {
        const y = Math.round(item.transform[5]);
        if (!lines[y]) lines[y] = [];
        lines[y].push({ x: item.transform[4], str: item.str });
      });
      // 按 y 降序(从上到下),每行按 x 升序(从左到右)
      const sortedYs = Object.keys(lines).map(Number).sort((a, b) => b - a);
      sortedYs.forEach(y => {
        const lineText = lines[y].sort((a, b) => a.x - b.x).map(s => s.str).join('');
        if (lineText.trim()) text += lineText + '\n';
      });
      text += '\n';
    }
    return text.trim();
  }

  // ----------------------------------------------------------
  // 解析 Word (.docx) → 纯文本
  // 依赖全局 mammoth(由 lib/vendor/mammoth.browser.min.js 提供)
  // ----------------------------------------------------------
  async function parseWord(file) {
    if (typeof mammoth === 'undefined') {
      throw new Error('Word 解析库未加载');
    }
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return (result.value || '').trim();
  }

  // ----------------------------------------------------------
  // 解析 TXT → 纯文本
  // ----------------------------------------------------------
  async function parseTXT(file) {
    return (await file.text()).trim();
  }

  // ----------------------------------------------------------
  // 自动检测格式并解析
  // ----------------------------------------------------------
  async function parse(file) {
    if (!file) throw new Error('请选择简历文件');
    assertFileWithinLimits(file);
    const name = (file.name || '').toLowerCase();
    const type = file.type || '';

    // PDF
    if (name.endsWith('.pdf') || type === 'application/pdf') {
      return { text: await parsePDF(file), format: 'PDF' };
    }
    // Word .docx
    if (name.endsWith('.docx') || type.includes('wordprocessingml')) {
      return { text: await parseWord(file), format: 'Word' };
    }
    // Word .doc(旧格式,mammoth 不支持,提示用户转换)
    if (name.endsWith('.doc')) {
      throw new Error('旧版 .doc 格式不支持,请将文件另存为 .docx 或 PDF 后再上传');
    }
    // TXT
    if (name.endsWith('.txt') || type === 'text/plain') {
      return { text: await parseTXT(file), format: 'TXT' };
    }
    // 尝试按内容判断
    if (type === 'application/octet-stream' && name.endsWith('.pdf')) {
      return { text: await parsePDF(file), format: 'PDF' };
    }

    throw new Error('不支持的文件格式,请上传 PDF、Word(.docx) 或 TXT 文件');
  }

  // ----------------------------------------------------------
  // 清理解析后的文本(去多余空白、合并断行)
  // ----------------------------------------------------------
  function cleanResumeText(text) {
    if (!text) return '';
    return text
      // 合并被错误拆分的行(行尾不是标点且下一行不是新段落)
      .replace(/([^\n。；;！!？?\-—])\n([^\n])/g, '$1 $2')
      // 多个空格合并
      .replace(/[ \t]+/g, ' ')
      // 多个空行合并
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return { parse, parsePDF, parseWord, parseTXT, cleanResumeText };
})();
