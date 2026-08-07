/**
 * 生词本存储与复习排程。
 *
 * 只有 service worker 直接碰这个库，页面（弹窗 / 生词本页 / 内容脚本）一律走消息，
 * 避免多个上下文各开一个 IndexedDB 连接后版本升级互相卡住。
 *
 * 排程逻辑在 ../common/schedule.js，页面预告下次复习时间时用的是同一份代码。
 */
import { GRADES, MASTERED_INTERVAL, schedule, statusOf } from '../common/schedule.js';

const DB_NAME = 'dst-vocab';
const DB_VERSION = 1;
const STORE = 'words';
const DICT_STORE = 'dict'; // 词典查询结果缓存，免得同一个词反复打接口

const MAX_WORDS = 20000;
const DICT_TTL = 180 * 24 * 3600 * 1000; // 音标基本不变，缓存半年

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('createdAt', 'createdAt');
          store.createIndex('due', 'due');
        }
        if (!db.objectStoreNames.contains(DICT_STORE)) {
          db.createObjectStore(DICT_STORE, { keyPath: 'word' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* --------------------------------- 词条读写 -------------------------------- */

function normalizeEntry(raw) {
  const word = String(raw.word || '').trim().slice(0, 200);
  const lang = raw.lang === 'zh' ? 'zh' : 'en';
  return {
    key: `${lang}|${word.toLowerCase()}`,
    word,
    lang,
    translation: String(raw.translation || '').trim().slice(0, 1000),
    phonetic: String(raw.phonetic || '').trim().slice(0, 80),
    audioUrl: /^https?:\/\//.test(raw.audioUrl || '') ? String(raw.audioUrl).slice(0, 500) : '',
    // 词典详解：查过一次就跟着词条走，复习时不用再打接口（normalizeExplain 会兜底成 null）
    explain: globalThis.DST?.normalizeExplain(raw.explain) || null,
    context: String(raw.context || '').trim().slice(0, 500),
    sourceUrl: /^https?:\/\//.test(raw.sourceUrl || '') ? String(raw.sourceUrl).slice(0, 500) : '',
    sourceTitle: String(raw.sourceTitle || '').trim().slice(0, 200),
    note: String(raw.note || '').trim().slice(0, 500),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Date.now(),
    // 排程字段：新词立刻到期，加进来就能复习
    due: Number(raw.due) || Date.now(),
    interval: Number(raw.interval) || 0,
    ease: Number(raw.ease) || 2.5,
    reps: Number(raw.reps) || 0,
    lapses: Number(raw.lapses) || 0,
    lastGrade: GRADES.includes(raw.lastGrade) ? raw.lastGrade : '',
    lastReviewedAt: Number(raw.lastReviewedAt) || 0
  };
}

async function addWord(raw) {
  const word = String(raw?.word || '').trim();
  if (!word) throw new Error('没有可加入的内容');
  if (word.length > 200) throw new Error('选中的内容太长，生词本只收 200 字以内的词或短句');

  const db = await openDB();
  const key = `${raw.lang === 'zh' ? 'zh' : 'en'}|${word.toLowerCase()}`;
  const existing = await reqAsPromise(tx(db, STORE, 'readonly').get(key));
  if (existing) {
    // 已存在就补齐上次没拿到的信息（比如当时音标还没查回来），不重置复习进度
    const merged = normalizeEntry({
      ...existing,
      translation: raw.translation || existing.translation,
      phonetic: raw.phonetic || existing.phonetic,
      audioUrl: raw.audioUrl || existing.audioUrl,
      explain: raw.explain || existing.explain,
      context: existing.context || raw.context,
      sourceUrl: existing.sourceUrl || raw.sourceUrl,
      sourceTitle: existing.sourceTitle || raw.sourceTitle
    });
    await reqAsPromise(tx(db, STORE, 'readwrite').put(merged));
    return { entry: merged, created: false };
  }

  const count = await reqAsPromise(tx(db, STORE, 'readonly').count());
  if (count >= MAX_WORDS) throw new Error(`生词本最多保存 ${MAX_WORDS} 条，请先清理一些`);

  const entry = normalizeEntry(raw);
  await reqAsPromise(tx(db, STORE, 'readwrite').put(entry));
  return { entry, created: true };
}

async function getWord(key) {
  const db = await openDB();
  return (await reqAsPromise(tx(db, STORE, 'readonly').get(key))) || null;
}

async function removeWord(key) {
  const db = await openDB();
  await reqAsPromise(tx(db, STORE, 'readwrite').delete(key));
  return true;
}

async function updateWord(key, patch) {
  const db = await openDB();
  const existing = await reqAsPromise(tx(db, STORE, 'readonly').get(key));
  if (!existing) throw new Error('这条生词已经不在生词本里了');
  const next = normalizeEntry({ ...existing, ...patch, key: existing.key, createdAt: existing.createdAt });
  await reqAsPromise(tx(db, STORE, 'readwrite').put(next));
  return next;
}

async function allWords() {
  const db = await openDB();
  return (await reqAsPromise(tx(db, STORE, 'readonly').getAll())) || [];
}

/** filter: all | due | new | learning | mastered；sort: added | due | alpha */
async function listWords({ filter = 'all', search = '', sort = 'added', limit = 500, offset = 0 } = {}) {
  const now = Date.now();
  const q = String(search || '').trim().toLowerCase();
  let items = await allWords();

  if (q) {
    items = items.filter(
      (it) =>
        it.word.toLowerCase().includes(q) ||
        it.translation.toLowerCase().includes(q) ||
        it.note.toLowerCase().includes(q)
    );
  }
  if (filter === 'due') items = items.filter((it) => it.due <= now);
  else if (filter !== 'all') items = items.filter((it) => statusOf(it) === filter);

  const sorters = {
    added: (a, b) => b.createdAt - a.createdAt,
    due: (a, b) => a.due - b.due,
    alpha: (a, b) => a.word.localeCompare(b.word, 'en')
  };
  items.sort(sorters[sort] || sorters.added);

  return { total: items.length, items: items.slice(offset, offset + limit).map((it) => ({ ...it, status: statusOf(it) })) };
}

async function stats() {
  const now = Date.now();
  const items = await allWords();
  let due = 0;
  let fresh = 0;
  let learning = 0;
  let mastered = 0;
  for (const it of items) {
    if (it.due <= now) due++;
    const s = statusOf(it);
    if (s === 'new') fresh++;
    else if (s === 'learning') learning++;
    else mastered++;
  }
  return { total: items.length, due, new: fresh, learning, mastered };
}

/** 复习队列：先到期的在前，新词穿插在后面 */
async function dueQueue(limit = 50) {
  const now = Date.now();
  const items = (await allWords()).filter((it) => it.due <= now);
  items.sort((a, b) => {
    const sa = statusOf(a) === 'new' ? 1 : 0;
    const sb = statusOf(b) === 'new' ? 1 : 0;
    if (sa !== sb) return sa - sb; // 先复习旧词，再学新词
    return a.due - b.due;
  });
  return items.slice(0, limit).map((it) => ({ ...it, status: statusOf(it) }));
}

async function gradeWord(key, grade, now = Date.now()) {
  if (!GRADES.includes(grade)) throw new Error(`未知的复习评分：${grade}`);
  const db = await openDB();
  const existing = await reqAsPromise(tx(db, STORE, 'readonly').get(key));
  if (!existing) throw new Error('这条生词已经不在生词本里了');
  const next = { ...existing, ...schedule(existing, grade, now), updatedAt: now };
  await reqAsPromise(tx(db, STORE, 'readwrite').put(next));
  return { ...next, status: statusOf(next) };
}

async function clearWords() {
  const db = await openDB();
  await reqAsPromise(tx(db, STORE, 'readwrite').clear());
  return true;
}

/** 导出全量数据，生词本是用户自己攒的资产，必须能带走 */
async function exportWords() {
  const items = await allWords();
  items.sort((a, b) => a.createdAt - b.createdAt);
  return { version: 1, exportedAt: Date.now(), count: items.length, words: items };
}

/** 导入：同词按 createdAt 早的为准，复习进度取更靠前的（reps 多的） */
async function importWords(payload) {
  const list = Array.isArray(payload) ? payload : payload?.words;
  if (!Array.isArray(list)) throw new Error('文件格式不对，应为导出的 JSON（包含 words 数组）');

  const db = await openDB();
  let added = 0;
  let merged = 0;
  let skipped = 0;

  for (const raw of list.slice(0, MAX_WORDS)) {
    const word = String(raw?.word || '').trim();
    if (!word) {
      skipped++;
      continue;
    }
    const entry = normalizeEntry(raw);
    const existing = await reqAsPromise(tx(db, STORE, 'readonly').get(entry.key));
    if (existing) {
      const keep = (Number(existing.reps) || 0) >= (Number(entry.reps) || 0) ? existing : entry;
      const other = keep === existing ? entry : existing;
      await reqAsPromise(
        tx(db, STORE, 'readwrite').put({
          ...keep,
          translation: keep.translation || other.translation,
          phonetic: keep.phonetic || other.phonetic,
          audioUrl: keep.audioUrl || other.audioUrl,
          explain: keep.explain || other.explain,
          context: keep.context || other.context,
          createdAt: Math.min(existing.createdAt, entry.createdAt),
          updatedAt: Date.now()
        })
      );
      merged++;
    } else {
      await reqAsPromise(tx(db, STORE, 'readwrite').put(entry));
      added++;
    }
  }
  return { added, merged, skipped };
}

/* ------------------------------- 词典缓存 ------------------------------- */

async function dictCacheGet(word) {
  try {
    const db = await openDB();
    const row = await reqAsPromise(tx(db, DICT_STORE, 'readonly').get(word));
    if (!row) return null;
    if (Date.now() - row.at > DICT_TTL) return null;
    return row.data;
  } catch {
    return null;
  }
}

async function dictCachePut(word, data) {
  try {
    const db = await openDB();
    await reqAsPromise(tx(db, DICT_STORE, 'readwrite').put({ word, data, at: Date.now() }));
  } catch {
    /* 缓存失败不影响查询 */
  }
}

export const VocabStore = {
  GRADES,
  MASTERED_INTERVAL,
  schedule,
  statusOf,
  normalizeEntry,
  addWord,
  getWord,
  removeWord,
  updateWord,
  listWords,
  stats,
  dueQueue,
  gradeWord,
  clearWords,
  exportWords,
  importWords,
  dictCacheGet,
  dictCachePut
};
