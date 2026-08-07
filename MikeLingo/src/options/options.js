import '../common/shared.js';
import * as updater from './updater.js';

const DST = globalThis.DST;
const $ = (id) => document.getElementById(id);

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/** 常见服务商预设：新增接口时直接填好地址和推荐模型，省得用户去翻文档 */
const PRESETS = [
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { key: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { key: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { key: 'dashscope', name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { key: 'qwen-mt', name: '通义千问 MT（翻译专用）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-mt-turbo' },
  { key: 'doubao', name: '火山方舟 豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k' },
  { key: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { key: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: 'https://', model: '' }
];

let settings = null;
let providers = [];
let activeProviderId = '';
let keyMasks = {}; // { providerId: 脱敏预览 }
let pendingKeys = {}; // { providerId: 用户新填但未保存的密钥 }
let expandedId = '';
let sites = [];

/* --------------------------------- 渲染 --------------------------------- */

function fillForm() {
  $('targetLang').value = settings.targetLang;
  $('concurrency').value = settings.concurrency;
  $('batchSize').value = settings.batchSize;
  $('batchChars').value = settings.batchChars;
  $('onlyTranslateForeign').checked = settings.onlyTranslateForeign;
  $('cacheEnabled').checked = settings.cacheEnabled;
  $('customPrompt').value = settings.customPrompt;
  $('displayMode').value = settings.displayMode;
  $('styleVariant').value = settings.styleVariant;
  $('translationFont').value = settings.translationFont;
  $('fontScale').value = settings.fontScale;
  $('selectionEnabled').checked = settings.selectionEnabled;
  $('selectionTrigger').value = settings.selectionTrigger;
  $('explainMode').value = settings.explainMode;
  $('explainModel').value = settings.explainModel;
  $('updateRepo').value = settings.updateRepo;
  renderExplainProvider(settings.explainProviderId);
  $('dictEnabled').checked = settings.dictEnabled;
  $('vocabSaveContext').checked = settings.vocabSaveContext;
  $('speechAccent').value = settings.speechAccent;
  $('speechRate').value = settings.speechRate;
  $('audioSource').value = settings.audioSource;
  sites = [...settings.autoTranslateSites];
  renderSites();
  renderPreview();
}

/* ------------------------------- 多接口管理 ------------------------------ */

function providerKeyState(id) {
  if (pendingKeys[id]) return { text: '待保存的新密钥', missing: false };
  if (keyMasks[id]) return { text: `密钥 ${keyMasks[id]}`, missing: false };
  return { text: '未配置密钥', missing: true };
}

function renderPresets() {
  const select = $('presetSelect');
  select.innerHTML = '';
  for (const preset of PRESETS) {
    const option = document.createElement('option');
    option.value = preset.key;
    option.textContent = preset.name;
    select.appendChild(option);
  }
}

function updateProviderHead(li, provider) {
  li.querySelector('.p-name-text').textContent = provider.name;
  li.querySelector('.p-meta').textContent = `${provider.model} · ${provider.baseUrl}`;
  const isActive = provider.id === activeProviderId;
  li.classList.toggle('active', isActive);
  li.querySelector('.p-badge').hidden = !isActive;
  const state = providerKeyState(provider.id);
  const keystate = li.querySelector('.p-keystate');
  keystate.textContent = state.text;
  keystate.classList.toggle('missing', state.missing);
}

function bindField(li, provider, field, transform) {
  const input = li.querySelector(`.p-${field}`);
  const label = li.querySelector(`.p-${field}-label`);
  const id = `p-${field}-${provider.id}`;
  input.id = id;
  if (label) label.htmlFor = id;
  input.value = transform ? transform.toInput(provider[field]) : provider[field];
  input.addEventListener('input', () => {
    provider[field] = transform ? transform.fromInput(input.value) : input.value;
    updateProviderHead(li, provider);
  });
  return input;
}

function renderProviders() {
  const list = $('providerList');
  list.innerHTML = '';
  for (const provider of providers) {
    const li = $('providerTpl').content.firstElementChild.cloneNode(true);
    li.dataset.id = provider.id;

    const radio = li.querySelector('.p-active');
    radio.value = provider.id;
    radio.checked = provider.id === activeProviderId;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      activeProviderId = provider.id; // 互斥：radio 同名分组天然只允许一个
      for (const item of list.children) {
        const target = providers.find((p) => p.id === item.dataset.id);
        if (target) updateProviderHead(item, target);
      }
      renderExplainProvider(); // 「跟随翻译接口（当前：X）」要跟着换
    });

    bindField(li, provider, 'name');
    const modelInput = bindField(li, provider, 'model');
    bindField(li, provider, 'baseUrl');
    bindField(li, provider, 'temperature');
    bindField(li, provider, 'timeout', {
      toInput: (ms) => Math.round(ms / 1000),
      fromInput: (v) => Math.round(Number(v) * 1000)
    });

    // 翻译专用模型（qwen-mt 等）走的是另一套调用方式，提示用户提示词类设置对它无效
    const mtNote = li.querySelector('.p-mtnote');
    const temperatureField = li.querySelector('.p-temperature').closest('.field');
    const syncMtNote = () => {
      const isMt = DST.isTranslationOnlyModel(modelInput.value);
      mtNote.hidden = !isMt;
      temperatureField.hidden = isMt; // 该类模型不接受 temperature，留着会误导
    };
    modelInput.addEventListener('input', syncMtNote);
    // 改了模型名可能让详解那条路失效，提示要跟着变
    modelInput.addEventListener('input', () => {
      renderExplainProvider();
      syncExplainProviderWarn();
    });
    syncMtNote();

    const body = li.querySelector('.provider-body');
    const toggle = li.querySelector('.p-toggle');
    // 只在点击时改 expandedId：渲染循环里改会被前一个折叠项清空，导致该展开的那个也收起来
    const applyExpanded = (open) => {
      body.hidden = !open;
      toggle.textContent = open ? '收起' : '编辑';
      toggle.setAttribute('aria-expanded', String(open));
    };
    applyExpanded(provider.id === expandedId);
    toggle.addEventListener('click', () => {
      const open = body.hidden;
      expandedId = open ? provider.id : '';
      applyExpanded(open);
    });

    li.querySelector('.p-remove').addEventListener('click', () => removeProvider(provider.id));

    /* 密钥 */
    const keyInput = li.querySelector('.p-key');
    const keyHelp = li.querySelector('.p-keyhelp');
    const renderKeyHelp = () => {
      keyHelp.textContent = keyMasks[provider.id]
        ? `当前密钥：${keyMasks[provider.id]}（留空保存则保持不变）`
        : '尚未配置密钥，请填写后保存';
    };
    keyInput.value = pendingKeys[provider.id] || '';
    renderKeyHelp();
    keyInput.addEventListener('input', () => {
      const value = keyInput.value.trim();
      if (value) pendingKeys[provider.id] = value;
      else delete pendingKeys[provider.id];
      updateProviderHead(li, provider);
    });

    const showKey = li.querySelector('.p-showkey');
    showKey.addEventListener('click', () => {
      const reveal = keyInput.type === 'password';
      keyInput.type = reveal ? 'text' : 'password';
      showKey.textContent = reveal ? '隐藏' : '显示';
      showKey.setAttribute('aria-pressed', String(reveal));
    });

    li.querySelector('.p-clearkey').addEventListener('click', async () => {
      if (!keyMasks[provider.id] && !keyInput.value) return;
      if (!confirm(`确定要清除接口「${provider.name}」的 API Key 吗？清除后需要重新填写才能使用该接口。`)) return;
      await DST.saveApiKey(provider.id, '');
      delete keyMasks[provider.id];
      delete pendingKeys[provider.id];
      keyInput.value = '';
      renderKeyHelp();
      updateProviderHead(li, provider);
      showSaveStatus('已清除该接口的 API Key');
    });

    /* 单接口连通性测试 */
    const testBtn = li.querySelector('.p-test');
    const testResult = li.querySelector('.p-testresult');
    testBtn.addEventListener('click', async () => {
      if (!validateProvider(li, provider)) {
        testResult.textContent = '请先修正标红的字段';
        testResult.className = 'test-result p-testresult fail';
        return;
      }
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      testResult.textContent = '正在向接口发送一条测试翻译请求…';
      testResult.className = 'test-result p-testresult';
      const res = await chrome.runtime
        .sendMessage({
          type: 'TEST_CONNECTION',
          override: { provider, apiKey: pendingKeys[provider.id] || undefined }
        })
        .catch((err) => ({ ok: false, error: String(err?.message || err) }));
      if (res?.ok) {
        testResult.textContent = `连接成功：${res.info.model} · 耗时 ${res.info.latency} ms · 返回「${res.info.sample}」`;
        testResult.className = 'test-result p-testresult ok';
      } else {
        testResult.textContent = `连接失败：${res?.error || '未知错误'}`;
        testResult.className = 'test-result p-testresult fail';
      }
      testBtn.disabled = false;
      testBtn.textContent = '发送测试请求';
    });

    updateProviderHead(li, provider);
    list.appendChild(li);
  }

  $('providerCount').textContent = `已配置 ${providers.length} / ${DST.MAX_PROVIDERS} 个接口`;
  $('addProvider').disabled = providers.length >= DST.MAX_PROVIDERS;
  renderExplainProvider(); // 接口增删改名后，详解那个下拉要跟着变
}

/**
 * 「详解使用的接口」下拉：选项就是当前配置的接口列表。
 * 传 keepId 用于首次填表时恢复已保存的选择；平时保留用户当前的选择。
 */
function renderExplainProvider(keepId) {
  const select = $('explainProvider');
  if (!select) return;
  const wanted = keepId === undefined ? select.value : keepId || '';
  select.innerHTML = '';

  const follow = document.createElement('option');
  follow.value = '';
  const active = providers.find((p) => p.id === activeProviderId);
  follow.textContent = `跟随翻译接口${active ? `（当前：${active.name}）` : ''}`;
  select.appendChild(follow);

  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    // 带上模型名，用户不用回头翻上面的列表才知道这个接口配的是哪个模型
    option.textContent = `${provider.name}${provider.model ? ` · ${provider.model}` : ''}`;
    select.appendChild(option);
  }
  select.value = providers.some((p) => p.id === wanted) ? wanted : '';
  syncExplainProviderWarn();
}

/**
 * 详解实际会用到的接口与模型。模型优先取「详解使用的模型」，留空才跟随接口自己的模型——
 * 与 DST.explainProvider 的判定保持一致，避免设置页说一套、后台跑另一套。
 */
function resolveExplainTarget() {
  const id = $('explainProvider').value;
  const provider = (id ? providers.find((p) => p.id === id) : providers.find((p) => p.id === activeProviderId)) || null;
  const override = $('explainModel').value.trim();
  return { provider, model: override || provider?.model || '', overridden: Boolean(override) };
}

/** 详解落到了翻译专用模型上就当场提示，别等用户划词才发现出不来 */
function syncExplainProviderWarn() {
  const warn = $('explainProviderWarn');
  const hint = $('explainModelHint');
  if (!warn) return;
  const { provider, model, overridden } = resolveExplainTarget();

  if (hint) {
    hint.textContent = provider
      ? overridden
        ? `详解将用「${provider.name}」的地址和密钥，模型 ${model}`
        : `留空，将跟随「${provider.name}」配置的模型 ${model || '（未填）'}`
      : '';
  }

  const isMt = DST.isTranslationOnlyModel(model);
  warn.hidden = !isMt;
  if (isMt) {
    warn.textContent = `详解目前会用到翻译专用模型 ${model}，它做不了详解。请在「详解使用的模型」里填一个通用对话模型（如 qwen-plus、deepseek-chat）。`;
  }
}

function addProvider() {
  if (providers.length >= DST.MAX_PROVIDERS) return;
  const preset = PRESETS.find((p) => p.key === $('presetSelect').value) || PRESETS[0];
  const used = new Set(providers.map((p) => p.id));
  let id = preset.key;
  let n = 2;
  while (used.has(id)) id = `${preset.key}-${n++}`;
  const name = providers.some((p) => p.name === preset.name) ? `${preset.name} ${n - 1}` : preset.name;
  providers.push(
    DST.normalizeProvider(
      { id, name, baseUrl: preset.baseUrl, model: preset.model || DST.DEFAULT_PROVIDER.model },
      providers.length,
      used
    )
  );
  expandedId = id;
  renderProviders();
  $('providerList').lastElementChild?.querySelector('.p-name')?.focus();
}

async function removeProvider(id) {
  if (providers.length <= 1) {
    setProvidersError('至少要保留一个接口');
    return;
  }
  const provider = providers.find((p) => p.id === id);
  if (!confirm(`确定删除接口「${provider?.name || id}」吗？它保存的 API Key 也会一并清除。`)) return;
  providers = providers.filter((p) => p.id !== id);
  delete pendingKeys[id];
  delete keyMasks[id];
  await DST.saveApiKey(id, '');
  if (activeProviderId === id) activeProviderId = providers[0].id;
  setProvidersError('');
  renderProviders();
}

function setProvidersError(message) {
  $('providersError').hidden = !message;
  $('providersError').textContent = message || '';
}

function renderSites() {
  const list = $('siteList');
  list.innerHTML = '';
  for (const site of sites) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = site;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = `移除 ${site}`;
    btn.innerHTML = CLOSE_ICON;
    btn.addEventListener('click', () => {
      sites = sites.filter((s) => s !== site);
      renderSites();
    });
    li.append(span, btn);
    list.appendChild(li);
  }
  $('siteEmpty').hidden = sites.length > 0;
}

