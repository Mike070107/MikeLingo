/**
 * 备份文件的格式定义与**纯粹的合并规则**。
 *
 * 这里不碰 chrome.storage、不碰 IndexedDB、不发网络请求，只做「两份数据怎么合成一份」，
 * 好处是同一套规则能同时给三个入口用，不会各写一份走样：
 *   - 云同步（src/background/sync.js）
 *   - 导出 / 导入备份文件（设置页）
 *   - e2e 里直接调，断言合并结果
 *
 * 合并的总原则是 **只增不减**：拿不准的时候宁可多留一条，也不要悄悄删掉用户的东西。
 * 唯一会删的是对面明确记了删除墓碑、且本机这条在墓碑之后没再动过的词条。
 */

export const BACKUP_FORMAT = 'mikelingo-backup';
export const BACKUP_VERSION = 2;

/* -------------------------------- 结构校验 -------------------------------- */

/**
 * 把外来的 JSON 归一成标准形状。文件是用户手工传进来的，什么都可能是——
 * 这里只保证结构，字段级的清洗仍交给各自的 normalize（设置走 DST.normalizeSettings，
 * 词条走 VocabStore.normalizeEntry）。
 */
export function normalizeBackup(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('文件内容不是 JSON 对象');

  // v1 是只有生词本的老导出（{version:1, words:[...]}），照样收
  if (!raw.format && Array.isArray(raw.words)) {
    return {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: Number(raw.exportedAt) || 0,
      device: '',
      settings: null,
      settingsUpdatedAt: 0,
      vocab: { words: raw.words, deleted: [] },
      secrets: null,
      secretsUpdatedAt: 0
    };
  }

  if (raw.format && raw.format !== BACKUP_FORMAT) {
    throw new Error(`这不是 MikeLingo 的备份文件（format=${raw.format}）`);
  }

  const vocab = raw.vocab && typeof raw.vocab === 'object' ? raw.vocab : {};
  return {
    format: BACKUP_FORMAT,
    version: Number(raw.version) || BACKUP_VERSION,
    exportedAt: Number(raw.exportedAt) || 0,
    device: String(raw.device || '').slice(0, 100),
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
    settingsUpdatedAt: Number(raw.settingsUpdatedAt) || 0,
    vocab: {
      words: Array.isArray(vocab.words) ? vocab.words : [],
      deleted: Array.isArray(vocab.deleted) ? vocab.deleted.filter((d) => d && d.key) : []
    },
    // 明文密钥一律不认：备份文件可能被随手发出去，明文字段等于把密钥送人
    secrets: raw.secrets && typeof raw.secrets === 'object' && raw.secrets.data ? raw.secrets : null,
    secretsUpdatedAt: Number(raw.secretsUpdatedAt) || 0
  };
}

/** 给界面用的一句话摘要：这份备份里有什么 */
export function describeBackup(backup) {
  const parts = [`${backup.vocab.words.length} 个生词`];
  if (backup.settings) parts.push('设置与接口配置');
  if (backup.secrets) parts.push('已加密的 API Key');
  if (backup.vocab.deleted.length) parts.push(`${backup.vocab.deleted.length} 条删除记录`);
  return parts.join('、');
}

/* -------------------------------- 设置合并 -------------------------------- */

/**
 * 设置整体按「谁改得晚谁说了算」，但有两处必须按并集来，否则用户会莫名其妙丢东西：
 *
 *   - providers：在 A 机器加的接口，不该因为 B 机器的设置改得更晚就消失。
 *     同 id 冲突时才用晚的那一份。
 *   - autoTranslateSites：两边加过的站点取并集。
 *
 * 代价是「删接口 / 删站点」这两个动作不会跨设备传播（另一台再同步回来就复活了）。
 * 这是刻意的取舍：误删比误留难挽回得多，README 里写明了。
 */
export function mergeSettings(local, remote) {
  if (!remote.settings) return { settings: local.settings, updatedAt: local.updatedAt, changed: false };
  if (!local.settings) return { settings: remote.settings, updatedAt: remote.updatedAt, changed: true };

  const remoteNewer = Number(remote.updatedAt) > Number(local.updatedAt);
  const win = remoteNewer ? remote.settings : local.settings;
  const lose = remoteNewer ? local.settings : remote.settings;

  const merged = Object.assign({}, lose, win);

  // 接口按 id 并集，冲突取晚的那份
  const byId = new Map();
  for (const p of Array.isArray(lose.providers) ? lose.providers : []) if (p?.id) byId.set(p.id, p);
  for (const p of Array.isArray(win.providers) ? win.providers : []) if (p?.id) byId.set(p.id, p);
  merged.providers = [...byId.values()];

  // 晚的那份指向的接口若已不存在（对面删过），回落到第一个，避免 activeProviderId 悬空
  if (!merged.providers.some((p) => p.id === merged.activeProviderId)) {
    merged.activeProviderId = merged.providers[0]?.id || '';
  }

  const sites = new Set();
  for (const s of Array.isArray(lose.autoTranslateSites) ? lose.autoTranslateSites : []) sites.add(s);
  for (const s of Array.isArray(win.autoTranslateSites) ? win.autoTranslateSites : []) sites.add(s);
  merged.autoTranslateSites = [...sites];

  return {
    settings: merged,
    updatedAt: Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0),
    changed: remoteNewer || merged.providers.length !== (local.settings.providers || []).length
  };
}

/* -------------------------------- 密钥合并 -------------------------------- */

/**
 * 密钥按接口 id 并集，同 id 冲突取更新的一侧。
 * 本机没有、对面有的直接补上——这正是「换台电脑自动带出 API Key」要的效果。
 */
export function mergeApiKeys(local, remote) {
  const localMap = local.keys && typeof local.keys === 'object' ? local.keys : {};
  const remoteMap = remote.keys && typeof remote.keys === 'object' ? remote.keys : {};
  const remoteNewer = Number(remote.updatedAt) > Number(local.updatedAt);

  const merged = {};
  const ids = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);
  let added = 0;
  let replaced = 0;
  for (const id of ids) {
    const a = typeof localMap[id] === 'string' ? localMap[id] : '';
    const b = typeof remoteMap[id] === 'string' ? remoteMap[id] : '';
    if (a && b) {
      const pick = a === b ? a : remoteNewer ? b : a;
      if (pick !== a) replaced++;
      merged[id] = pick;
    } else if (a || b) {
      if (!a) added++;
      merged[id] = a || b;
    }
  }
  return { keys: merged, updatedAt: Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0), added, replaced };
}

/* ------------------------------ 生词本墓碑 ------------------------------ */

export const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000; // 删除记录留半年，够任何一台设备同步回来了

/** 过期的删除记录不再传播，否则备份文件会越滚越大 */
export function pruneTombstones(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && d.key && now - (Number(d.at) || 0) < TOMBSTONE_TTL)
    .map((d) => ({ key: String(d.key), at: Number(d.at) || 0 }));
}

/** 两侧删除记录取并集，同 key 取更晚的那次删除 */
export function mergeTombstones(a, b, now = Date.now()) {
  const map = new Map();
  for (const d of pruneTombstones(a, now)) map.set(d.key, d.at);
  for (const d of pruneTombstones(b, now)) {
    if (!map.has(d.key) || map.get(d.key) < d.at) map.set(d.key, d.at);
  }
  return [...map.entries()].map(([key, at]) => ({ key, at }));
}
