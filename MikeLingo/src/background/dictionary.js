/**
 * 音标 / 真人发音查询。
 *
 * 用 dictionaryapi.dev（免费、无需密钥），只查单词——短语和句子这个接口一律 404，
 * 调用方需要先用 DST.isLookupWord 过滤。
 *
 * 查不到不算错误：卡片照常显示译文，只是没有音标，朗读回落到系统语音合成。
 */
import { VocabStore } from './vocab-store.js';

const DEFAULT_BASE = 'https://api.dictionaryapi.dev/api/v2/entries';
const LOOKUP_TIMEOUT = 6000;

/** 测试用的接口地址覆盖（e2e 跑本地假接口，不走外网）；正常使用时为空 */
async function baseUrl() {
  try {
    const stored = await chrome.storage.local.get('dictBaseUrl');
    const custom = String(stored.dictBaseUrl || '').trim().replace(/\/+$/, '');
    return custom || DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

function absoluteAudio(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) return `https:${u}`;
  return /^https?:\/\//.test(u) ? u : '';
}

/**
 * 从接口返回里挑音标和音频。
 * dictionaryapi.dev 的 phonetics 是个混杂数组：有的只有音标没音频，有的反过来，
 * 音频文件名里带 -uk / -us 区分口音，所以按口音挑，挑不到再退回任意一条。
 */
function pickPronunciation(payload, accent) {
  const entries = Array.isArray(payload) ? payload : [];
  const variants = [];
  let fallbackText = '';

  for (const entry of entries) {
    if (!fallbackText && entry?.phonetic) fallbackText = String(entry.phonetic);
    for (const p of Array.isArray(entry?.phonetics) ? entry.phonetics : []) {
      const audio = absoluteAudio(p?.audio);
      const text = String(p?.text || '').trim();
      if (!audio && !text) continue;
      // 口音全靠文件名认：dictionaryapi.dev 是 word-uk.mp3 / word-us.mp3，
      // gstatic 那批是 word--_gb_1.mp3。别把扩展名写死成 mp3，同一批词也有 .ogg。
      const tag = /[-_]uk\.\w+(\?|$)|_gb_|british/i.test(audio)
        ? 'uk'
        : /[-_]us\.\w+(\?|$)|_us_|american/i.test(audio)
          ? 'us'
          : '';
      variants.push({ text, audio, tag });
    }
  }

  const withAudio = variants.filter((v) => v.audio);
  const preferred =
    withAudio.find((v) => v.tag === accent) || withAudio.find((v) => !v.tag) || withAudio[0] || null;
  const phonetic =
    (preferred && preferred.text) ||
    variants.find((v) => v.text && v.tag === accent)?.text ||
    variants.find((v) => v.text)?.text ||
    fallbackText ||
    '';

  return {
    phonetic: phonetic ? (phonetic.startsWith('/') ? phonetic : `/${phonetic}/`) : '',
    audioUrl: preferred ? preferred.audio : '',
    accent: preferred?.tag || ''
  };
}

/**
 * 返回 { found, phonetic, audioUrl }。
 * 查不到 / 网络失败都返回 found:false，不抛错——这是锦上添花的信息，不能拖垮翻译。
 */
async function lookup(word, accent = 'us') {
  const clean = String(word || '').trim();
  if (!clean) return { found: false, phonetic: '', audioUrl: '' };

  const cacheKey = clean.toLowerCase();
  const cached = await VocabStore.dictCacheGet(cacheKey);
  if (cached) return { ...pickPronunciation(cached, accent), found: cached.length > 0, cached: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT);
  try {
    const res = await fetch(`${await baseUrl()}/en/${encodeURIComponent(cacheKey)}`, {
      signal: controller.signal
    });
    if (res.status === 404) {
      await VocabStore.dictCachePut(cacheKey, []); // 记住"查不到"，别每次划词都打一遍
      return { found: false, phonetic: '', audioUrl: '' };
    }
    if (!res.ok) return { found: false, phonetic: '', audioUrl: '', error: `词典接口返回 HTTP ${res.status}` };

    const data = await res.json();
    if (!Array.isArray(data)) return { found: false, phonetic: '', audioUrl: '' };
    await VocabStore.dictCachePut(cacheKey, data);
    return { ...pickPronunciation(data, accent), found: data.length > 0 };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? '词典查询超时' : `词典查询失败：${err?.message || err}`;
    return { found: false, phonetic: '', audioUrl: '', error: reason };
  } finally {
    clearTimeout(timer);
  }
}

export const Dictionary = { lookup, pickPronunciation };