function renderPreview() {
  const pair = document.querySelector('.preview-pair');
  const trans = $('previewTrans');
  pair.className = `preview-pair ${$('displayMode').value}`;
  trans.className = `preview-trans style-${$('styleVariant').value}`;
  trans.style.fontSize = `${$('fontScale').value || 100}%`;
  trans.style.fontFamily =
    $('translationFont').value === 'cjk'
      ? '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif'
      : 'inherit';
}

async function refreshCacheInfo() {
  const res = await chrome.runtime.sendMessage({ type: 'CACHE_STATS' }).catch(() => null);
  $('cacheInfo').textContent = res?.ok ? `缓存条目：${res.count.toLocaleString('zh-CN')} 条` : '缓存条目：读取失败';
}

/* --------------------------------- 校验 --------------------------------- */

function setFieldError(li, field, message) {
  const box = li.querySelector(`.p-${field}-error`);
  const input = li.querySelector(`.p-${field}`);
  if (box) {
    box.hidden = !message;
    box.textContent = message || '';
  }
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  return !message;
}

function validateProvider(li, provider) {
  let ok = true;

  const baseUrl = String(provider.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    ok = setFieldError(li, 'baseUrl', '请填写完整的 API 地址，例如 https://api.deepseek.com') && ok;
  } else {
    setFieldError(li, 'baseUrl', '');
  }

  if (!String(provider.model || '').trim()) ok = setFieldError(li, 'model', '模型名称不能为空') && ok;
  else setFieldError(li, 'model', '');

  const key = pendingKeys[provider.id] || '';
  if (key && /\s/.test(key)) {
    ok = setFieldError(li, 'key', 'API Key 不应包含空格') && ok;
  } else if (!key && !keyMasks[provider.id] && provider.id === activeProviderId) {
    ok = setFieldError(li, 'key', '启用中的接口必须配置 API Key') && ok;
  } else {
    setFieldError(li, 'key', '');
  }

  return ok;
}

