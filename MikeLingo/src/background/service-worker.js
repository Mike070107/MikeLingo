import '../common/shared.js';
import { VocabStore } from './vocab-store.js';
import { Dictionary } from './dictionary.js';
import { Speech } from './speech.js';
import { Sync } from './sync.js';

const DST = globalThis.DST;

/* ---------------------------------- 缓存 ---------------------------------- */

const DB_NAME = 'dst-cache';
const STORE = 'translations';
const MAX_ENTRIES = 20000;
const memoryCache = new Map();

let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'k' });
          store.createIndex('at', 'at');
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

async function cacheGet(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  try {
    const db = await openDB();
    const value = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.v : null);
      req.onerror = () => reject(req.error);
    });
    if (value != null) memoryCache.set(key, value);
    return value;
  } catch {
    return null;
  }
}

async function cachePut(entries) {
  for (const [k, v] of entries) memoryCache.set(k, v);
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const at = Date.now();
      for (const [k, v] of entries) store.put({ k, v, at });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    prune();
  } catch {
    /* 缓存失败不影响翻译 */
  }
}

let pruning = false;
async function prune() {
  if (pruning) return;
  pruning = true;
  try {
    const db = await openDB();
    const count = await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
    if (count > MAX_ENTRIES) {
      let toDelete = count - Math.floor(MAX_ENTRIES * 0.8);
      await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        const cursorReq = tx.objectStore(STORE).index('at').openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || toDelete <= 0) return resolve();
          cursor.delete();
          toDelete--;
          cursor.continue();
        };
        cursorReq.onerror = () => resolve();
      });
    }
  } finally {
    pruning = false;
  }
}

async function cacheStats() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

