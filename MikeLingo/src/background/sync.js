/**
 * 云同步编排：把本机的生词本 / 设置 / 接口配置 / 已加密的 API Key 与远端那一个 JSON 文件对齐。
 *
 * 只有一条路径能改远端：**先读远端 → 与本机合并 → 把合并结果写回去**。
 * 不做"本地覆盖远端"，也不做"远端覆盖本地"——两台机器各加了几个词的场景太常见，
 * 任何一侧的覆盖都会当场吃掉用户的数据。手动的「只上传 / 只下载」也走同一套合并，
 * 区别只在于最后写不写远端、以及冲突时偏向谁。
 *
 * 乐观锁：读的时候记下 rev（WebDAV 的 ETag / Gist 的 updated_at），写回时带上；
 * 远端在这期间被另一台机器改过就拿到 CONFLICT，重新读一遍再合并（最多重来 2 次）。
 *
 * 配置和凭据存在 chrome.storage.local，**永远不进备份文件**——
 * 否则两台机器会互相覆盖对方的同步配置，网盘密码也会跟着上传到网盘自己那儿去。
 */
import { encryptJson, decryptJson } from '../common/crypto.js';
import { BACKUP_FORMAT, BACKUP_VERSION, normalizeBackup, mergeSettings, mergeApiKeys } from '../common/backup.js';
import { createRemote, webdavFileUrl } from './sync-remote.js';
import { VocabStore } from './vocab-store.js';

const DST = globalThis.DST;

const CONFIG_KEY = 'syncConfig';
const CREDS_KEY = 'syncCreds'; // 单独一个键，方便"清除凭据"一次删干净
const STATE_KEY = 'syncState';

const DEFAULT_CONFIG = {
  enabled: false,
  backend: 'webdav', // webdav | gist
  auto: true, // 改动后与浏览器启动时自动同步
  includeSecrets: true, // 把 API Key 加密后一起同步
  webdav: { url: '', user: '' },
  gist: { id: '' }
};

const DEFAULT_CREDS = { webdavPass: '', gistToken: '', passphrase: '' };

/* -------------------------------- 配置读写 -------------------------------- */

export async function loadConfig() {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    webdav: { ...DEFAULT_CONFIG.webdav, ...(stored.webdav || {}) },
    gist: { ...DEFAULT_CONFIG.gist, ...(stored.gist || {}) }
  };
}

async function loadCreds() {
  const stored = (await chrome.storage.local.get(CREDS_KEY))[CREDS_KEY] || {};
  return { ...DEFAULT_CREDS, ...stored };
}

/**
 * 保存配置。凭据字段留 undefined 表示"保持不变"——设置页只回显"已设置"，
 * 不回显原文，用户不改密码时不该被空表单清掉（和 API Key 那边一个规矩）。
 */
export async function saveConfig(configPatch = {}, credsPatch = {}) {
  const config = await loadConfig();
  const next = {
    ...config,
    ...configPatch,
    webdav: { ...config.webdav, ...(configPatch.webdav || {}) },
    gist: { ...config.gist, ...(configPatch.gist || {}) }
  };
  next.backend = next.backend === 'gist' ? 'gist' : 'webdav';
  next.enabled = Boolean(next.enabled);
  next.auto = Boolean(next.auto);
  next.includeSecrets = Boolean(next.includeSecrets);
  next.webdav.url = String(next.webdav.url || '').trim();
  next.webdav.user = String(next.webdav.user || '').trim();
  next.gist.id = String(next.gist.id || '').trim();

  const creds = await loadCreds();
  for (const key of Object.keys(DEFAULT_CREDS)) {
    if (typeof credsPatch[key] === 'string') creds[key] = credsPatch[key].trim();
  }

  await chrome.storage.local.set({ [CONFIG_KEY]: next, [CREDS_KEY]: creds });
  return maskConfig(next, creds);
}

/** 给设置页看的形状：凭据只说"有没有"，不回显原文 */
function maskConfig(config, creds) {
  return {
    ...config,
    hasWebdavPass: Boolean(creds.webdavPass),
    hasGistToken: Boolean(creds.gistToken),
    hasPassphrase: Boolean(creds.passphrase)
  };
}

export async function getConfig() {
  return maskConfig(await loadConfig(), await loadCreds());
}

export async function getState() {
  const state = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  return { lastSyncAt: 0, lastError: '', lastSummary: '', rev: '', ...state };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

/* ------------------------------- 打包与落盘 ------------------------------- */

function deviceLabel() {
  const browser = DST.browserName();
  const ua = globalThis.navigator?.userAgent || '';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' / ');
}

