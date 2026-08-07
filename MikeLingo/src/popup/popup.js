import '../common/shared.js';

const DST = globalThis.DST;

const el = {
  host: document.getElementById('pageHost'),
  alert: document.getElementById('alert'),
  alertText: document.getElementById('alertText'),
  alertAction: document.getElementById('alertAction'),
  toggle: document.getElementById('toggleBtn'),
  toggleLabel: document.getElementById('toggleLabel'),
  progress: document.getElementById('progress'),
  modes: Array.from(document.querySelectorAll('.segmented button')),
  selection: document.getElementById('selectionEnabled'),
  selectionText: document.getElementById('selectionTriggerText'),
  autoSite: document.getElementById('autoSite'),
  autoSiteText: document.getElementById('autoSiteText'),
  provider: document.getElementById('providerSelect'),
  quickInput: document.getElementById('quickInput'),
  quickTarget: document.getElementById('quickTarget'),
  quickBtn: document.getElementById('quickBtn'),
  quickBtnLabel: document.getElementById('quickBtnLabel'),
  quickSpinner: document.getElementById('quickSpinner'),
  quickClear: document.getElementById('quickClear'),
  quickCount: document.getElementById('quickCount'),
  quickError: document.getElementById('quickError'),
  quickErrorText: document.getElementById('quickErrorText'),
  quickErrorAction: document.getElementById('quickErrorAction'),
  quickResult: document.getElementById('quickResult'),
  quickResultLang: document.getElementById('quickResultLang'),
  quickOutput: document.getElementById('quickOutput'),
  quickCopy: document.getElementById('quickCopy'),
  quickSave: document.getElementById('quickSave'),
  quickSpeak: document.getElementById('quickSpeak'),
  quickExplain: document.getElementById('quickExplain'),
  quickExplainBtn: document.getElementById('quickExplainBtn'),
  quickPron: document.getElementById('quickPron'),
  quickPhonetic: document.getElementById('quickPhonetic'),
  quickPronHint: document.getElementById('quickPronHint'),
  openVocab: document.getElementById('openVocab'),
  vocabMeta: document.getElementById('vocabMeta')
};

let tab = null;
let settings = null;
let pageState = { active: false };
let contentAvailable = false;

const TRIGGER_TEXT = {
  button: '选中文本后显示翻译按钮',
  instant: '选中文本后立即翻译',
  alt: '按住 Alt 选中文本时翻译'
};

function showAlert(text, { action, onAction, error } = {}) {
  el.alert.hidden = false;
  el.alert.classList.toggle('error', Boolean(error));
  el.alertText.textContent = text;
  if (action) {
    el.alertAction.hidden = false;
    el.alertAction.textContent = action;
    el.alertAction.onclick = onAction;
  } else {
    el.alertAction.hidden = true;
  }
}

function hideAlert() {
  el.alert.hidden = true;
}