async function cacheClear() {
  memoryCache.clear();
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

/* --------------------------------- API 调用 -------------------------------- */

function buildSystemPrompt(settings) {
  const lang = settings.targetLang;
  let prompt =
    `You are a professional translation engine. Translate everything the user sends into ${lang}.\n` +
    `Rules:\n` +
    `1. Output natural, fluent ${lang}; keep the original tone, register and technical terminology.\n` +
    `2. Keep numbers, URLs, e-mail addresses, code identifiers, file names and brand names unchanged.\n` +
    `3. Never explain, never answer questions in the text, never add or drop information.\n` +
    `4. The input consists of segments written as <seg id="N">text</seg>.\n` +
    `   Return EXACTLY the same segments, same ids, same order, same wrapper, ` +
    `with only the translated text inside. Return nothing else — no markdown, no notes.\n` +
    `5. If a segment is already in ${lang} or cannot be translated, return it unchanged.`;
  if (settings.customPrompt) {
    prompt += `\nAdditional instructions from the user (highest priority):\n${settings.customPrompt}`;
  }
  return prompt;
}

/**
 * 词典详解的提示词。翻译通道明确禁止模型解释（见 buildSystemPrompt 第 3 条），
 * 所以详解必须单独发一次请求，用另一套提示词。
 * 要求返回严格 JSON：形状固定，UI 才能稳定渲染；示例写死在提示词里，模型照抄结构最可靠。
 */
function buildExplainPrompt(lang) {
  return (
    `You are a bilingual dictionary for a learner whose language is ${lang}.\n` +
    `Explain the user's text and return ONLY a JSON object — no markdown fence, no commentary:\n` +
    `{"title":"","kind":"word|phrase|proper|sentence","summary":"","senses":[{"pos":"","meaning":"","detail":""}],` +
    `"examples":[{"src":"","trans":""}],"notes":"","related":[""]}\n` +
    `Rules:\n` +
    `1. Write title in the ORIGINAL language (properly capitalized). Write summary, meaning, detail, notes and ` +
    `every trans in ${lang}. Keep each "src" in the original language of the input.\n` +
    `2. kind: "proper" for names of people, places, brands, products, organizations; "word" for a single common ` +
    `word; "phrase" for a multi-word expression; "sentence" for a full sentence.\n` +
    `3. senses: 1-4 entries ordered by frequency. "pos" is a short part-of-speech tag ` +
    `(n. / v. / adj. / adv. / phr.), "" when not applicable. "meaning" is the short gloss, ` +
    `"detail" adds what a learner needs — for a proper noun: what/where it is, why it is known, ` +
    `for a sentence: the key structure or idiom.\n` +
    `4. examples: 1-3 short, natural sentences that actually use the term, each with its ${lang} translation.\n` +
    `5. notes: usage, register, common confusions or look-alikes; "" if there is nothing worth saying.\n` +
    `6. related: 0-6 collocations, synonyms or closely related terms.\n` +
    `7. Never omit a field — use "" or [] when empty. Output must be parseable by JSON.parse.`
  );
}

/** 模型经常把 JSON 裹在 ``` 里或前后带一句废话，这里只取第一个完整的对象 */
function parseJsonObject(output) {
  const text = String(output || '').replace(/^\s*```[a-z]*\s*|\s*```\s*$/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const EXPLAIN_MAX_TOKENS = 900;

/**
 * 查词典式详解。返回 DST.normalizeExplain 规整过的对象。
 * 结果按「模型 + 目标语言 + 原文」缓存，同一个词再划不会重复计费。
 */
async function explainText(text, { targetLang } = {}) {
  const clean = String(text || '').trim();
  if (!DST.isExplainable(clean)) {
    const err = new Error(`只能给 ${DST.EXPLAIN_MAX_CHARS} 字以内的词、短语或句子做详解`);
    err.code = 'NOT_EXPLAINABLE';
    throw err;
  }

  const base = await DST.loadSettings();
  const settings = targetLang ? DST.normalizeSettings(Object.assign({}, base, { targetLang })) : base;
  limiter.configure(settings);
  // 详解可以指到与翻译不同的接口：翻译用 qwen-mt 这类专用模型，详解用通用对话模型
  const provider = DST.explainProvider(settings);
  const apiKey = await DST.loadApiKey(provider.id);
  if (!apiKey) {
    const err = new Error(`详解使用的接口「${provider.name}」尚未配置 API Key，请先在扩展设置中填写`);
    err.code = 'NO_API_KEY';
    throw err;
  }
  // qwen-mt 这类翻译专用模型不看 system prompt，只会把原文翻一遍，出不了详解
  if (DST.isTranslationOnlyModel(provider.model)) {
    const err = new Error(
      `详解用到的是翻译专用模型 ${provider.model}（接口「${provider.name}」），它只能翻译，做不了词典详解。` +
        `请到设置页「划词翻译 → 详解使用的模型」填一个通用对话模型，如 qwen-plus、deepseek-chat。`
    );
    err.code = 'MT_UNSUPPORTED';
    throw err;
  }

  const hash = await DST.hashText(clean);
  const cacheKey = `explain|${provider.model}|${settings.targetLang}|${hash}`;
  if (settings.cacheEnabled) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const normalized = DST.normalizeExplain(cached);
      if (normalized) return { explain: normalized, cached: true };
    }
  }

  const output = await withRetry(
    () =>
      callChat(
        [
          { role: 'system', content: buildExplainPrompt(settings.targetLang) },
          { role: 'user', content: clean }
        ],
        provider,
        apiKey,
        { maxTokens: EXPLAIN_MAX_TOKENS }
      ),
    settings
  );

  const explain = DST.normalizeExplain(parseJsonObject(output));
  if (!explain) {
    const err = new Error('接口没有按格式返回详解，可能是模型能力不足，可换一个模型再试');
    err.code = 'BAD_EXPLAIN';
    throw err;
  }
  if (settings.cacheEnabled) cachePut([[cacheKey, explain]]);
  return { explain, cached: false };
}

function sanitizeSegment(text) {
  return String(text).replace(/<\/?seg\b/gi, '‹seg').replace(/\s+/g, ' ').trim();
}

function buildUserContent(items) {
  return items.map(({ id, text }) => `<seg id="${id}">${sanitizeSegment(text)}</seg>`).join('\n');
}

function parseSegments(output) {
  const result = new Map();
  const text = String(output || '').replace(/^```[a-z]*\n?|```$/gim, '');
  const re = /<seg\s+id=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/seg>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = m[2].trim();
    if (value) result.set(Number(m[1]), value);
  }
  return result;
}

