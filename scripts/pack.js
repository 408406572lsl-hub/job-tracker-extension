// ============================================================
// pack.js — 打包脚本
// 把插件打包成可上传 Chrome 商店的 zip(保持目录结构)
// 排除:node_modules、tests、scripts、.git、IDE 配置、*.zip、*.md、nul 等开发文件
// 用法: node scripts/pack.js
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const workspaceRoot = path.join(__dirname, '..', '..'); // 工作区根目录(脚本位置上两级)
const manifestPath = path.join(rootDir, 'manifest.json');

// 读取版本号
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
const outName = `job-tracker-v${version}.zip`;
const outPath = path.join(workspaceRoot, outName); // 直接输出到工作区根目录,免去手动 mv

// 需要排除的目录/文件(相对根目录)。通配项(含 *) 按文件名模式匹配。
const exclude = [
  'node_modules',
  'tests',
  'scripts',
  '.git',
  '.gitignore',
  '.eslintrc.json',
  '.prettierrc.json',
  'package.json',
  'package-lock.json',
  'coverage',
  '.eslintcache',
  '.DS_Store',
  'Thumbs.db',
  '*.zip',   // 旧包不进新包,否则会嵌套导致体积翻倍
  '*.md',    // 开发/检查文档不进上架包
  'nul',     // Windows 设备名残留文件,清理
  '.env',    // 本地密钥,绝不进上架包
  'mcp-bridge'  // MCP 桥接独立进程,不属于 Chrome 扩展上架内容
];

// 判断相对路径(用 / 分隔)是否命中排除规则
function isExcluded(rel) {
  const norm = rel.replace(/\\/g, '/');
  return exclude.some((e) => {
    if (e.includes('*')) {
      // 通配模式(如 *.zip *.md):匹配任意路径段
      const pat = e.replace(/\*/g, '.*');
      return new RegExp('(^|/)' + pat + '$').test(norm);
    }
    // 目录/文件名:精确匹配、前缀匹配、或作为任一路径段出现
    return norm === e || norm.startsWith(e + '/') || norm.split('/').includes(e);
  });
}

// 递归复制 rootDir 下未被排除的文件到 destDir,保持目录结构
function copyFiltered(srcDir, destDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const name = entry.name;
    if (isExcluded(name)) continue;
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);
    if (entry.isDirectory()) {
      copyFiltered(srcPath, destPath);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log(`\n📦 打包 job-tracker-extension v${version}`);
console.log(`   输出: ${outName}\n`);

// 暂存目录放在系统临时区,避免被 copyFiltered 递归进自身
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-pack-'));

try {
  // 删除旧包(否则 7z/暂存都不受影响,但保持根目录整洁)
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  copyFiltered(rootDir, staging);

  if (process.platform === 'win32') {
    // PowerShell Compress-Archive:传暂存目录下所有条目(保留相对目录结构)
    const ps = `Compress-Archive -Path '${staging.replace(/'/g, "''")}\\*' -DestinationPath '${outPath.replace(/'/g, "''")}' -Force`;
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  } else {
    execSync(`cd '${staging}' && zip -r '${outPath}' .`, { stdio: 'inherit' });
  }

  const size = fs.statSync(outPath).size;
  console.log(`\n✅ 打包完成: ${outName} (${(size / 1024).toFixed(1)} KB)`);
  console.log(`   路径: ${outPath}`);
} catch (e) {
  console.error('\n❌ 打包失败:', e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
