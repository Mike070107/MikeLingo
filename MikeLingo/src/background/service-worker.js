import '../common/shared.js';
import { VocabStore } from './vocab-store.js';
import { Dictionary } from './dictionary.js';
import { Speech } from './speech.js';

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
  try {
    const json = JSON.parse(bodyText);
    detail = json?.error?.message || json?.message || json?.error || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
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
    429: '请求过于频繁，已触发限流',
    500: '服务端错误，请稍后重试',
    503: '服务暂时不可用（可能是服务器繁忙）'
  };
  const hint = hints[status] || '接口返回错误';
  const err = new Error(detail ? `${hint}（HTTP ${status}）：${detail}` : `${hint}（HTTP ${status}）`);
  err.status = status;
  return err;
}

/** provider: { baseUrl, model, temperature, timeout }；translationOptions 供 qwen-mt 类模型使用 */
async function callChat(messages, provider, apiKey, { maxTokens, translationOptions } = {}) {
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

async function withRetry(fn, settings) {
  let lastError;
  for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === settings.maxRetries) break;
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
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

  await Promise.all(Array.from({ length: Math.min(MT_CONCURRENCY, items.length) }, worker));
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // 发给 offscreen 文档的消息，这里不能抢答

  (async () => {
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
          return sendResponse({ ok: true, result: await VocabStore.importWords(msg.payload) });
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
        default:
          return sendResponse({ ok: false, error: `未知消息类型：${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err), code: err?.code });
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

chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(createMenus);

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