function friendlyHttpError(status, bodyText) {
  let detail = '';
  let code = '';
  try {
    const json = JSON.parse(bodyText);
    detail = json?.error?.message || json?.message || json?.error || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
    code = String(json?.error?.code || json?.code || '');
  } catch {
    detail = String(bodyText || '').slice(0, 300);
  }
  const hints = {
    400: '请求格式错误，请检查模型名称是否正确',
    401: 'API Key 无效或未授权，请检查密钥',
    402: '账户余额不足，请前往该接口所属平台充值',
    403: '无权访问该模型或接口',
    404: '接口地址不存在，请检查设置页里该接口的 API 地址',
    422: '请求参数不合法',
    429: '请求过于频繁，已触发限流，请到设置页把「并发请求数」调低或填写「每分钟请求上限」',
    500: '服务端错误，请稍后重试',
    503: '服务暂时不可用（可能是服务器繁忙）'
  };
  // 服务商常用 404 表示"模型名不存在"（阿里云百炼返回 model_not_found / Model not exist.），
  // 按地址来提示会把人引到错的地方，所以这一种单独拎出来说模型
  const hint =
    status === 404 && /model/i.test(`${code} ${detail}`)
      ? '该接口上没有这个模型，请检查设置页里该接口的模型名'
      : hints[status] || '接口返回错误';
  const err = new Error(detail ? `${hint}（HTTP ${status}）：${detail}` : `${hint}（HTTP ${status}）`);
  err.status = status;
  return err;
}

/* -------------------------------- 请求闸门 -------------------------------- */

/**
 * 所有打到模型接口的请求都从这里过。
 *
 * 为什么必须有：页面侧的「并发请求数」只管同时发几批，实际瞬时并发会被放大好几倍——
 * qwen-mt 这类翻译专用模型批内还要逐条单发，解析不全时的二分重试又会再叠一层，
 * 加上多个标签页共用一个后台，设成 3 也可能一瞬间打出十几个请求，
 * 阿里云百炼这种按 RPM 限流的服务商开整页翻译第一下就报 429。
 *
 * 闸门做三件事：
 * 1. maxConcurrent —— 全局同时在飞的请求数封顶（取设置里的并发数，跨标签页共享）；
 * 2. minInterval —— 两次请求之间的最小间隔，由「每分钟请求上限」换算，0 表示不限；
 * 3. 自适应 —— 收到 429 就按 Retry-After（没有就指数退避）进入全局冷却，
 *    并把间隔翻倍；连续成功若干次后再逐步降回去。
 *    用户什么都不改也能自己收敛到服务商接受的速率，而不是把错误直接甩到页面上。
 */
const ADAPTIVE_MIN_INTERVAL = 300; // 首次触发限流后的起步间隔
const ADAPTIVE_MAX_INTERVAL = 8000; // 间隔上限，再慢就该提示用户换模型或提额度了
const ADAPTIVE_DECAY_AFTER = 8; // 连续成功多少次放宽一档

const limiter = {
  maxConcurrent: 3,
  baseInterval: 0,
  adaptiveInterval: 0,
  cooldownUntil: 0,
  running: 0,
  lastStart: 0,
  okStreak: 0,
  waiters: [],
  timer: null,

  configure(settings) {
    this.maxConcurrent = Math.max(1, Number(settings?.concurrency) || 1);
    const rpm = Number(settings?.rpm) || 0;
    this.baseInterval = rpm > 0 ? Math.ceil(60000 / rpm) : 0;
  },

  interval() {
    return Math.max(this.baseInterval, this.adaptiveInterval);
  },

  async run(fn) {
    await this.acquire();
    try {
      const result = await fn();
      this.reward();
      return result;
    } finally {
      this.release();
    }
  },

  acquire() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  },

  drain() {
    if (this.timer) return; // 已经有定时器在等下一个发车时刻，到点再统一放行
    while (this.waiters.length && this.running < this.maxConcurrent) {
      const now = Date.now();
      const wait = Math.max(this.cooldownUntil - now, this.lastStart + this.interval() - now);
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.drain();
        }, wait);
        return;
      }
      this.running++;
      this.lastStart = now;
      this.waiters.shift()();
    }
  },

  release() {
    this.running = Math.max(0, this.running - 1);
    this.drain();
  },

  /** 收到 429：全局冷却 + 放慢节奏。retryAfterMs 来自响应头，没有就用退避值 */
  penalize(retryAfterMs) {
    this.okStreak = 0;
    this.adaptiveInterval = this.adaptiveInterval
      ? Math.min(this.adaptiveInterval * 2, ADAPTIVE_MAX_INTERVAL)
      : ADAPTIVE_MIN_INTERVAL;
    const cool = Math.max(Number(retryAfterMs) || 0, this.adaptiveInterval);
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cool);
    this.drain();
  },

  /** 连续成功就把自适应间隔慢慢还回去，别让一次限流永久拖慢后面所有页面 */
  reward() {
    if (!this.adaptiveInterval) return;
    if (++this.okStreak < ADAPTIVE_DECAY_AFTER) return;
    this.okStreak = 0;
    this.adaptiveInterval =
      this.adaptiveInterval <= ADAPTIVE_MIN_INTERVAL ? 0 : Math.floor(this.adaptiveInterval / 2);
  }
};