function validateAllProviders() {
  let ok = true;
  for (const li of $('providerList').children) {
    const provider = providers.find((p) => p.id === li.dataset.id);
    if (!provider || validateProvider(li, provider)) continue;
    ok = false;
    // 折叠状态下看不到标红字段，出错就展开
    const toggle = li.querySelector('.p-toggle');
    li.querySelector('.provider-body').hidden = false;
    toggle.textContent = '收起';
    toggle.setAttribute('aria-expanded', 'true');
  }
  return ok;
}

function collectForm() {
  return {
    valid: true,
    patch: {
      providers,
      activeProviderId,
      targetLang: $('targetLang').value.trim() || '简体中文',
      concurrency: Number($('concurrency').value),
      batchSize: Number($('batchSize').value),
      batchChars: Number($('batchChars').value),
      onlyTranslateForeign: $('onlyTranslateForeign').checked,
      cacheEnabled: $('cacheEnabled').checked,
      customPrompt: $('customPrompt').value.trim(),
      displayMode: $('displayMode').value,
      styleVariant: $('styleVariant').value,
      translationFont: $('translationFont').value,
      fontScale: Number($('fontScale').value),
      selectionEnabled: $('selectionEnabled').checked,
      selectionTrigger: $('selectionTrigger').value,
      explainMode: $('explainMode').value,
      explainProviderId: $('explainProvider').value,
      explainModel: $('explainModel').value.trim(),
      updateRepo: $('updateRepo').value.trim(),
      dictEnabled: $('dictEnabled').checked,
      vocabSaveContext: $('vocabSaveContext').checked,
      speechAccent: $('speechAccent').value,
      speechRate: Number($('speechRate').value),
      audioSource: $('audioSource').value,
      autoTranslateSites: sites
    }
  };
}