/** 把本机现状打成一份备份（设置页的「导出备份」用的也是这个） */
export async function buildBackup({ includeSecrets = true, passphrase = '' } = {}) {
  const settings = await DST.loadSettings();
  const vocab = await VocabStore.exportWords();

  let secrets = null;
  let secretsUpdatedAt = 0;
  if (includeSecrets) {
    const keys = await DST.loadApiKeys();
    if (Object.keys(keys).length) {
      if (!passphrase) throw new Error('要同步 API Key 必须先设置主口令，否则密钥只能明文上云');
      secrets = await encryptJson({ apiKeys: keys }, passphrase);
      secretsUpdatedAt = await DST.readStamp(DST.API_KEYS_STAMP_KEY);
    }
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    device: deviceLabel(),
    settings,
    settingsUpdatedAt: await DST.readStamp(DST.SETTINGS_STAMP_KEY),
    vocab: { words: vocab.words, deleted: vocab.deleted },
    secrets,
    secretsUpdatedAt
  };
}

/**
 * 把一份外来备份合并进本机。返回逐项结果，界面照原样说清楚做了什么——
 * "同步成功"这种话没法让用户判断该不该担心。
 */
export async function applyBackup(raw, { passphrase = '', manual = false } = {}) {
  const remote = normalizeBackup(raw);
  const result = { vocab: { added: 0, merged: 0, skipped: 0, deleted: 0 }, settingsChanged: false, keysAdded: 0, secretsError: '' };

  // 1. 生词本：合并 + 处理对面的删除墓碑
  if (remote.vocab.words.length || remote.vocab.deleted.length) {
    result.vocab = await VocabStore.importWords(
      { words: remote.vocab.words, deleted: remote.vocab.deleted },
      // 手动导入是用户明确的"还原这一份"，本机的删除记录不该拦着；自动同步则必须尊重它
      { ignoreLocalTombstones: manual }
    );
  }

  // 2. 设置与接口配置
  if (remote.settings) {
    const localSettings = await DST.loadSettings();
    const localStamp = await DST.readStamp(DST.SETTINGS_STAMP_KEY);
    const m = mergeSettings(
      { settings: localSettings, updatedAt: localStamp },
      { settings: remote.settings, updatedAt: remote.settingsUpdatedAt }
    );
    const normalized = DST.normalizeSettings(m.settings);
    if (JSON.stringify(normalized) !== JSON.stringify(localSettings)) {
      // 直接写，不走 saveSettings：那会把时间戳刷成"现在"，
      // 于是本机永远显得比对面新，另一台的改动再也赢不了。
      await chrome.storage.sync.set({ [DST.SETTINGS_KEY]: normalized });
      await chrome.storage.local.set({ [DST.SETTINGS_STAMP_KEY]: m.updatedAt || Date.now() });
      result.settingsChanged = true;
    }
  }

  // 3. API Key：解密后按接口 id 合并
  if (remote.secrets) {
    if (!passphrase) {
      result.secretsError = '远端有加密的 API Key，但本机没设主口令，跳过了密钥';
    } else {
      try {
        const plain = await decryptJson(remote.secrets, passphrase);
        const localKeys = await DST.loadApiKeys();
        const localStamp = await DST.readStamp(DST.API_KEYS_STAMP_KEY);
        const m = mergeApiKeys(
          { keys: localKeys, updatedAt: localStamp },
          { keys: plain?.apiKeys || {}, updatedAt: remote.secretsUpdatedAt }
        );
        if (JSON.stringify(m.keys) !== JSON.stringify(localKeys)) {
          await chrome.storage.local.set({
            [DST.API_KEYS_KEY]: m.keys,
            [DST.API_KEYS_STAMP_KEY]: m.updatedAt || Date.now()
          });
        }
        result.keysAdded = m.added;
      } catch (err) {
        // 口令不对不该让整次同步失败：生词本和设置已经同步好了，如实说明就行
        result.secretsError = err?.message || String(err);
      }
    }
  }

  return result;
}

/* --------------------------------- 同步 --------------------------------- */

function summarize(result) {
  const parts = [];
  const v = result.vocab;
  if (v.added) parts.push(`新增 ${v.added} 个生词`);
  if (v.merged) parts.push(`合并 ${v.merged} 个`);
  if (v.deleted) parts.push(`删除 ${v.deleted} 个`);
  if (result.settingsChanged) parts.push('更新了设置与接口配置');
  if (result.keysAdded) parts.push(`带回 ${result.keysAdded} 个 API Key`);
  return parts.length ? parts.join('，') : '没有需要变更的内容';
}

/** 配置齐不齐。缺什么直接说缺什么，别等用户点了同步再报一个 401 */
export async function validateConfig(config, creds) {
  if (config.backend === 'gist') {
    if (!creds.gistToken) throw new Error('还没填 GitHub Token');
  } else {
    if (!config.webdav.url) throw new Error('还没填 WebDAV 服务器地址');
    webdavFileUrl(config.webdav.url); // 顺手校验格式
    if (!config.webdav.user) throw new Error('还没填 WebDAV 用户名');
    if (!creds.webdavPass) throw new Error('还没填 WebDAV 密码（坚果云要用「应用密码」，不是登录密码）');
  }
  if (config.includeSecrets && !creds.passphrase) {
    throw new Error('勾选了同步 API Key，必须设置主口令——密钥要加密之后才能上云');
  }
}