/** Retry-After 可能是秒数，也可能是 HTTP 日期；上限 60 秒，免得挂在那儿不动 */
function parseRetryAfter(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, 60000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 60000) : 0;
}

/** provider: { baseUrl, model, temperature, timeout }；translationOptions 供 qwen-mt 类模型使用 */
function callChat(messages, provider, apiKey, options = {}) {
  return limiter.run(() => callChatOnce(messages, provider, apiKey, options));
}

async function callChatOnce(messages, provider, apiKey, { maxTokens, translationOptions } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeout);
  const url = `${provider.baseUrl}/chat/completions`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: false,
        // 翻译专用模型不接受 temperature/自定义提示，只认 translation_options
        ...(translationOptions
          ? { translation_options: translationOptions }
          : { temperature: provider.temperature, ...(maxTokens ? { max_tokens: maxTokens } : {}) })
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`请求超时（${Math.round(provider.timeout / 1000)} 秒），可尝试调小每批段落数或增大超时时间`);
      e.retryable = true;
      throw e;
    }
    const e = new Error(`网络请求失败：${err.message}。请检查网络、代理或 API 地址是否可达`);
    e.retryable = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = friendlyHttpError(response.status, body);
    err.retryable = response.status === 429 || response.status >= 500;
    if (response.status === 429) {
      err.retryAfter = parseRetryAfter(response);
      limiter.penalize(err.retryAfter); // 让还在排队的请求一起等，而不是接着打
    }
    throw err;
  }

  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const err = new Error('接口返回内容为空，可能是模型不支持该请求');
    err.retryable = true;
    throw err;
  }
  return content;
}

/**
 * 限流（429）单独给更多重试次数：它不是"错了"，只是"太快了"，
 * 等一会儿必定能成，没必要按普通错误的次数直接放弃，让用户看见红字。
 */
const RATE_LIMIT_RETRIES = 5;

async function withRetry(fn, settings) {
  let lastError;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const rateLimited = err.status === 429;
      const budget = rateLimited ? Math.max(settings.maxRetries, RATE_LIMIT_RETRIES) : settings.maxRetries;
      if (!err.retryable || attempt >= budget) break;
      // 429 的等待主要由闸门的全局冷却负责，这里再加一点抖动，避免几个并发请求同时醒来又撞一次
      const delay = rateLimited
        ? Math.max(err.retryAfter || 0, 600 * Math.pow(2, attempt)) + Math.random() * 400
        : 800 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
  throw lastError;
}

const MT_CONCURRENCY = 4;

/**
 * qwen-mt 类模型：不能批量分段，逐条单发并带上 translation_options。
 * 单条失败不拖累整批；全部失败才把真实错误抛出去。
 */
