/**
 * 发布一个版本：把主程序目录 MikeLingo/ 打成 Release/v<version>/。
 *
 * 产出（Release/v<version>/）：
 *   manifest.json / src/ / icons/   解压态副本，供「一键升级.bat」覆盖回主程序
 *   MikeLingo-v<version>.zip        上传应用商店 / 分发用
 *   一键升级.bat                     双击即把本版本覆盖到 ..\..\MikeLingo（相对路径，整个项目搬家也不失效）
 *
 * 打包只收 manifest.json / src / icons，其余（tools、node_modules、package*.json、
 * README、截图）都在主程序目录之外，天然不会进包。
 *
 * 不用 PowerShell 的 Compress-Archive：Windows 下它写出的条目名用反斜杠，
 * 不符合 ZIP 规范（4.4.17.1 要求 '/'），Chrome 应用商店解包时可能出错。
 * 这里自己写条目，路径固定为正斜杠。
 *
 * 用法：node tools/pack.cjs           发布 MikeLingo/manifest.json 里的当前版本
 *       node tools/pack.cjs --bats    只重新生成所有历史版本目录里的「一键升级.bat」
 *                                     （改了下面的批处理模板后用它一次性刷新，含旧版本，可用来回滚）
 */
const fs = require('fs');
const path = require('path');
const { buildZip } = require('./zip-writer.cjs');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'MikeLingo'); // 主程序目录 = chrome://extensions 加载的目录
const RELEASE_DIR = path.join(ROOT, 'Release');
const INCLUDE = ['manifest.json', 'src', 'icons'];

/** 按各版本目录里的 manifest 重新生成「一键升级.bat」，改了下面的模板后用它统一刷新 */
function writeAllBats() {
  for (const name of fs.readdirSync(RELEASE_DIR).sort()) {
    const dir = path.join(RELEASE_DIR, name);
    const mf = path.join(dir, 'manifest.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(mf)) continue;
    const ver = JSON.parse(fs.readFileSync(mf, 'utf8')).version;
    fs.writeFileSync(path.join(dir, '一键升级.bat'), upgradeBat(ver), 'utf8');
    console.log(`Release/${name}/一键升级.bat  → v${ver}`);
  }
}

/** 递归收集文件，返回 zip 内路径（正斜杠）与磁盘路径 */
function collect(rel, acc = []) {
  const abs = path.join(EXT_DIR, rel);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) collect(path.posix.join(rel, name), acc);
  } else {
    acc.push({ name: rel.split(path.sep).join('/'), abs });
  }
  return acc;
}

/** 打出 Release/v<version>/：解压态副本 + zip + 一键升级.bat */
function packRelease() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  const outDir = path.join(RELEASE_DIR, `v${version}`);
  const zipName = `MikeLingo-v${version}.zip`;

  const files = INCLUDE.flatMap((entry) => collect(entry));
  const zip = buildZip(files.map((f) => ({ name: f.name, data: fs.readFileSync(f.abs) })));

  // 先清掉上一次同版本的解压态副本，避免删掉的文件残留在发布包里
  for (const entry of INCLUDE) fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of INCLUDE) {
    fs.cpSync(path.join(EXT_DIR, entry), path.join(outDir, entry), { recursive: true });
  }
  fs.writeFileSync(path.join(outDir, zipName), zip);
  fs.writeFileSync(path.join(outDir, '一键升级.bat'), upgradeBat(version), 'utf8');

  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  console.log(`已发布 ${rel(outDir)}/`);
  console.log(`  ${zipName}  ${files.length} 个文件  ${zip.length} 字节`);
  console.log('  一键升级.bat');
  for (const file of files) console.log(`  ${file.name}`);
}

/**
 * 生成「一键升级.bat」：把本 release 目录里的解压态文件覆盖回主程序目录。
 * 路径全部基于 %~dp0（批处理自身所在目录）推导，项目文件夹整体搬家后依然可用。
 * 文件以 UTF-8 无 BOM 写出，配合首行 chcp 65001 保证中文提示不乱码。
 */
function upgradeBat(ver) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'title MikeLingo 一键升级',
    '',
    'rem 本脚本所在目录（结尾自带反斜杠）= Release\\v<版本>\\',
    'set "SRC=%~dp0"',
    'rem 主程序目录：Release\\v<版本>\\ 往上两级 = 项目根，再进 MikeLingo；%%~fI 把 .. 折算掉',
    'for %%I in ("%~dp0..\\..\\MikeLingo") do set "DEST=%%~fI"',
    '',
    'echo.',
    `echo   MikeLingo v${ver}  一键升级`,
    'echo   ------------------------------------------------',
    'echo   来源：%SRC%',
    'echo   目标：%DEST%',
    'echo.',
    '',
    'if not exist "%SRC%manifest.json" (',
    '  echo   [失败] 当前目录下找不到 manifest.json，这个 bat 必须放在版本文件夹里运行。',
    '  goto :end',
    ')',
    '',
    'if not exist "%DEST%" (',
    '  echo   [提示] 主程序目录不存在，将新建：%DEST%',
    '  mkdir "%DEST%" || goto :fail',
    ')',
    '',
    'rem /MIR = 镜像，旧版本里被删掉的文件不会残留在主程序目录',
    'robocopy "%SRC%src" "%DEST%\\src" /MIR /NFL /NDL /NJH /NJS /NP >nul',
    'if errorlevel 8 goto :fail',
    'robocopy "%SRC%icons" "%DEST%\\icons" /MIR /NFL /NDL /NJH /NJS /NP >nul',
    'if errorlevel 8 goto :fail',
    'copy /y "%SRC%manifest.json" "%DEST%\\manifest.json" >nul',
    'if errorlevel 1 goto :fail',
    '',
    `echo   [完成] 已升级到 v${ver}。`,
    'echo.',
    'echo   接下来：打开 chrome://extensions ，点 MikeLingo 卡片上的「刷新」按钮即可生效。',
    'echo   （若扩展还没装过：开启右上角开发者模式 → 加载已解压的扩展程序 → 选 %DEST%）',
    'echo.',
    'echo   提示：升级过程中替换了文件，Chrome 可能残留几条 "Failed to load the script"',
    'echo   报错，刷新后点「全部清除」即可，不影响使用。',
    'goto :end',
    '',
    ':fail',
    'echo   [失败] 复制文件出错，请确认 Chrome 没有占用文件、且对目标目录有写权限。',
    '',
    ':end',
    'echo.',
    'pause',
    ''
  ].join('\r\n');
}

// 分派放在最后：上面的 CRC_TABLE 等 const 有暂时性死区，提前调用会 ReferenceError。
// 用 if/else 而不是在分支里 process.exit()——process.exit 会丢掉还没写完的管道输出
// （`node tools/pack.cjs | more` 会截断并给出 255 退出码）。
if (process.argv.includes('--bats')) writeAllBats();
else packRelease();
