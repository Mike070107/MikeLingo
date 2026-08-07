/**
 * 一键更新：查 GitHub Releases → 下载发布包 → 写回扩展安装目录 → 自动重载。
 *
 * 为什么能写本地文件：扩展没有任意写文件的 API，但设置页是个普通页面，
 * 可以用 File System Access（showDirectoryPicker）让用户**授权一次**安装目录，
 * 句柄存进 IndexedDB 复用。写完调 chrome.runtime.reload()，连 chrome://extensions
 * 那一下刷新都省了。
 *
 * 安全上卡了四道，缺一不可——毕竟这是"从网上下东西覆盖本机文件"：
 *   1. 只从设置里配置的那个 GitHub 仓库取，且资源域名必须是 github 自家的
 *   2. 包里的路径只允许 manifest.json / src/** / icons/**，出现 .. 或绝对路径直接拒绝
 *   3. 包里的 manifest 必须 name 是 MikeLingo、key 与当前扩展一致（防止装成别的扩展）
 *   4. 目标目录必须本来就是 MikeLingo 的安装目录（认得出它自己的 manifest）
 */
import { readZip } from '../common/zip.js';

const DST = globalThis.DST;

const API_BASE = 'https://api.github.com';
const ASSET_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

/**
 * 测试用的接口地址覆盖（e2e 跑本地假 GitHub，不出网）；正常使用时为空。
 * 配了它就把那个域名也加进下载白名单，否则测试下载会被白名单挡住。
 */
async function apiOverride() {
  try {
    const stored = await chrome.storage.local.get('updateApiBase');
    return String(stored.updateApiBase || '').trim().replace(/\/+$/, '');
  } catch {
    return '';
  }
}
const ASSET_RE = /^MikeLingo-v[\d.]+\.zip$/i;
const ALLOWED_PATH_RE = /^(manifest\.json|src\/[A-Za-z0-9_.\-/]+|icons\/[A-Za-z0-9_.-]+)$/;
const MIRROR_DIRS = ['src', 'icons']; // 这两个目录做镜像：包里没有的旧文件要删掉

/* ------------------------------ 目录句柄存取 ------------------------------ */

