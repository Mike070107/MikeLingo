/* offscreen 文档：唯一的职责是播放发音音频，成功/失败都如实回给 service worker */

let audio = null;

function stop() {
  if (!audio) return;
  try {
    audio.pause();
    audio.src = '';
  } catch {
    /* ignore */
  }
  audio = null;
}

function play(url, rate) {
  return new Promise((resolve, reject) => {
    stop();
    audio = new Audio(url);
    // 语速统一在播放端调，几个音源（有道录音 / 百度合成）才有一致的表现。
    // preservesPitch 默认就是 true，显式写上免得以后被别处改掉后变声。
    audio.playbackRate = Math.min(2, Math.max(0.5, Number(rate) || 1));
    audio.preservesPitch = true;
    audio.onerror = () => reject(new Error('发音音频加载失败'));
    // 开始播放就算成功，不等播完，免得占住消息通道
    audio.onplaying = () => resolve();
    audio.play().catch((err) => reject(new Error(err?.message || '浏览器拒绝播放音频')));
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false; // 不是给我的消息，别抢着回
  if (msg.type === 'STOP_AUDIO') {
    stop();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'PLAY_AUDIO') {
    play(msg.url, msg.rate).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err?.message || '音频播放失败' })
    );
    return true; // 异步响应
  }
  return false;
});
