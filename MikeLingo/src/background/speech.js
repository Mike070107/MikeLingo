/**
 * 朗读：优先播真人发音音频，没有就用系统语音合成。
 *
 * 音频不能在内容脚本里播——宿主站点的 CSP（media-src）会拦掉，而且页面自己的音频会被打断。
 * 所以统一丢给 offscreen 文档播，它用的是扩展自己的 CSP，和页面完全隔离。
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
// 发音音频只有几十 KB，4 秒还没开始播基本就是不通了。等太久会让"点了没反应"的体感很差，
// 而回落到语音合成是瞬时的，宁可早点放弃。
const AUDIO_TIMEOUT = 4000;

let creating = null; // 并发创建 offscreen 文档会抛错，用一个 promise 串起来

/** Chrome 116 以下没有 hasDocument / getContexts，查不到就当没有，交给 createDocument 兜底 */
async function hasOffscreen() {
  try {
    if (chrome.offscreen?.hasDocument) return await chrome.offscreen.hasDocument();
    if (chrome.runtime?.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts.length > 0;
    }
  } catch {
    /* 查不到就按没有处理 */
  }
  return false;
}

async function ensureOffscreen() {
  if (!chrome.offscreen?.createDocument) throw new Error('当前浏览器不支持后台音频播放');
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['AUDIO_PLAYBACK'],
        justification: '播放单词的真人发音音频'
      })
      .catch((err) => {
        // 只允许存在一个 offscreen 文档；并发创建时后来的会报这个错，已经有了就算成功
        if (!/single offscreen|already/i.test(err?.message || '')) throw err;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function playAudio(url, rate) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY_AUDIO', url, rate });
  if (!res?.ok) throw new Error(res?.error || '音频播放失败');
  return res;
}

function stopAudio() {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_AUDIO' }).catch(() => {});
}

/** 系统里装了哪些语音。查不到就返回空数组，调用方据此给出"没装语音包"的提示 */
function listVoices() {
  return new Promise((resolve) => {
    if (!chrome.tts?.getVoices) return resolve([]);
    try {
      chrome.tts.getVoices((voices) => resolve(Array.isArray(voices) ? voices : []));
    } catch {
      resolve([]);
    }
  });
}

/**
 * 语音合成失败时说清楚到底缺什么——"朗读失败"四个字帮不了任何人。
 * 分三种：一个语音都没装 / 装了但没有这个语言 / 其它。
 */
async function ttsFailureReason(lang, raw) {
  const voices = await listVoices();
  const base = String(lang || '').slice(0, 2).toLowerCase();
  if (!voices.length) {
    return '系统里没有安装任何语音包，无法用语音合成朗读。Windows：设置 → 时间和语言 → 语音 → 管理语音 → 添加语音；或在设置页把「发音音源」保持为「自动」，用在线真人发音。';
  }
  if (!voices.some((v) => String(v.lang || '').slice(0, 2).toLowerCase() === base)) {
    const have = voices.map((v) => v.lang).filter(Boolean).join('、');
    return `系统没有 ${lang} 的语音包（现有：${have}）。Windows：设置 → 时间和语言 → 语音 → 添加语音。`;
  }
  return raw || '系统语音朗读失败';
}

/**
 * 语音合成。resolve 的时机是"开始朗读"而不是"读完"，
 * 否则长句子会把消息通道占住好几秒，界面按钮一直转圈。
 */
function ttsSpeak(text, lang, rate) {
  return new Promise((resolve) => {
    if (!chrome.tts?.speak) return resolve({ ok: false, error: '当前浏览器不支持语音朗读' });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      chrome.tts.speak(text, {
        lang,
        rate,
        enqueue: false,
        onEvent: (event) => {
          if (event.type === 'start' || event.type === 'end') done({ ok: true, via: 'tts' });
          if (event.type === 'error') {
            ttsFailureReason(lang, event.errorMessage).then((error) => done({ ok: false, error }));
          }
          if (event.type === 'interrupted' || event.type === 'cancelled') done({ ok: true, via: 'tts' });
        }
      });
    } catch (err) {
      return done({ ok: false, error: `语音朗读失败：${err?.message || err}` });
    }
    // 有些平台不回 start 事件（已在朗读但没通知），超时按成功处理，不要卡住按钮
    setTimeout(() => done({ ok: true, via: 'tts' }), 1200);
  });
}

/**
 * text 必填；audioSources 是按优先级排好的候选真人音频 [{ url, label }]，
 * 逐个试，都不行才回落到系统语音合成。
 *
 * 之所以要多个候选：dictionaryapi.dev 的音频服务经常 502，只挂它一棵树就等于没有发音。
 */
async function speak({ text, lang = 'en-US', rate = 1, audioSources = [] } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: '没有可朗读的内容' };

  stop();

  const tried = [];
  for (const source of audioSources) {
    if (!source?.url) continue;
    try {
      await Promise.race([
        playAudio(source.url, rate),
        new Promise((_, reject) => setTimeout(() => reject(new Error('音频加载超时')), AUDIO_TIMEOUT))
      ]);
      return { ok: true, via: `audio:${source.label || 'audio'}` };
    } catch (err) {
      tried.push(`${source.label || 'audio'}（${err?.message || '播放失败'}）`);
    }
  }

  const res = await ttsSpeak(clean, lang, rate);
  // 在线音源和语音合成都失败时，把两边的原因一起说清楚，否则用户根本不知道该修哪一头
  if (!res.ok && tried.length) {
    return { ...res, error: `在线发音失败：${tried.join('；')}。改用系统语音也失败：${res.error}` };
  }
  return res;
}

function stop() {
  try {
    chrome.tts?.stop?.();
  } catch {
    /* ignore */
  }
  stopAudio();
}

export const Speech = { speak, stop, listVoices };