async function sendToTab(message) {
  if (!tab?.id) return { ok: false, error: '无法访问当前标签页' };
  try {
    return (await chrome.tabs.sendMessage(tab.id, message)) || { ok: false };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

function renderModes() {
  const mode = pageState.active ? pageState.mode : settings.displayMode;
  for (const btn of el.modes) {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
  }
}

function renderToggle() {
  el.toggle.disabled = !contentAvailable;
  el.toggle.classList.toggle('active', pageState.active);
  el.toggleLabel.textContent = pageState.active ? '还原原文' : '对照翻译此页面';
  if (!contentAvailable) {
    el.progress.textContent = '当前页面不支持翻译（浏览器内置页面或应用商店）';
  } else if (pageState.active && pageState.total) {
    el.progress.textContent = `已翻译 ${pageState.done}/${pageState.total} 个段落`;
  } else {
    el.progress.textContent = '快捷键 Alt+T · 右键菜单也可触发';
  }
}

function currentHostPattern() {
  try {
    return new URL(tab.url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function renderProviders() {
  el.provider.innerHTML = '';
  for (const provider of settings.providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = `${provider.name} · ${provider.model}`;
    el.provider.appendChild(option);
  }
  el.provider.value = settings.activeProviderId;
  el.provider.title = `当前启用：${DST.activeProvider(settings).baseUrl}`;
}

async function refresh() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await DST.loadSettings();
  const apiKey = await DST.loadApiKey(settings.activeProviderId);

  el.host.textContent = currentHostPattern() || tab?.url || '—';
  renderProviders();
  el.selection.checked = settings.selectionEnabled;
  el.selectionText.textContent = TRIGGER_TEXT[settings.selectionTrigger] || '';
  el.quickTarget.querySelector('option[value="global"]').textContent = `跟随设置（${settings.targetLang}）`;
  const host = currentHostPattern();
  el.autoSite.checked = Boolean(host) && DST.siteMatches(settings.autoTranslateSites, tab.url);
  el.autoSiteText.textContent = host ? `打开 ${host} 时自动开始翻译` : '当前页面不支持';
  el.autoSite.disabled = !host;

  const res = await sendToTab({ type: 'GET_PAGE_STATE' });
  contentAvailable = res.ok;
  pageState = res.ok ? res.state : { active: false, mode: settings.displayMode };

  if (!apiKey) {
    showAlert(`接口「${DST.activeProvider(settings).name}」尚未配置 API Key`, {
      action: '去设置',
      onAction: () => chrome.runtime.openOptionsPage()
    });
  } else if (pageState.error) {
    showAlert(pageState.error, { error: true });
  } else {
    hideAlert();
  }

  renderModes();
  renderToggle();
}

el.toggle.addEventListener('click', async () => {
  el.toggle.disabled = true;
  const res = await sendToTab({ type: 'TOGGLE_TRANSLATE' });
  if (res.ok) {
    pageState.active = res.active;
    setTimeout(refresh, 300);
  }
  renderToggle();
  window.close();
});

for (const btn of el.modes) {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    settings = await DST.saveSettings({ displayMode: mode });
    pageState.mode = mode;
    renderModes();
    if (pageState.active) await sendToTab({ type: 'SET_MODE', mode });
  });
}

// 接口互斥：选中哪个就只启用哪个，立即生效，无需保存
el.provider.addEventListener('change', async () => {
  settings = await DST.saveSettings({ activeProviderId: el.provider.value });
  renderProviders();
  await sendToTab({ type: 'SETTINGS_UPDATED' });
  await refresh();
});

el.selection.addEventListener('change', async () => {
  settings = await DST.saveSettings({ selectionEnabled: el.selection.checked });
  await sendToTab({ type: 'SETTINGS_UPDATED' });
});

el.autoSite.addEventListener('change', async () => {
  const host = currentHostPattern();
  if (!host) return;
  const list = new Set(settings.autoTranslateSites);
  if (el.autoSite.checked) list.add(host);
  else {
    for (const item of Array.from(list)) {
      if (item === host || (item.startsWith('*.') && host.endsWith(item.slice(1)))) list.delete(item);
    }
  }
  settings = await DST.saveSettings({ autoTranslateSites: Array.from(list) });
  await sendToTab({ type: 'SETTINGS_UPDATED' });
});

/* ------------------------------ 快速翻译小窗 ------------------------------ */

const QUICK_DRAFT_KEY = 'quickDraft';
let quickBusy = false;

/** 当前这次翻译的原文信息，朗读和加入生词本都从这里取 */
const quick = {
  text: '',
  translation: '',
  targetLang: '',
  phonetic: '',
  audioUrl: '',
  key: '',
  saved: false,
  explain: null,
  explainState: 'idle' // idle | loading | done | error
};

async function send(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || { ok: false, error: '扩展后台无响应' };
  } catch (err) {
    return { ok: false, error: `扩展后台连接失败：${err?.message || err}` };
  }
}

/** 自动模式：中文输入译成英文、英文输入译成中文，其它语言按全局目标语言 */
function resolveTargetLang(text) {
  const picked = el.quickTarget.value;
  const global = settings?.targetLang || '简体中文';
  if (picked === 'global') return global;
  if (picked !== 'auto') return picked;
  return DST.resolveTargetLang(text, global);
}

function showQuickError(message, { needsKey } = {}) {
  el.quickError.hidden = false;
  el.quickErrorText.textContent = message;
  el.quickErrorAction.hidden = !needsKey;
}

function hideQuickError() {
  el.quickError.hidden = true;
  el.quickErrorAction.hidden = true;
}

function setQuickBusy(busy) {
  quickBusy = busy;
  el.quickSpinner.hidden = !busy;
  el.quickBtnLabel.textContent = busy ? '翻译中…' : '翻译';
  el.quickBtn.disabled = busy || !el.quickInput.value.trim();
  el.quickClear.disabled = busy;
  el.quickTarget.disabled = busy;
}

function updateQuickCount() {
  const len = el.quickInput.value.trim().length;
  el.quickCount.textContent = len ? `${len} / 5000` : 'Ctrl+Enter';
  if (!quickBusy) el.quickBtn.disabled = !len;
  el.quickSpeak.disabled = quickBusy || !len;
}

/* ------------------------------ 音标 / 朗读 ------------------------------ */

let pronToken = 0;

/** 输入的是单个英文单词才查音标；输入一变就作废上一次结果，避免慢响应盖掉新内容 */
async function refreshPhonetic() {
  const text = el.quickInput.value.trim();
  const token = ++pronToken;
  quick.phonetic = '';
  quick.audioUrl = '';
  el.quickPronHint.textContent = '';

  if (!DST.isLookupWord(text)) {
    el.quickPron.hidden = true;
    el.quickPhonetic.textContent = '';
    return;
  }
  const res = await send({ type: 'DICT_LOOKUP', word: text });
  if (token !== pronToken) return;
  if (!res.ok || !res.phonetic) {
    el.quickPron.hidden = true;
    return;
  }
  quick.phonetic = res.phonetic;
  quick.audioUrl = res.audioUrl || '';
  el.quickPhonetic.textContent = res.phonetic;
  el.quickPron.hidden = false;
}

async function speakInput() {
  const text = el.quickInput.value.trim();
  if (!text) return;
  el.quickSpeak.disabled = true;
  el.quickSpeak.classList.add('playing');
  el.quickPronHint.textContent = '';
  const res = await send({ type: 'SPEAK', text, audioUrl: quick.audioUrl });
  el.quickSpeak.disabled = false;
  setTimeout(() => el.quickSpeak.classList.remove('playing'), 700);
  if (!res.ok) {
    el.quickPron.hidden = false;
    el.quickPronHint.textContent = res.error || '朗读失败';
  }
}

/* -------------------------------- 词典详解 -------------------------------- */

function resetQuickExplain() {
  quick.explain = null;
  quick.explainState = 'idle';
  el.quickExplain.hidden = true;
  el.quickExplain.innerHTML = '';
  el.quickExplainBtn.hidden = true;
}

function renderQuickExplain() {
  if (quick.explainState === 'loading') {
    el.quickExplain.hidden = false;
    el.quickExplain.innerHTML = '<p class="quick-explain-loading">正在查词典…</p>';
  } else if (quick.explainState === 'done' && quick.explain) {
    el.quickExplain.hidden = false;
    el.quickExplain.innerHTML = DST.explainHtml(quick.explain);
  } else if (quick.explainState === 'error') {
    el.quickExplain.hidden = true;
    el.quickExplain.innerHTML = '';
  }
  // 出错时按钮留着，用户可以再点一次重试
  el.quickExplainBtn.hidden = quick.explainState === 'loading' || quick.explainState === 'done';
  el.quickExplainBtn.textContent = quick.explainState === 'error' ? '重试详解' : '详细解释';
}

async function loadQuickExplain() {
  const text = quick.text;
  if (!text || quick.explainState === 'loading') return;
  quick.explainState = 'loading';
  hideQuickError();
  renderQuickExplain();

  const res = await send({ type: 'EXPLAIN', text, targetLang: quick.targetLang || undefined });
  if (quick.text !== text) return;

  if (res.ok && res.explain) {
    quick.explain = res.explain;
    quick.explainState = 'done';
    // 已经加进生词本的词，把详解补上去，复习时才有释义和例句
    if (quick.saved && quick.key) send({ type: 'VOCAB_UPDATE', key: quick.key, patch: { explain: res.explain } });
  } else {
    quick.explainState = 'error';
    showQuickError(res.error || '详解失败', { needsKey: res.code === 'NO_API_KEY' });
  }
  renderQuickExplain();
}

el.quickExplainBtn.addEventListener('click', loadQuickExplain);

/* -------------------------------- 加入生词本 ------------------------------- */

function renderQuickSave() {
  el.quickSave.textContent = quick.saved ? '已加入生词本' : '加入生词本';
  el.quickSave.classList.toggle('saved', quick.saved);
  el.quickSave.title = quick.saved ? '再次点击可从生词本移除' : '加入生词本，之后可以复习';
}

async function toggleQuickSave() {
  if (!quick.text) return;
  el.quickSave.disabled = true;
  if (quick.saved) {
    const res = await send({ type: 'VOCAB_REMOVE', key: quick.key });
    if (res.ok) quick.saved = false;
    else showQuickError(res.error || '移除失败');
  } else {
    const res = await send({
      type: 'VOCAB_ADD',
      entry: {
        word: quick.text,
        lang: DST.guessVocabLang(quick.text),
        translation: quick.translation,
        phonetic: quick.phonetic,
        audioUrl: quick.audioUrl,
        explain: quick.explain
      }
    });
    if (res.ok) {
      quick.saved = true;
      quick.key = res.entry.key;
      hideQuickError();
    } else {
      showQuickError(res.error || '加入生词本失败');
    }
  }
  el.quickSave.disabled = false;
  renderQuickSave();
  await refreshVocabMeta();
}

async function syncQuickSaved() {
  if (!quick.text) return;
  quick.key = DST.vocabKey(quick.text, DST.guessVocabLang(quick.text));
  const res = await send({ type: 'VOCAB_GET', key: quick.key });
  quick.saved = Boolean(res.ok && res.entry);
  renderQuickSave();
}

async function refreshVocabMeta() {
  const res = await send({ type: 'VOCAB_STATS' });
  if (!res.ok) {
    el.vocabMeta.textContent = '';
    return;
  }
  const { total, due } = res.stats;
  el.vocabMeta.textContent = total ? `${total} 条 · ${due} 待复习` : '还没有生词';
}

async function runQuickTranslate() {
  const raw = el.quickInput.value.trim();
  if (!raw || quickBusy) return;
  hideQuickError();

  const apiKey = await DST.loadApiKey(settings?.activeProviderId);
  if (!apiKey) {
    showQuickError(`接口「${DST.activeProvider(settings).name}」尚未配置 API Key`, { needsKey: true });
    return;
  }

  // 按空行/换行拆段落分别翻译，译文保留原有分行
  const parts = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const targetLang = resolveTargetLang(raw);
  setQuickBusy(true);
  el.quickResultLang.textContent = `译文 · ${targetLang}`;

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'TRANSLATE', texts: parts, targetLang });
  } catch (err) {
    res = { ok: false, error: `扩展后台连接失败：${err?.message || err}` };
  }
  setQuickBusy(false);

  if (!res || !res.ok) {
    showQuickError(res?.error || '翻译失败，请稍后重试', { needsKey: res?.code === 'NO_API_KEY' });
    return;
  }
  const text = (res.results || []).map((t, i) => String(t || parts[i] || '')).join('\n').trim();
  if (!text) {
    showQuickError('接口未返回译文，请重试或更换模型');
    return;
  }
  el.quickResult.hidden = false;
  el.quickOutput.textContent = text;
  el.quickCopy.textContent = '复制译文';

  quick.text = raw;
  quick.translation = text;
  quick.targetLang = targetLang;
  // 生词本收的是词和短句，整段文章加进去没有复习价值
  el.quickSave.hidden = raw.length > 200;
  if (!el.quickSave.hidden) await syncQuickSaved();

  // 词和短语顺手查词典详解；长句留给「详细解释」按钮，不自动多发一次请求
  resetQuickExplain();
  const mode = settings?.explainMode || DST.DEFAULT_SETTINGS.explainMode;
  if (mode !== 'off' && DST.isExplainable(raw)) {
    if (DST.shouldAutoExplain(raw, mode)) loadQuickExplain();
    else el.quickExplainBtn.hidden = false;
  }
}