async function translateItemsMt(items, settings, provider, apiKey) {
  const translationOptions = { source_lang: 'auto', target_lang: DST.mtTargetLang(settings.targetLang) };
  const results = new Map();
  const errors = [];
  const queue = items.slice();

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const output = await withRetry(
          () => callChat([{ role: 'user', content: item.text }], provider, apiKey, { translationOptions }),
          settings
        );
        const value = String(output).replace(/<\/?seg[^>]*>/gi, '').trim();
        if (value) results.set(item.id, value);
      } catch (err) {
        errors.push(err);
      }
    }
  };

  // 真正的发送节奏由请求闸门统一控制，这里只是别一次性排出成百上千个等待者
  const workers = Math.min(MT_CONCURRENCY, Math.max(1, settings.concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  if (!results.size && errors.length) throw errors[0];
  return results;
}

/** 翻译一组片段，返回 Map<id, 译文>；解析不全时二分重试 */
async function translateItems(items, settings, provider, apiKey, depth = 0) {
  if (!items.length) return new Map();
  if (DST.isTranslationOnlyModel(provider.model)) return translateItemsMt(items, settings, provider, apiKey);
  const messages = [
    { role: 'system', content: buildSystemPrompt(settings) },
    { role: 'user', content: buildUserContent(items) }
  ];
  const output = await withRetry(() => callChat(messages, provider, apiKey), settings);
  const parsed = parseSegments(output);

  const missing = items.filter((it) => !parsed.has(it.id));
  if (missing.length === 0) return parsed;

  // 单条且模型没按格式返回：直接取正文（去掉可能残留的标签）
  if (items.length === 1) {
    const plain = output.replace(/<\/?seg[^>]*>/gi, '').trim();
    if (plain) parsed.set(items[0].id, plain);
    return parsed;
  }
  if (depth >= 2) return parsed;

  const half = Math.ceil(missing.length / 2);
  const [a, b] = [missing.slice(0, half), missing.slice(half)];
  const [ra, rb] = await Promise.all([
    translateItems(a, settings, provider, apiKey, depth + 1).catch(() => new Map()),
    translateItems(b, settings, provider, apiKey, depth + 1).catch(() => new Map())
  ]);
  for (const [k, v] of [...ra, ...rb]) parsed.set(k, v);
  return parsed;
}

/** 对外入口：命中缓存 + 调接口。targetLang 可按次覆盖（弹窗里的即时翻译用） */
async function translateTexts(texts, { targetLang } = {}) {
  const base = await DST.loadSettings();
  const settings = targetLang ? DST.normalizeSettings(Object.assign({}, base, { targetLang })) : base;
  limiter.configure(settings); // 用户改了并发/RPM 立即生效，不用重载扩展
  const provider = DST.activeProvider(settings);
  const apiKey = await DST.loadApiKey(provider.id);
  if (!apiKey) {
    const err = new Error(`接口「${provider.name}」尚未配置 API Key，请先在扩展设置中填写`);
    err.code = 'NO_API_KEY';
    throw err;
  }

  const results = new Array(texts.length).fill(null);
  const pending = [];
  const keys = new Array(texts.length).fill(null);

  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] || '').trim();
    if (!text) {
      results[i] = '';
      continue;
    }
    if (settings.cacheEnabled) {
      const hash = await DST.hashText(text);
      const key = `${provider.model}|${settings.targetLang}|${hash}`;
      keys[i] = key;
      const cached = await cacheGet(key);
      if (cached) {
        results[i] = cached;
        continue;
      }
    }
    pending.push({ id: i, text });
  }

  if (pending.length) {
    const translated = await translateItems(pending, settings, provider, apiKey);
    const toCache = [];
    for (const item of pending) {
      const value = translated.get(item.id);
      if (value) {
        results[item.id] = value;
        if (settings.cacheEnabled && keys[item.id]) toCache.push([keys[item.id], value]);
      }
    }
    if (toCache.length) cachePut(toCache);
  }
  return results;
}

/** override: { provider: {...}, apiKey } —— 用设置页当前填写的内容测，不必先保存 */
async function testConnection(override = {}) {
  const settings = await DST.loadSettings();
  const provider = DST.normalizeProvider(
    Object.assign({}, DST.activeProvider(settings), override.provider || {}),
    0,
    new Set()
  );
  const apiKey = override.apiKey || (await DST.loadApiKey(provider.id));
  if (!apiKey) throw new Error('请先填写 API Key');
  const started = Date.now();
  const sample = 'Hello, world! This is a connection test.';
  const isMt = DST.isTranslationOnlyModel(provider.model);
  const output = await callChat(
    isMt
      ? [{ role: 'user', content: sample }]
      : [
          { role: 'system', content: `Translate to ${settings.targetLang}. Output only the translation.` },
          { role: 'user', content: sample }
        ],
    provider,
    apiKey,
    isMt
      ? { translationOptions: { source_lang: 'auto', target_lang: DST.mtTargetLang(settings.targetLang) } }
      : { maxTokens: 64 }
  );
  return { latency: Date.now() - started, sample: output.trim().slice(0, 120), model: provider.model };
}

/* -------------------------------- 页面状态 -------------------------------- */

const tabState = new Map(); // tabId -> { active, mode, done, total }

function updateBadge(tabId, state) {
  const active = state && state.active;
  chrome.action.setBadgeText({ tabId, text: active ? '译' : '' }).catch(() => {});
  if (active) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    tabState.delete(tabId);
    updateBadge(tabId, null);
  }
});