function showSaveStatus(text, fail) {
  const box = $('saveStatus');
  box.textContent = text;
  box.classList.toggle('fail', Boolean(fail));
  if (!fail) setTimeout(() => (box.textContent = ''), 2600);
}

/* --------------------------------- 事件 --------------------------------- */

$('addProvider').addEventListener('click', addProvider);

$('clearCacheBtn').addEventListener('click', async () => {
  if (!confirm('确定清除本地翻译缓存吗？之后相同内容需要重新调用 API。')) return;
  $('clearCacheBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' }).catch(() => null);
  await refreshCacheInfo();
  $('clearCacheBtn').disabled = false;
  showSaveStatus('缓存已清除');
});

function addSite() {
  const raw = $('siteInput').value.trim().toLowerCase();
  if (!raw) return;
  const host = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    $('siteError').hidden = false;
    $('siteError').textContent = '请输入有效域名，例如 example.com 或 *.example.com';
    return;
  }
  $('siteError').hidden = true;
  if (!sites.includes(host)) sites.push(host);
  $('siteInput').value = '';
  renderSites();
}

$('addSite').addEventListener('click', addSite);
$('siteInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addSite();
  }
});

for (const id of ['displayMode', 'styleVariant', 'translationFont', 'fontScale']) {
  $(id).addEventListener('input', renderPreview);
}