let phoneticTimer = 0;
el.quickInput.addEventListener('input', () => {
  updateQuickCount();
  chrome.storage.session?.set({ [QUICK_DRAFT_KEY]: el.quickInput.value }).catch(() => {});
  clearTimeout(phoneticTimer);
  phoneticTimer = setTimeout(refreshPhonetic, 350); // 边打字边查会打太多次接口
});

el.quickInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    runQuickTranslate();
  }
});

el.quickBtn.addEventListener('click', runQuickTranslate);
el.quickTarget.addEventListener('change', () => {
  if (el.quickInput.value.trim() && !el.quickResult.hidden) runQuickTranslate();
});

el.quickClear.addEventListener('click', () => {
  el.quickInput.value = '';
  el.quickResult.hidden = true;
  el.quickOutput.textContent = '';
  el.quickPron.hidden = true;
  el.quickPhonetic.textContent = '';
  el.quickPronHint.textContent = '';
  Object.assign(quick, { text: '', translation: '', phonetic: '', audioUrl: '', key: '', saved: false });
  resetQuickExplain();
  pronToken++;
  hideQuickError();
  updateQuickCount();
  chrome.storage.session?.remove(QUICK_DRAFT_KEY).catch(() => {});
  el.quickInput.focus();
});

el.quickSpeak.addEventListener('click', speakInput);
el.quickSave.addEventListener('click', toggleQuickSave);
el.openVocab.addEventListener('click', async () => {
  await send({ type: 'OPEN_VOCAB' });
  window.close();
});

el.quickCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.quickOutput.textContent || '');
    el.quickCopy.textContent = '已复制';
    setTimeout(() => (el.quickCopy.textContent = '复制译文'), 1500);
  } catch {
    el.quickCopy.textContent = '复制失败';
  }
});

el.quickErrorAction.addEventListener('click', () => chrome.runtime.openOptionsPage());

/** 弹窗关闭会丢失输入，草稿存在 session 里，重新打开还能接着改 */
async function restoreQuickDraft() {
  try {
    const stored = await chrome.storage.session.get(QUICK_DRAFT_KEY);
    if (typeof stored[QUICK_DRAFT_KEY] === 'string') el.quickInput.value = stored[QUICK_DRAFT_KEY];
  } catch {
    /* 没有 session 存储权限时忽略 */
  }
  updateQuickCount();
  refreshPhonetic();
}

document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('openOptions2').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh();
restoreQuickDraft();
refreshVocabMeta();