/* -------------------------------- 消息路由 -------------------------------- */

/** 测试用的音源地址覆盖，正常使用时为空（和 dictBaseUrl 一个套路） */
async function audioBases() {
  try {
    const stored = await chrome.storage.local.get(['youdaoBaseUrl', 'baiduBaseUrl']);
    return {
      youdao: String(stored.youdaoBaseUrl || '').trim(),
      baidu: String(stored.baiduBaseUrl || '').trim()
    };
  } catch {
    return { youdao: '', baidu: '' };
  }
}

/**
 * 按设置排出真人音频的候选顺序。
 *
 * 有道那条是「词典录音」，只认词条，句子一律 500；百度那条是真正的语音合成，
 * 整句、中日韩都能读。所以默认顺序是：单词先用有道（真人录音，比合成好听），
 * 拿不到（或者压根不是单词）就用百度，最后才轮到常年 502 的 dictionaryapi。
 */
async function audioCandidates(settings, text, dictAudioUrl) {
  if (settings.audioSource === 'none') return [];
  const base = await audioBases();
  const lang = DST.detectSpeechLang(text, settings.speechAccent).baidu;
  const youdao = { url: DST.youdaoAudioUrl(text, settings.speechAccent, base.youdao), label: '有道' };
  const baidu = { url: DST.baiduAudioUrl(text, lang, base.baidu), label: '百度' };
  const dict = { url: dictAudioUrl || '', label: 'dictionaryapi' };
  const order = {
    auto: [youdao, baidu, dict],
    youdao: [youdao],
    baidu: [baidu],
    dict: [dict]
  }[settings.audioSource] || [youdao, baidu, dict];
  return order.filter((s) => s.url);
}

/** 朗读参数按设置走：口音决定用哪条真人音频和哪种嗓音，语速对所有音源生效 */
async function speakRequest(msg) {
  const settings = await DST.loadSettings();
  const text = String(msg.text || '');
  const res = await Speech.speak({
    text,
    lang: msg.lang || DST.speechLang(text, settings.speechAccent),
    rate: settings.speechRate,
    audioSources: await audioCandidates(settings, text, msg.audioUrl)
  });
  // 超长内容根本没发起在线请求，得说清楚是长度问题，不然用户以为是网络挂了
  if (!res.ok && settings.audioSource !== 'none' && text.length > DST.MAX_SPEAK_CHARS) {
    return { ...res, error: `选中内容 ${text.length} 字，超过在线朗读的 ${DST.MAX_SPEAK_CHARS} 字上限，只能用系统语音。${res.error}` };
  }
  return res;
}

/** 划词卡片 / 弹窗查音标；未开启或不是单词时直接返回未找到，不打接口 */
async function dictLookup(word) {
  const settings = await DST.loadSettings();
  if (!settings.dictEnabled) return { found: false, phonetic: '', audioUrl: '', disabled: true };
  if (!DST.isLookupWord(word)) return { found: false, phonetic: '', audioUrl: '' };
  return Dictionary.lookup(word, settings.speechAccent);
}