const HANDLE_DB = 'dst-fs';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'installDir';

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) req.result.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readHandle() {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve) => {
      const req = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeHandle(handle) {
  try {
    const db = await openHandleDb();
    await new Promise((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {
    /* 存不下只是下次要重选目录，不影响这次安装 */
  }
}

/* -------------------------------- 检查更新 -------------------------------- */

/**
 * 查最新 release。返回 { version, notes, assetUrl, assetName, htmlUrl }。
 * 没有可用的 zip 资源时抛错——说明发布时忘了传包，早点说清楚比让用户点了没反应好。
 */
export async function fetchLatestRelease(repo) {
  const slug = DST.parseRepo(repo);
  if (!slug) throw new Error('更新源填写有误，应形如 用户名/仓库名');

  const base = (await apiOverride()) || API_BASE;
  let res;
  try {
    res = await fetch(`${base}/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
  } catch (err) {
    throw new Error(`连接 GitHub 失败：${err?.message || err}。请检查网络或代理`);
  }

  if (res.status === 404) throw new Error(`仓库 ${slug} 不存在，或它还没有发布过 Release`);
  if (res.status === 403) throw new Error('GitHub 接口限流了（未登录状态每小时 60 次），过一会儿再试');
  if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);

  const data = await res.json();
  const version = String(data.tag_name || '').replace(/^v/i, '');
  if (!version) throw new Error('这个 Release 没有版本号（tag）');

  const asset = (Array.isArray(data.assets) ? data.assets : []).find((a) => ASSET_RE.test(String(a?.name || '')));
  if (!asset) throw new Error(`Release ${data.tag_name} 里没有找到 MikeLingo-v*.zip，请检查发布时是否上传了发布包`);

  return {
    version,
    notes: String(data.body || '').trim(),
    assetUrl: String(asset.browser_download_url || ''),
    assetName: String(asset.name || ''),
    size: Number(asset.size) || 0,
    htmlUrl: String(data.html_url || '')
  };
}

/* -------------------------------- 下载与校验 ------------------------------- */

async function assertTrustedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('下载地址不合法');
  }
  const override = await apiOverride();
  if (override) {
    try {
      if (new URL(override).host === parsed.host) return; // 测试环境：允许假 GitHub 那台
    } catch {
      /* override 填得不对就按正常规则判 */
    }
  }
  const host = parsed.hostname.toLowerCase();
  const ok = parsed.protocol === 'https:' && ASSET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) throw new Error(`拒绝从非 GitHub 域名下载：${parsed.hostname}`);
}

/** 下载并解包，顺带把包内容校验一遍。onProgress(阶段文案) 用于界面反馈 */
export async function downloadPackage(release, onProgress = () => {}) {
  await assertTrustedUrl(release.assetUrl);

  onProgress('正在下载发布包…');
  const res = await fetch(release.assetUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();

  onProgress('正在解包…');
  const files = await readZip(buffer);

  // 路径白名单：只允许改扩展自己的三样东西
  for (const name of files.keys()) {
    if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || !ALLOWED_PATH_RE.test(name)) {
      throw new Error(`发布包里有不该出现的路径，已中止：${name}`);
    }
  }

  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('发布包里没有 manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error('发布包里的 manifest.json 无法解析');
  }

  const current = chrome.runtime.getManifest();
  if (manifest.name !== current.name) throw new Error(`发布包是「${manifest.name}」，不是 ${current.name}，已中止`);
  if (current.key && manifest.key !== current.key) {
    throw new Error('发布包的扩展签名密钥与当前扩展不一致，装上会变成另一个扩展（数据会丢），已中止');
  }
  if (DST.compareVersions(manifest.version, release.version) !== 0) {
    throw new Error(`发布包里的版本（${manifest.version}）与 Release 标注的（${release.version}）对不上，已中止`);
  }
  if (DST.compareVersions(manifest.version, current.version) <= 0) {
    throw new Error(`发布包版本 ${manifest.version} 不比当前的 ${current.version} 新，已中止`);
  }

  return files;
}

/* -------------------------------- 写回安装目录 ------------------------------ */

async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

/** 确认这个目录确实是 MikeLingo 的安装目录，避免用户选错把别的文件夹写坏 */
async function assertInstallDir(dir) {
  let file;
  try {
    file = await (await dir.getFileHandle('manifest.json')).getFile();
  } catch {
    throw new Error(`「${dir.name}」里没有 manifest.json，这不是扩展的安装目录。请选 chrome://extensions 里加载的那个 MikeLingo 目录`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await file.text());
  } catch {
    throw new Error(`「${dir.name}」里的 manifest.json 无法解析，为安全起见已中止`);
  }
  if (manifest.name !== chrome.runtime.getManifest().name) {
    throw new Error(`「${dir.name}」装的是「${manifest.name}」，不是 MikeLingo，已中止`);
  }
  return manifest.version;
}

/** 取安装目录：有存过的句柄就复用（只需点一次「允许」），否则让用户选 */
export async function pickInstallDir({ forcePick = false } = {}) {
  if (!window.showDirectoryPicker) {
    throw new Error('当前浏览器不支持目录授权（需要 Chrome 86+），请改用 Release 目录里的「一键升级.bat」');
  }
  if (!forcePick) {
    const saved = await readHandle();
    if (saved && (await ensurePermission(saved))) {
      await assertInstallDir(saved);
      return saved;
    }
  }
  const dir = await window.showDirectoryPicker({ id: 'mikelingo-install', mode: 'readwrite' });
  if (!(await ensurePermission(dir))) throw new Error('没有拿到写入权限，无法安装');
  await assertInstallDir(dir);
  await writeHandle(dir);
  return dir;
}

async function writeFile(dir, relPath, bytes) {
  const parts = relPath.split('/');
  const fileName = parts.pop();
  let target = dir;
  for (const part of parts) target = await target.getDirectoryHandle(part, { create: true });
  const handle = await target.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

/** 收集目录下所有文件的相对路径，用来找出该删的旧文件 */
async function listFiles(dir, prefix = '', acc = []) {
  for await (const [name, handle] of dir.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') await listFiles(handle, rel, acc);
    else acc.push(rel);
  }
  return acc;
}

async function removeStale(dir, files, onProgress) {
  for (const top of MIRROR_DIRS) {
    let sub;
    try {
      sub = await dir.getDirectoryHandle(top);
    } catch {
      continue;
    }
    const existing = await listFiles(sub, top);
    for (const rel of existing) {
      if (files.has(rel)) continue;
      onProgress(`清理旧文件 ${rel}`);
      const parts = rel.split('/').slice(1); // 去掉 top 这一层
      const name = parts.pop();
      let target = sub;
      for (const part of parts) target = await target.getDirectoryHandle(part);
      await target.removeEntry(name);
    }
  }
}

/**
 * 把解包后的文件写进安装目录。
 * manifest.json 最后写：中途失败时目录里仍是旧版本号，用户再点一次更新即可，
 * 不会出现"版本号说是新的、代码还是旧的"这种最难查的状态。
 */
export async function installFiles(dir, files, onProgress = () => {}) {
  const entries = [...files.entries()].filter(([name]) => name !== 'manifest.json');
  let done = 0;
  for (const [name, bytes] of entries) {
    await writeFile(dir, name, bytes);
    done++;
    onProgress(`正在写入 ${done}/${entries.length + 1}：${name}`);
  }
  await removeStale(dir, files, onProgress);
  await writeFile(dir, 'manifest.json', files.get('manifest.json'));
  onProgress(`正在写入 ${entries.length + 1}/${entries.length + 1}：manifest.json`);
}