/* ------------------------------ 发音与生词本 ------------------------------ */

$('openVocab').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_VOCAB' }));

/**
 * 把系统语音包的实际情况摆出来。"换了台电脑就没声音"十有八九是新电脑没装语音包，
 * 光靠一句"朗读失败"用户永远查不到这一步。
 */
async function refreshVoiceState() {
  const box = $('voiceState');
  const detail = $('voiceDetail');
  const res = await chrome.runtime.sendMessage({ type: 'TTS_VOICES' }).catch(() => null);
  const voices = res?.ok ? res.voices : [];

  if (!voices.length) {
    box.classList.add('warn');
    detail.textContent =
      '没有检测到任何系统语音包，语音合成这条路用不了，只能靠联网的真人发音。Windows：设置 → 时间和语言 → 语音 → 管理语音 → 添加语音（英语 美国）。';
    return;
  }

  const langs = [...new Set(voices.map((v) => v.lang).filter(Boolean))];
  const wanted = $('speechAccent').value === 'uk' ? 'en-GB' : 'en-US';
  const hasEnglish = langs.some((l) => l.toLowerCase().startsWith('en'));
  box.classList.toggle('warn', !hasEnglish);
  detail.textContent = hasEnglish
    ? `已安装 ${voices.length} 个语音：${langs.join('、')}。断网时会用它朗读。`
    : `已安装 ${voices.length} 个语音（${langs.join('、')}），但没有英语语音，${wanted} 的单词只能靠联网真人发音。` +
      'Windows：设置 → 时间和语言 → 语音 → 添加语音（英语 美国）。';
}