async function openVocabPage(view) {
  const base = chrome.runtime.getURL('src/vocab/vocab.html');
  const url = `${base}${view === 'review' ? '#review' : ''}`;
  // 已经开着就切过去，别每次点都开一个新标签页
  try {
    const [existing] = await chrome.tabs.query({ url: base });
    if (existing?.id != null) {
      await chrome.tabs.update(existing.id, { active: true, url });
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch {
    // 没有 tabs 权限查不到已开标签页时，直接新开一个，不能让入口点不动
  }
  await chrome.tabs.create({ url });
}

/** 这些消息处理成功后本机数据变了，安排一次自动同步（内部有 8s 防抖，连着改不会打爆网盘） */
const SYNC_TRIGGERS = new Set([
  'VOCAB_ADD',
  'VOCAB_REMOVE',
  'VOCAB_UPDATE',
  'VOCAB_GRADE',
  'VOCAB_CLEAR',
  'VOCAB_IMPORT',
  'BACKUP_IMPORT'
]);

chrome.runtime.onMessage.addListener((msg, sender, rawSendResponse) => {
  if (msg?.target === 'offscreen') return false; // 发给 offscreen 文档的消息，这里不能抢答

  (async () => {
    // 包一层：各 case 照常调 sendResponse，改动类消息顺带触发自动同步
    const sendResponse = (payload) => {
      if (payload?.ok && SYNC_TRIGGERS.has(msg?.type)) Sync.scheduleAutoSync();
      return rawSendResponse(payload);
    };
    try {
      switch (msg?.type) {
        case 'PING':
          return sendResponse({ ok: true });
        case 'DICT_LOOKUP':
          return sendResponse({ ok: true, ...(await dictLookup(msg.word)) });
        case 'SPEAK': {
          const res = await speakRequest(msg);
          return sendResponse(res);
        }
        case 'SPEAK_STOP':
          Speech.stop();
          return sendResponse({ ok: true });
        case 'TTS_VOICES': {
          const voices = await Speech.listVoices();
          return sendResponse({
            ok: true,
            voices: voices.map((v) => ({ name: v.voiceName || '', lang: v.lang || '', remote: Boolean(v.remote) }))
          });
        }
        case 'VOCAB_ADD': {
          const entry = Object.assign({}, msg.entry);
          // 来源页面由后台补，内容脚本传过来的可能被页面脚本改过
          if (sender.tab?.url) {
            entry.sourceUrl = entry.sourceUrl || sender.tab.url;
            entry.sourceTitle = entry.sourceTitle || sender.tab.title || '';
          }
          const settings = await DST.loadSettings();
          if (!settings.vocabSaveContext) {
            entry.context = '';
            entry.sourceUrl = '';
            entry.sourceTitle = '';
          }
          const result = await VocabStore.addWord(entry);
          return sendResponse({ ok: true, entry: result.entry, created: result.created });
        }
        case 'VOCAB_REMOVE':
          await VocabStore.removeWord(msg.key);
          return sendResponse({ ok: true });
        case 'VOCAB_GET':
          return sendResponse({ ok: true, entry: await VocabStore.getWord(msg.key) });
        case 'VOCAB_LIST':
          return sendResponse({ ok: true, ...(await VocabStore.listWords(msg.query || {})) });
        case 'VOCAB_STATS':
          return sendResponse({ ok: true, stats: await VocabStore.stats() });
        case 'VOCAB_DUE':
          return sendResponse({ ok: true, items: await VocabStore.dueQueue(msg.limit) });
        case 'VOCAB_GRADE':
          return sendResponse({ ok: true, entry: await VocabStore.gradeWord(msg.key, msg.grade) });
        case 'VOCAB_UPDATE':
          return sendResponse({ ok: true, entry: await VocabStore.updateWord(msg.key, msg.patch || {}) });
        case 'VOCAB_CLEAR':
          await VocabStore.clearWords();
          return sendResponse({ ok: true });
        case 'VOCAB_EXPORT':
          return sendResponse({ ok: true, data: await VocabStore.exportWords() });
        case 'VOCAB_IMPORT':
          // 生词本页面的「导入 JSON」同样是用户手动还原，不受本机删除记录阻挡
          return sendResponse({ ok: true, result: await VocabStore.importWords(msg.payload, { ignoreLocalTombstones: true }) });
        case 'OPEN_VOCAB':
          await openVocabPage(msg.view);
          return sendResponse({ ok: true });
        case 'TRANSLATE': {
          const results = await translateTexts(msg.texts || [], { targetLang: msg.targetLang });
          return sendResponse({ ok: true, results });
        }
        case 'EXPLAIN': {
          const { explain, cached } = await explainText(msg.text || '', { targetLang: msg.targetLang });
          return sendResponse({ ok: true, explain, cached });
        }
        case 'TEST_CONNECTION': {
          const info = await testConnection(msg.override);
          return sendResponse({ ok: true, info });
        }
        case 'CACHE_STATS':
          return sendResponse({ ok: true, count: await cacheStats() });
        case 'CACHE_CLEAR':
          await cacheClear();
          return sendResponse({ ok: true });
        case 'STATE_CHANGED': {
          const tabId = sender.tab?.id;
          if (tabId != null) {
            tabState.set(tabId, msg.state);
            updateBadge(tabId, msg.state);
          }
          return sendResponse({ ok: true });
        }
        case 'OPEN_OPTIONS':
          chrome.runtime.openOptionsPage();
          return sendResponse({ ok: true });
        case 'SYNC_GET_CONFIG':
          return sendResponse({ ok: true, config: await Sync.getConfig(), state: await Sync.getState() });
        case 'SYNC_SAVE_CONFIG':
          return sendResponse({ ok: true, config: await Sync.saveConfig(msg.config || {}, msg.creds || {}) });
        case 'SYNC_TEST':
          return sendResponse({ ok: true, info: await Sync.testRemote() });
        case 'SYNC_NOW': {
          const result = await Sync.syncNow({ direction: msg.direction });
          return sendResponse({ ok: true, result, state: await Sync.getState() });
        }
        case 'BACKUP_EXPORT':
          return sendResponse({
            ok: true,
            data: await Sync.buildBackup({ includeSecrets: Boolean(msg.includeSecrets), passphrase: msg.passphrase || '' })
          });
        case 'BACKUP_IMPORT':
          return sendResponse({
            ok: true,
            result: await Sync.applyBackup(msg.payload, { passphrase: msg.passphrase || '', manual: true })
          });
        default:
          return sendResponse({ ok: false, error: `未知消息类型：${msg?.type}` });
      }
    } catch (err) {
      // retryable 让页面知道这批段落是"暂时失败"，可以排队重来，而不是永久丢掉
      sendResponse({
        ok: false,
        error: err?.message || String(err),
        code: err?.code,
        retryable: Boolean(err?.retryable)
      });
    }
  })();
  return true; // 异步响应
});

/* ------------------------------ 菜单 / 快捷键 ------------------------------ */

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'dst-translate-page',
      title: '对照翻译此页面 / 还原',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: 'dst-translate-selection',
      title: '翻译选中文本："%s"',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'dst-add-vocab',
      title: '把 "%s" 加入生词本',
      contexts: ['selection']
    });
    chrome.contextMenus.create({ id: 'dst-sep', type: 'separator', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: 'dst-vocab', title: '生词本…', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: 'dst-options', title: '翻译设置…', contexts: ['page', 'selection'] });
  });
}