/** 只读一次远端，用来做「测试连接」：能连上吗、上面已经有什么 */
export async function testRemote() {
  const config = await loadConfig();
  const creds = await loadCreds();
  await validateConfig(config, creds);
  const remote = createRemote(config, creds);

  const res = await remote.read();
  if (!res.exists) {
    return { ok: true, exists: false, message: `连接成功。远端还没有同步文件，第一次同步会自动创建（${remote.location}）` };
  }
  let parsed;
  try {
    parsed = normalizeBackup(JSON.parse(res.text));
  } catch (err) {
    throw new Error(`远端文件解析失败：${err?.message || err}`);
  }
  const when = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString() : '未知时间';
  return {
    ok: true,
    exists: true,
    words: parsed.vocab.words.length,
    hasSecrets: Boolean(parsed.secrets),
    message: `连接成功。远端有 ${parsed.vocab.words.length} 个生词，${parsed.secrets ? '含加密的 API Key，' : ''}最后由「${parsed.device || '未知设备'}」在 ${when} 写入`
  };
}

/**
 * direction:
 *   both（默认）— 拉下来合并，再把合并结果写回去，两边最终一致
 *   pull        — 只合并到本机，不动远端
 *   push        — 合并后写回远端（本机没有的远端内容仍会保留，不是覆盖）
 */
export async function syncNow({ direction = 'both' } = {}) {
  const config = await loadConfig();
  const creds = await loadCreds();
  await validateConfig(config, creds);
  const remote = createRemote(config, creds);

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await remote.read();

      let applied = { vocab: { added: 0, merged: 0, skipped: 0, deleted: 0 }, settingsChanged: false, keysAdded: 0, secretsError: '' };
      if (res.exists && res.text.trim()) {
        let parsed;
        try {
          parsed = JSON.parse(res.text);
        } catch {
          throw new Error('远端文件不是合法 JSON，可能被别的程序改过；确认后可用「只上传」覆盖它');
        }
        if (direction !== 'push') {
          applied = await applyBackup(parsed, { passphrase: creds.passphrase });
        }
      }

      if (direction === 'pull') {
        const summary = summarize(applied);
        await setState({ lastSyncAt: Date.now(), lastError: '', lastSummary: summary, rev: res.rev || '' });
        return { ok: true, direction, summary, ...applied };
      }

      // 合并之后本机就是"两边的并集"，把它写回去，远端也就跟上了
      const payload = await buildBackup({ includeSecrets: config.includeSecrets, passphrase: creds.passphrase });
      const written = await remote.write(JSON.stringify(payload), res.rev);

      // 首次用 Gist 时 id 是服务端生成的，存下来，用户不用自己去复制
      if (written.extra?.gistId) await saveConfig({ gist: { id: written.extra.gistId } });

      const summary = summarize(applied);
      await setState({ lastSyncAt: Date.now(), lastError: '', lastSummary: summary, rev: written.rev || '' });
      return { ok: true, direction, summary, words: payload.vocab.words.length, ...applied };
    } catch (err) {
      lastError = err;
      if (err?.code !== 'CONFLICT') break;
      // 远端刚被另一台改过：重新读一遍再合并，这正是乐观锁该走的路
    }
  }

  const message = lastError?.code === 'CONFLICT'
    ? '远端一直在被改动，连试三次都没写成功，稍后再同步'
    : lastError?.message || String(lastError);
  await setState({ lastError: message });
  throw new Error(message);
}

/* ------------------------------- 自动同步 ------------------------------- */

let autoTimer = null;

/**
 * 改动后延迟一会儿再同步：连着改十个设置项不该打十次网盘。
 * 用 setTimeout 而不是 alarms——service worker 在这几秒里本来就是活的，
 * 真被回收了也有 alarms 那条定时兜底。
 */
export function scheduleAutoSync(delay = 8000) {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    runAutoSync();
  }, delay);
}

export async function runAutoSync() {
  try {
    const config = await loadConfig();
    if (!config.enabled || !config.auto) return;
    await syncNow({ direction: 'both' });
  } catch (err) {
    // 自动同步失败只记状态，绝不弹窗、也不影响翻译本身；设置页会显示原因
    console.warn('[MikeLingo] 自动同步失败：', err?.message || err);
  }
}

export const Sync = {
  loadConfig,
  getConfig,
  saveConfig,
  getState,
  testRemote,
  syncNow,
  buildBackup,
  applyBackup,
  scheduleAutoSync,
  runAutoSync
};