$('speechAccent').addEventListener('change', refreshVoiceState);

// 试听按当前表单里的口音/语速走，不必先保存——和"发送测试请求"一个思路
$('testSpeak').addEventListener('click', async () => {
  const btn = $('testSpeak');
  const out = $('speakResult');
  btn.disabled = true;
  out.className = 'test-result';
  out.textContent = '正在朗读…';

  const accent = $('speechAccent').value;
  const rate = Number($('speechRate').value) || 1;
  await DST.saveSettings({ speechAccent: accent, speechRate: rate, audioSource: $('audioSource').value });
  settings = await DST.loadSettings();

  const sample = 'pronunciation';
  const dict = await chrome.runtime.sendMessage({ type: 'DICT_LOOKUP', word: sample }).catch(() => null);
  const res = await chrome.runtime
    .sendMessage({ type: 'SPEAK', text: sample, audioUrl: dict?.audioUrl || '' })
    .catch((err) => ({ ok: false, error: `扩展后台连接失败：${err?.message || err}` }));

  btn.disabled = false;
  await refreshVoiceState();
  if (res?.ok) {
    const VIA = {
      'audio:有道': '有道真人发音',
      'audio:百度': '百度语音合成',
      'audio:dictionaryapi': 'dictionaryapi 真人发音',
      tts: '系统语音合成'
    };
    const phon = dict?.phonetic ? ` · 音标 ${dict.phonetic}` : '（没查到音标）';
    out.classList.add('ok');
    out.textContent = `正在朗读「${sample}」：${VIA[res.via] || res.via}，${accent === 'uk' ? '英式' : '美式'}${phon}`;
  } else {
    out.classList.add('fail');
    out.textContent = res?.error || '朗读失败';
  }
});

$('saveBtn').addEventListener('click', async () => {
  const providersOk = validateAllProviders();
  const { valid, patch } = collectForm();
  if (!providersOk || !valid) {
    showSaveStatus('请修正标红的字段后再保存', true);
    return;
  }
  $('saveBtn').disabled = true;
  try {
    settings = await DST.saveSettings(patch);
    for (const [id, key] of Object.entries(pendingKeys)) await DST.saveApiKey(id, key);
    pendingKeys = {};
    providers = settings.providers.map((p) => Object.assign({}, p));
    activeProviderId = settings.activeProviderId;
    await DST.pruneApiKeys(providers.map((p) => p.id)); // 删掉的接口不留密钥
    await refreshKeyMasks();
    renderProviders();
    fillForm();
    showSaveStatus('设置已保存并立即生效');
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED' }).catch(() => {});
    }
  } catch (err) {
    showSaveStatus(`保存失败：${err?.message || err}`, true);
  } finally {
    $('saveBtn').disabled = false;
  }
});

$('explainProvider').addEventListener('change', syncExplainProviderWarn);
$('explainModel').addEventListener('input', syncExplainProviderWarn);

/* -------------------------------- 检查更新 -------------------------------- */

const UPDATE_STATE_KEY = 'updateState'; // { checkedAt, version } 只是给界面显示，不参与校验
let pendingRelease = null;

function showUpdateResult(message, kind) {
  const el = $('updateResult');
  el.textContent = message || '';
  // 类名沿用设置页已有的 .test-result.ok / .fail，别再引入第三套语义色
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('fail', kind === 'error');
}