/* ------------------------------ 自动同步触发 ------------------------------ */

const SYNC_ALARM = 'mikelingo-sync';
const SYNC_PERIOD_MINUTES = 30;

/**
 * 定时同步走 alarms 而不是 setInterval：service worker 闲置会被回收，
 * setInterval 跟着一起没了，alarms 能把它叫醒。
 *
 * `alarms` 权限目前**没有声明**——云同步暂时不用，不值得为它多要一个权限
 * （多一个权限，走商店渠道升级就要让所有用户重新授权一次）。
 * 所以这里全部按"可能没有 chrome.alarms"来写：没有就退化成
 * 「启动时 + 数据改动后」同步，少的只是那条 30 分钟的兜底。
 * 将来要开定时同步，只需在 manifest 的 permissions 里加回 "alarms"，这段代码不用动。
 */
function ensureSyncAlarm() {
  chrome.alarms?.create?.(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) Sync.runAutoSync();
});

// 设置在 storage.sync 里，弹窗、设置页、内容脚本改它都会走这里，比在每个入口埋钩子可靠
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[DST.SETTINGS_KEY]) Sync.scheduleAutoSync();
});

chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  ensureSyncAlarm();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  createMenus();
  ensureSyncAlarm();
  // 开浏览器先拉一次：另一台机器昨晚加的词，今天一开就在
  Sync.scheduleAutoSync(3000);
});

async function sendToTab(tabId, message, frameId) {
  try {
    await chrome.tabs.sendMessage(tabId, message, frameId != null ? { frameId } : undefined);
  } catch {
    // 内容脚本未注入（如 chrome:// 页面）时静默忽略
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'dst-options') return chrome.runtime.openOptionsPage();
  if (info.menuItemId === 'dst-vocab') return openVocabPage();
  if (!tab?.id) return;
  if (info.menuItemId === 'dst-translate-page') sendToTab(tab.id, { type: 'TOGGLE_TRANSLATE' });
  // 选区可能在 iframe 里，定向发给对应框架，卡片才会出现在选中文本旁边
  if (info.menuItemId === 'dst-translate-selection') {
    sendToTab(tab.id, { type: 'TRANSLATE_SELECTION', text: info.selectionText || '' }, info.frameId);
  }
  if (info.menuItemId === 'dst-add-vocab') {
    sendToTab(tab.id, { type: 'ADD_SELECTION_TO_VOCAB', text: info.selectionText || '' }, info.frameId);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-vocab') return openVocabPage();
  if (command !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) sendToTab(tab.id, { type: 'TOGGLE_TRANSLATE' });
});
