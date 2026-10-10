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

// 安装器里要写死下载地址，仓库名从 shared.js 的默认设置里取，别在这儿另维护一份
const REPO_SLUG = (function readRepoSlug() {
  const src = fs.readFileSync(path.join(EXT_DIR, 'src/common/shared.js'), 'utf8');
  const m = src.match(/updateRepo:\s*'([^']+)'/);
  if (!m) throw new Error('没能从 src/common/shared.js 里读出 updateRepo，安装器的下载地址会是错的');
  return m[1];
})();

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
  // 独立安装器：和 zip 一起上传到 Release，供"应用内更新卡死"的用户兜底。不进 zip，理由见 installerBat
  // 文件名必须全 ASCII：GitHub 上传时会把资产名里的非 ASCII 字符直接剥掉，
  // 叫「…-安装器.bat」传上去会变成「…-.bat」，用户根本看不出这是什么
  fs.writeFileSync(path.join(outDir, `MikeLingo-v${version}-Installer.bat`), installerBat(version, REPO_SLUG), 'utf8');

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
/**
 * 独立安装器，作为 Release 的**第二个资产**单独上传，不进 zip。
 *
 * 为什么不进 zip：updater.js 对包内路径有白名单（只允许 manifest.json / src/** / icons/**），
 * 那是防「从网上下东西覆盖本机文件」的安全边界，往包里塞 bat 会让所有用户的应用内更新直接中止。
 *
 * 为什么需要它：应用内更新一旦卡住（选错目录、或安装目录命中 Chrome 的 File System Access
 * 黑名单），修复本身又只能靠应用内更新送达 —— 死锁。用户必须有一条完全不依赖扩展的升级路径。
 * Release/v<版本>/一键升级.bat 不算，那个靠仓库目录结构的相对路径定位，用户手上没有。
 *
 * 它自己下载 zip、自己解压、自己装，用户只需下这一个文件。
 */
function installerBat(ver, slug) {
  const zipUrl = `https://github.com/${slug}/releases/download/v${ver}/MikeLingo-v${ver}.zip`;
  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal enabledelayedexpansion',
    `title MikeLingo v${ver} 安装器`,
    '',
    'echo.',
    `echo   MikeLingo v${ver}  安装 / 升级`,
    'echo   ------------------------------------------------',
    'echo.',
    '',
    `set "ZIPURL=${zipUrl}"`,
    `set "WORK=%TEMP%\\MikeLingo-v${ver}"`,
    'set "PKG=%WORK%\\pkg"',
    '',
    'echo   正在下载 %ZIPURL%',
    'if exist "%WORK%" rd /s /q "%WORK%"',
    'mkdir "%PKG%" 2>nul',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command ^',
    '  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;' +
      ' try { Invoke-WebRequest -Uri $env:ZIPURL -OutFile ($env:WORK + \'\\pkg.zip\') -UseBasicParsing }' +
      ' catch { Write-Host $_.Exception.Message; exit 1 }"',
    'if errorlevel 1 (',
    '  echo.',
    '  echo   [失败] 下载失败。请检查网络 / 代理，或手动下载：',
    '  echo   %ZIPURL%',
    '  goto :end',
    ')',
    '',
    'echo   正在解压…',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command ^',
    '  "try { Expand-Archive -LiteralPath ($env:WORK + \'\\pkg.zip\') -DestinationPath $env:PKG -Force }' +
      ' catch { Write-Host $_.Exception.Message; exit 1 }"',
    'if errorlevel 1 (',
    '  echo   [失败] 解压失败，安装包可能没下完整。',
    '  goto :end',
    ')',
    '',
    'set "SRC=%PKG%\\"',
    'if not exist "%SRC%manifest.json" (',
    '  echo   [失败] 安装包内容不对，缺 manifest.json。',
    '  goto :end',
    ')',
    '',
    'rem 目标目录：优先取拖拽进来的文件夹，否则让用户粘贴',
    'set "DEST=%~1"',
    'if "%DEST%"=="" (',
    '  echo   请提供 MikeLingo 当前的安装目录。',
    'echo   在浏览器打开 chrome://extensions（Edge 是 edge://extensions），',
    'echo   打开右上角「开发者模式」，MikeLingo 卡片上会显示「来源 / 已加载路径」。',
    '  echo.',
    '  echo   把那个路径粘贴到这里回车（也可以直接把文件夹拖到本 bat 上运行）：',
    '  set /p "DEST=> "',
    ')',
    '',
    'rem 去掉粘贴路径时常见的首尾引号',
    'set "DEST=%DEST:"=%"',
    'if "%DEST%"=="" (',
    '  echo   [取消] 没有输入路径。',
    '  goto :end',
    ')',
    '',
    'rem 用户很可能选到外面那层同名目录，这里自动往下找一层',
    'if not exist "%DEST%\\manifest.json" (',
    '  if exist "%DEST%\\MikeLingo\\manifest.json" (',
    '    echo   [提示] 这是外层目录，已自动改用：%DEST%\\MikeLingo',
    '    set "DEST=%DEST%\\MikeLingo"',
    '  )',
    ')',
    '',
    'if not exist "%DEST%\\manifest.json" (',
    '  echo.',
    '  echo   [失败] "%DEST%" 里没有 manifest.json，这不是扩展的安装目录。',
    '  echo   正确的目录里应该能看到 manifest.json、src、icons 三项。',
    '  goto :end',
    ')',
    '',
    'echo.',
    'echo   来源：%SRC%',
    'echo   目标：%DEST%',
    'echo.',
    '',
    'robocopy "%SRC%src" "%DEST%\\src" /MIR /NFL /NDL /NJH /NJS /NP >nul',
    'if errorlevel 8 goto :fail',
    'robocopy "%SRC%icons" "%DEST%\\icons" /MIR /NFL /NDL /NJH /NJS /NP >nul',
    'if errorlevel 8 goto :fail',
    'copy /y "%SRC%manifest.json" "%DEST%\\manifest.json" >nul',
    'if errorlevel 1 goto :fail',
    '',
    `echo   [完成] 已安装 v${ver}。`,
    'echo.',
    'echo   接下来：回到扩展管理页，点 MikeLingo 卡片上的「刷新」按钮即可生效。',
    'echo.',
    'goto :end',
    '',
    ':fail',
    'echo.',
    'echo   [失败] 复制文件时出错。请确认浏览器没有正在占用该目录，或用管理员身份重试。',
    '',
    ':end',
    'if exist "%WORK%" rd /s /q "%WORK%" 2>nul',
    'echo.',
    'pause',
    ''
  ].join('\r\n');
}

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
    'echo   接下来：打开扩展管理页（Chrome 是 chrome://extensions，Edge 是 edge://extensions），',
    'echo   点 MikeLingo 卡片上的「刷新」按钮即可生效。',
    'echo   （若扩展还没装过：开启开发者模式 → 加载已解压的扩展程序 → 选 %DEST%）',
    'echo.',
    'echo   提示：升级过程中替换了文件，浏览器可能残留几条 "Failed to load the script"',
    'echo   报错，刷新后点「全部清除」即可，不影响使用。',
    'goto :end',
    '',
    ':fail',
    'echo   [失败] 复制文件出错，请确认浏览器没有占用文件、且对目标目录有写权限。',
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