function describeCheckedAt(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '上次检查：刚刚';
  if (diff < 3600000) return `上次检查：${Math.round(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `上次检查：${Math.round(diff / 3600000)} 小时前`;
  return `上次检查：${new Date(ts).toLocaleDateString()}`;
}

async function renderUpdateMeta() {
  $('currentVersion').textContent = `v${chrome.runtime.getManifest().version}`;
  const stored = (await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY] || {};
  $('updateCheckedAt').textContent = describeCheckedAt(stored.checkedAt);
}

async function checkUpdate() {
  const btn = $('checkUpdate');
  btn.disabled = true;
  btn.textContent = '检查中…';
  $('updateBox').hidden = true;
  showUpdateResult('');
  pendingRelease = null;

  try {
    const release = await updater.fetchLatestRelease($('updateRepo').value);
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: { checkedAt: Date.now(), version: release.version } });
    await renderUpdateMeta();

    const current = chrome.runtime.getManifest().version;
    if (DST.compareVersions(release.version, current) <= 0) {
      showUpdateResult(`已是最新版本 v${current}`, 'ok');
      return;
    }
    pendingRelease = release;
    $('updateVersion').textContent = `发现新版本 v${release.version}（当前 v${current}）`;
    $('updateNotes').textContent = release.notes || '（这个版本没有填写更新说明）';
    $('updateLink').href = release.htmlUrl || `https://github.com/${DST.parseRepo($('updateRepo').value)}/releases`;
    $('updateProgress').textContent = '';
    $('updateBox').hidden = false;
    showUpdateResult('');
  } catch (err) {
    showUpdateResult(err?.message || String(err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
  }
}

async function installUpdate({ forcePick = false } = {}) {
  if (!pendingRelease) return;
  const btn = $('installUpdate');
  const progress = $('updateProgress');
  btn.disabled = true;
  $('pickDir').disabled = true;
  showUpdateResult('');

  try {
    // 先要目录授权再下载：用户拒绝授权时不该白下几十 KB，报错也更贴近他刚做的操作
    progress.textContent = '等待选择安装目录…';
    const dir = await updater.pickInstallDir({ forcePick });

    const files = await updater.downloadPackage(pendingRelease, (text) => (progress.textContent = text));
    await updater.installFiles(dir, files, (text) => (progress.textContent = text));

    progress.textContent = `已安装 v${pendingRelease.version}，正在重新加载扩展…`;
    showUpdateResult(`更新完成，已升级到 v${pendingRelease.version}`, 'ok');
    // 重载会把这个页面一起关掉，留一点时间让用户看到结果
    setTimeout(() => chrome.runtime.reload(), 1200);
  } catch (err) {
    // 用户在文件选择框里点取消不是错误，不该红字吓人
    const aborted = err?.name === 'AbortError';
    progress.textContent = '';
    showUpdateResult(aborted ? '已取消' : `安装失败：${err?.message || err}`, aborted ? '' : 'error');
    btn.disabled = false;
    $('pickDir').disabled = false;
  }
}

$('checkUpdate').addEventListener('click', checkUpdate);
$('installUpdate').addEventListener('click', () => installUpdate());
$('pickDir').addEventListener('click', () => installUpdate({ forcePick: true }));

/* --------------------------------- 初始化 -------------------------------- */

async function refreshKeyMasks() {
  const map = await DST.loadApiKeys();
  keyMasks = {};
  for (const [id, key] of Object.entries(map)) keyMasks[id] = DST.maskKey(key);
}

(async function init() {
  settings = await DST.loadSettings();
  providers = settings.providers.map((p) => Object.assign({}, p));
  activeProviderId = settings.activeProviderId;
  expandedId = activeProviderId; // 当前生效的那个默认展开，其余折叠
  await refreshKeyMasks();
  renderPresets();
  renderProviders();
  fillForm();
  refreshCacheInfo();
  refreshVoiceState();
  renderUpdateMeta();
})();
