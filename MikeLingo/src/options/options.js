import '../common/shared.js';
import * as updater from './updater.js';

const DST = globalThis.DST;
const $ = (id) => document.getElementById(id);

function showSection(id) {
  const sections = [...document.querySelectorAll('main > .card')];
  if (!sections.some(section => section.id === id)) id = 'settings-0';
  sections.forEach(section => section.hidden = section.id !== id);
  document.querySelectorAll('.settings-nav a').forEach(link => {
    if (link.hash === `#${id}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange', () => showSection(location.hash.slice(1)));
showSection(location.hash.slice(1));

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/**
 * 各服务商的常用模型。mt: true 表示翻译专用模型——能翻译，但做不了词典详解，
 * 所以「详解使用的模型」的候选里会被滤掉。
 * 通义两个预设共用一份：地址和密钥本来就是同一套，qwen-plus 和 qwen-mt-flash 都能填。
 */
const DASHSCOPE_MODELS = [
  { value: 'qwen-plus', note: '推荐，通用' },
  { value: 'qwen-turbo', note: '更快更便宜' },
  { value: 'qwen-max', note: '最强，较贵' },
  { value: 'qwen-mt-flash', note: '翻译专用，便宜', mt: true },
  { value: 'qwen-mt-lite', note: '翻译专用，最便宜', mt: true },
  { value: 'qwen-mt-plus', note: '翻译专用，质量更好', mt: true }
];

/** 常见服务商预设：新增接口时直接填好地址和推荐模型，省得用户去翻文档 */
const PRESETS = [
  { key: 'deepl-free', name: 'DeepL API Free', type: 'deepl', deeplPlan: 'free', baseUrl: 'https://api-free.deepl.com', model: '', models: [] },
  { key: 'deepl-pro', name: 'DeepL API Pro', type: 'deepl', deeplPlan: 'pro', baseUrl: 'https://api.deepl.com', model: '', models: [] },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: [
      { value: 'deepseek-chat', note: '推荐，速度快' },
      { value: 'deepseek-reasoner', note: '更强推理，较慢' }
    ]
  },
  {
    key: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    models: [
      { value: 'deepseek-ai/DeepSeek-V3', note: '推荐' },
      { value: 'deepseek-ai/DeepSeek-R1', note: '推理模型，较慢' },
      { value: 'Qwen/Qwen2.5-7B-Instruct', note: '小模型，便宜' }
    ]
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    models: [
      { value: 'glm-4-flash', note: '推荐，有免费额度' },
      { value: 'glm-4-air', note: '质量更好' },
      { value: 'glm-4-plus', note: '最强，较贵' }
    ]
  },
  {
    key: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    models: [
      { value: 'moonshot-v1-8k', note: '推荐，短文本够用' },
      { value: 'moonshot-v1-32k' },
      { value: 'moonshot-v1-128k', note: '长上下文，较贵' }
    ]
  },
  {
    key: 'dashscope',
    name: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: DASHSCOPE_MODELS,
    // 百炼专属部署的接入点是 llm-<实例>.<地域>.maas.aliyuncs.com，路径和模型目录与公共地址一致
    altHost: /\.maas\.aliyuncs\.com$/
  },
  {
    key: 'qwen-mt',
    name: '通义千问 MT（翻译专用）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-mt-flash',
    models: DASHSCOPE_MODELS
  },
  {
    key: 'doubao',
    name: '火山方舟 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1-5-pro-32k',
    models: [
      { value: 'doubao-1-5-pro-32k', note: '推荐' },
      { value: 'doubao-1-5-lite-32k', note: '更便宜' }
    ]
  },
  {
    key: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    models: [
      { value: 'gemini-2.5-flash', note: '推荐' },
      { value: 'gemini-2.5-pro', note: '最强，较贵' },
      { value: 'gemini-2.0-flash', note: '更便宜' }
    ]
  },
  {
    key: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: [
      { value: 'gpt-4o-mini', note: '推荐，便宜' },
      { value: 'gpt-4o' },
      { value: 'gpt-4.1-mini' }
    ]
  },
  { key: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: 'https://', model: '', models: [] }
];

/** 按 API 地址的域名找服务商，而不是按接口 id/名称——用户改了名或复制了一个接口也认得出 */
function presetForBaseUrl(baseUrl) {
  let host = '';
  try {
    host = new URL(String(baseUrl || '')).host.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  return PRESETS.find((preset) => {
    if (preset.altHost?.test(host)) return true;
    try {
      return new URL(preset.baseUrl).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }) || null;
}

const CUSTOM_MODEL = '__custom__'; // 下拉里「自定义…」那一项的值，不会被当成模型名存下去

/**
 * 把候选模型填进一个真下拉，并让它和手填输入框保持一致。选中的是 A 服务商就不该冒出
 * B 服务商的模型，否则填了也是 404。地址认不出来（自定义接口）就不给候选，直接露出输入框。
 *
 * 这里刻意不用 `input + datalist`：datalist 的候选会被输入框里已有的文字过滤，
 * 框里存着一个不在候选里的旧模型名时，候选一条都不剩，用户看到的就是「下拉点不开」。
 *
 * @param select     候选下拉
 * @param input      手填输入框（选「自定义…」时才可见）
 * @param baseUrl    这个接口的 API 地址，决定候选是哪家的
 * @param excludeMt  是否排除翻译专用模型（详解功能用不了这类模型）
 * @param emptyLabel 传了就在最前面加一项「空值」（详解的模型可以留空 = 跟随接口）
 */
function syncModelPicker(select, input, baseUrl, { excludeMt = false, emptyLabel = '' } = {}) {
  if (!select || !input) return;
  const models = (presetForBaseUrl(baseUrl)?.models || []).filter((m) => !(excludeMt && m.mt));
  const values = models.map((m) => m.value);

  select.innerHTML = '';
  const addOption = (value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  };
  if (emptyLabel) addOption('', emptyLabel);
  for (const model of models) addOption(model.value, model.note ? `${model.value}（${model.note}）` : model.value);
  addOption(CUSTOM_MODEL, '自定义…');

  // 认不出服务商时没有候选可选，下拉只剩「自定义…」，留着纯属干扰
  const hasChoices = values.length > 0;
  select.hidden = !hasChoices;

  const current = input.value.trim();
  const known = current === '' ? Boolean(emptyLabel) : values.includes(current);
  select.value = known ? current : CUSTOM_MODEL;
  // 候选里选中的就不必再露输入框；自定义（含旧模型名、留空而又不允许留空）时必须能看到并改
  input.hidden = hasChoices && known;
}

/** 下拉选了某项 → 写回输入框。选「自定义…」则把输入框露出来让用户自己填 */
function bindModelPicker(select, input) {
  select.addEventListener('change', () => {
    if (select.value === CUSTOM_MODEL) {
      input.hidden = false;
      input.focus();
      return;
    }
    input.hidden = true;
    input.value = select.value;
    input.dispatchEvent(new Event('input', { bubbles: true })); // 复用输入框原有的保存/校验逻辑
  });
}

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
  $('rpm').value = settings.rpm;
  $('batchSize').value = settings.batchSize;
  $('batchChars').value = settings.batchChars;
  $('maxRetries').value = settings.maxRetries;
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
  li.querySelector('.p-meta').textContent = DST.isDeepLProvider(provider)
    ? `DeepL ${provider.deeplPlan === 'pro' ? 'Pro' : 'Free'} · ${provider.baseUrl}`
    : `${provider.model} · ${provider.baseUrl}`;
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
    const baseUrlInput = bindField(li, provider, 'baseUrl');
    bindField(li, provider, 'temperature');

    const deeplPlanField = li.querySelector('.p-deepl-plan-field');
    const deeplPlanSelect = li.querySelector('.p-deepl-plan');
    const modelField = modelInput.closest('.field');
    const syncProviderType = () => {
      const isDeepL = DST.isDeepLProvider(provider);
      deeplPlanField.hidden = !isDeepL;
      modelField.hidden = isDeepL;
      li.querySelector('.p-deepl-note').hidden = !isDeepL;
      li.querySelector('.p-key').placeholder = isDeepL ? 'DeepL API Key' : 'sk-...';
      if (isDeepL) {
        deeplPlanSelect.value = provider.deeplPlan === 'pro' ? 'pro' : 'free';
        provider.model = '';
      }
    };
    deeplPlanSelect.addEventListener('change', () => {
      provider.deeplPlan = deeplPlanSelect.value;
      provider.baseUrl = provider.deeplPlan === 'pro' ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
      baseUrlInput.value = provider.baseUrl;
      updateProviderHead(li, provider);
      syncExplainProviderWarn();
    });

    // 候选模型跟着这一行的 API 地址走
    const modelOptions = li.querySelector('.p-models');
    const syncModelOptions = () => syncModelPicker(modelOptions, modelInput, baseUrlInput.value);
    bindModelPicker(modelOptions, modelInput);
    baseUrlInput.addEventListener('input', syncModelOptions);
    baseUrlInput.addEventListener('input', syncExplainProviderWarn); // 详解那边的候选也跟着换
    // 手填改成了候选里的名字（或反过来）时，下拉的选中项要跟上
    modelInput.addEventListener('change', syncModelOptions);
    syncModelOptions();
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
      temperatureField.hidden = isMt || DST.isDeepLProvider(provider); // 翻译专用接口不接受 temperature
    };
    modelInput.addEventListener('input', syncMtNote);
    // 改了模型名可能让详解那条路失效，提示要跟着变
    modelInput.addEventListener('input', () => {
      renderExplainProvider();
      syncExplainProviderWarn();
    });
    syncMtNote();
    syncProviderType();

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

    /**
     * 贴在 API Key 后面的「保存」：填完密钥最想做的就是存下来，
     * 不该再让人滚到页面底部去找按钮。走的是和底部按钮同一个 saveAll()。
     */
    const saveBtnInline = li.querySelector('.p-save');
    saveBtnInline.addEventListener('click', async () => {
      saveBtnInline.disabled = true;
      saveBtnInline.textContent = '保存中…';
      const res = await saveAll();
      saveBtnInline.disabled = false;
      saveBtnInline.textContent = '保存';
      // saveAll 成功会重渲染整个列表，手里这个 li 已经被换掉了；
      // 按 li.dataset.id 找回新渲染出来的那一行，否则提示写在游离节点上，用户什么也看不到
      const fresh = document
        .querySelector(`.provider[data-id="${CSS.escape(provider.id)}"] .p-saveresult`);
      if (!fresh) return;
      fresh.textContent = res.ok ? '已保存，立即生效' : res.error;
      fresh.className = `test-result p-saveresult ${res.ok ? 'ok' : 'fail'}`;
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

  // 候选只给这个接口自家的通用模型：选了 DeepSeek 就不该看到 gpt-4o-mini
  syncModelPicker($('explainModels'), $('explainModel'), provider?.baseUrl, {
    excludeMt: true,
    emptyLabel: '跟随该接口的模型'
  });

  if (hint) {
    hint.textContent = provider
      ? overridden
        ? `详解将用「${provider.name}」的地址和密钥，模型 ${model}`
        : `留空，将跟随「${provider.name}」配置的模型 ${model || '（未填）'}`
      : '';
  }

  const isDeepL = DST.isDeepLProvider(provider);
  const isMt = DST.isTranslationOnlyModel(model);
  warn.hidden = !isMt && !isDeepL;
  if (isDeepL) {
    warn.textContent = 'DeepL Translate 只负责翻译，不支持词典详解。请在「详解使用的接口」选择 qwen-plus、DeepSeek 等通用模型接口。';
  } else if (isMt) {
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
      { id, name, type: preset.type, deeplPlan: preset.deeplPlan, baseUrl: preset.baseUrl, model: preset.model },
      providers.length,
      used
    )
  );
  expandedId = id;
  renderProviders();
  // 名称／地址预设已填好且收在「更多设置」里，光标该落在唯一真正要填的 API Key 上
  $('providerList').lastElementChild?.querySelector('.p-key')?.focus();
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

  if (!DST.isDeepLProvider(provider) && !String(provider.model || '').trim()) ok = setFieldError(li, 'model', '模型名称不能为空') && ok;
  else setFieldError(li, 'model', '');

  if (DST.isDeepLProvider(provider)) {
    const expected = provider.deeplPlan === 'pro' ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
    if (baseUrl !== expected) ok = setFieldError(li, 'baseUrl', `DeepL ${provider.deeplPlan === 'pro' ? 'Pro' : 'Free'} 地址应为 ${expected}`) && ok;
  }

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
      rpm: Number($('rpm').value),
      batchSize: Number($('batchSize').value),
      batchChars: Number($('batchChars').value),
      maxRetries: Number($('maxRetries').value),
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

/**
 * 保存全部设置。底部的「保存设置」和每个接口里贴着 API Key 的那个「保存」按钮
 * 走的是同一个函数——两个入口存的东西必须完全一样，否则用哪个按钮结果不同就是坑。
 * 返回是否成功，好让调用方各自决定把结果显示在哪。
 */
async function saveAll() {
  const providersOk = validateAllProviders();
  const { valid, patch } = collectForm();
  if (!providersOk || !valid) {
    const error = document.querySelector('.error:not([hidden]), .field-error:not([hidden]), [aria-invalid="true"]');
    if (error) {
      const section = error.closest('main > .card');
      if (section) { location.hash = section.id; showSection(section.id); }
      for (let parent = error.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
      error.scrollIntoView({ block: 'center' });
    }
    showSaveStatus('请修正标红的字段后再保存', true);
    return { ok: false, error: '请修正标红的字段后再保存' };
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
    // 同步卡片有自己的按钮，但用户改完地址顺手点「保存设置」也该存下，不能悄悄丢
    await saveSyncConfig().catch(() => {});
    showSaveStatus('设置已保存并立即生效');
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED' }).catch(() => {});
    }
    return { ok: true };
  } catch (err) {
    const error = `保存失败：${err?.message || err}`;
    showSaveStatus(error, true);
    return { ok: false, error };
  } finally {
    $('saveBtn').disabled = false;
  }
}

$('saveBtn').addEventListener('click', saveAll);

$('explainProvider').addEventListener('change', syncExplainProviderWarn);
$('explainModel').addEventListener('input', syncExplainProviderWarn);
bindModelPicker($('explainModels'), $('explainModel'));

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
    $('manualUpdateHelp').open = false;
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
  $('downloadUpdate').disabled = true;
  $('checkUpdate').disabled = true;
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
    $('manualUpdateHelp').open = true;
    showUpdateResult(aborted ? '已取消目录选择。也可下载更新包，按下方步骤更新。' : `未能更新目录：${err?.message || err}。请使用「下载更新包」，按下方步骤更新。`, aborted ? '' : 'error');
    btn.disabled = false;
    $('pickDir').disabled = false;
    $('downloadUpdate').disabled = false;
    $('checkUpdate').disabled = false;
  }
}

$('checkUpdate').addEventListener('click', checkUpdate);
$('installUpdate').addEventListener('click', () => installUpdate());
$('pickDir').addEventListener('click', () => installUpdate({ forcePick: true }));
$('downloadUpdate').addEventListener('click', async () => {
  if (!pendingRelease) return;
  const buttons = ['downloadUpdate', 'installUpdate', 'pickDir', 'checkUpdate'];
  buttons.forEach(id => $(id).disabled = true);
  try {
    await updater.downloadPackage(pendingRelease, text => $('updateProgress').textContent = text, buffer => {
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `MikeLingo-v${pendingRelease.version}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    $('manualUpdateHelp').open = true;
    $('updateProgress').textContent = '更新包已校验并发起下载。请按下方步骤加载，尚未完成安装。';
  } catch (err) {
    showUpdateResult(`下载失败：${err?.message || err}`, 'error');
  } finally {
    buttons.forEach(id => $(id).disabled = false);
  }
});

/* -------------------------------- 同步与备份 ------------------------------- */

/**
 * 所有同步动作都发给后台执行，页面只管收集表单和显示结果。
 * 原因有两个：service worker 拿得到 IndexedDB 里的生词本；
 * 而且设置页关掉之后自动同步还得继续跑，逻辑放页面里就断了。
 */
async function syncSend(message) {
  const res = await chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: err?.message || String(err) }));
  if (!res?.ok) throw new Error(res?.error || '后台没有响应');
  return res;
}

function showSyncResult(message, kind) {
  const el = $('syncResult');
  el.textContent = message || '';
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('fail', kind === 'error');
}

function showBackupResult(message, kind) {
  const el = $('backupResult');
  el.textContent = message || '';
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('fail', kind === 'error');
}

/** 后端切换只改显示，不清空另一边的输入——用户来回比较时不该被清掉 */
function renderSyncBackend() {
  const backend = $('syncBackend').value;
  $('syncWebdav').hidden = backend !== 'webdav';
  $('syncGist').hidden = backend !== 'gist';
  $('syncBackendHelp').textContent =
    backend === 'gist'
      ? '数据存成一个私密 Gist。只要 Token 有 gist 权限即可，不需要仓库。'
      : '数据存成网盘里的一个 JSON 文件。坚果云在「账户信息 → 安全选项 → 添加应用」里生成应用密码。';
}

function renderSyncEnabled() {
  const on = $('syncEnabled').checked;
  $('syncBody').hidden = !on;
}

function describeSyncState(state) {
  if (state.lastError) return `上次同步失败：${state.lastError}`;
  if (!state.lastSyncAt) return '还没有同步过。';
  return `上次同步：${new Date(state.lastSyncAt).toLocaleString()}${state.lastSummary ? `（${state.lastSummary}）` : ''}`;
}

function renderSyncState(state) {
  $('syncStateDetail').textContent = describeSyncState(state);
  $('syncState').classList.toggle('warn', Boolean(state.lastError));
}

/** 已存过的凭据只说"已设置"，不回显原文；留空保存 = 保持不变（和 API Key 一个规矩） */
function renderCredState(id, has, base) {
  $(id).textContent = has ? `已设置，留空保存表示不修改。${base}` : base;
}

async function loadSyncForm() {
  const { config, state } = await syncSend({ type: 'SYNC_GET_CONFIG' });
  $('syncEnabled').checked = config.enabled;
  $('syncBackend').value = config.backend;
  $('syncWebdavUrl').value = config.webdav.url;
  $('syncWebdavUser').value = config.webdav.user;
  $('syncGistId').value = config.gist.id;
  $('syncIncludeSecrets').checked = config.includeSecrets;
  $('syncAuto').checked = config.auto;
  renderCredState('syncWebdavPassState', config.hasWebdavPass, '坚果云要用「应用密码」，不是登录密码。');
  renderCredState('syncGistTokenState', config.hasGistToken, '细粒度 Token 勾 Gists: Read and write，经典 Token 勾 gist。');
  renderCredState(
    'syncPassphraseState',
    config.hasPassphrase,
    '只留在本机，不会上传。两台浏览器要填同一个口令才解得开对方的密钥。'
  );
  renderSyncBackend();
  renderSyncEnabled();
  renderSyncState(state);

  // 凭据填齐了就把配置区收起来，平时只剩「立即同步」和状态；没配好则默认展开，
  // 否则新用户打开卡片只看到一个按钮，根本不知道还要填东西
  const configured =
    config.backend === 'gist'
      ? config.hasGistToken
      : Boolean(config.webdav.url && config.webdav.user && config.hasWebdavPass);
  $('syncAdv').open = !configured;
}

/** 表单 → 后台。密码类字段留空表示不修改，所以只在填了内容时才传 */
async function saveSyncConfig() {
  const creds = {};
  if ($('syncWebdavPass').value) creds.webdavPass = $('syncWebdavPass').value;
  if ($('syncGistToken').value) creds.gistToken = $('syncGistToken').value;
  if ($('syncPassphrase').value) creds.passphrase = $('syncPassphrase').value;

  await syncSend({
    type: 'SYNC_SAVE_CONFIG',
    config: {
      enabled: $('syncEnabled').checked,
      backend: $('syncBackend').value,
      auto: $('syncAuto').checked,
      includeSecrets: $('syncIncludeSecrets').checked,
      webdav: { url: $('syncWebdavUrl').value, user: $('syncWebdavUser').value },
      gist: { id: $('syncGistId').value }
    },
    creds
  });
  // 存完就把密码框清空并改成"已设置"，避免密文长期停留在 DOM 里
  $('syncWebdavPass').value = '';
  $('syncGistToken').value = '';
  $('syncPassphrase').value = '';
  await loadSyncForm();
}

const SYNC_BUTTONS = ['syncTest', 'syncNow', 'syncPull', 'syncPush'];

async function runSyncAction(label, fn) {
  SYNC_BUTTONS.forEach((id) => ($(id).disabled = true));
  showSyncResult(`${label}中…`);
  try {
    await saveSyncConfig(); // 先落配置：用户改完地址直接点同步是最常见的操作顺序
    const message = await fn();
    showSyncResult(message, 'ok');
  } catch (err) {
    showSyncResult(err?.message || String(err), 'error');
  } finally {
    SYNC_BUTTONS.forEach((id) => ($(id).disabled = false));
    const { state } = await syncSend({ type: 'SYNC_GET_CONFIG' }).catch(() => ({ state: {} }));
    renderSyncState(state || {});
  }
}

async function doSync(direction, label) {
  const { result } = await syncSend({ type: 'SYNC_NOW', direction });
  const extra = result.secretsError ? `。注意：${result.secretsError}` : '';
  return `${label}完成：${result.summary}${extra}`;
}

$('syncEnabled').addEventListener('change', () => {
  renderSyncEnabled();
  saveSyncConfig().catch((err) => showSyncResult(err?.message || String(err), 'error'));
});
$('syncBackend').addEventListener('change', renderSyncBackend);
$('syncTest').addEventListener('click', () =>
  runSyncAction('测试', async () => (await syncSend({ type: 'SYNC_TEST' })).info.message)
);
$('syncNow').addEventListener('click', () => runSyncAction('同步', () => doSync('both', '同步')));
$('syncPull').addEventListener('click', () => runSyncAction('下载', () => doSync('pull', '下载')));
$('syncPush').addEventListener('click', () => runSyncAction('上传', () => doSync('push', '上传')));

/* ------------------------------ 备份文件 ------------------------------ */

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

$('backupExport').addEventListener('click', async () => {
  showBackupResult('');
  try {
    await saveSyncConfig();
    const includeSecrets = $('syncIncludeSecrets').checked;
    const passphrase = $('syncPassphrase').value; // 刚输入还没落盘的口令也算数
    const { data } = await syncSend({ type: 'BACKUP_EXPORT', includeSecrets, passphrase });
    downloadFile(`mikelingo-backup-${fileStamp()}.json`, JSON.stringify(data, null, 2));
    showBackupResult(
      `已导出 ${data.vocab.words.length} 个生词、设置与接口配置${data.secrets ? '，API Key 已加密' : '（不含 API Key）'}`,
      'ok'
    );
  } catch (err) {
    showBackupResult(err?.message || String(err), 'error');
  }
});

$('backupImport').addEventListener('click', () => $('backupFile').click());

$('backupFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // 同一个文件连选两次也要能触发
  if (!file) return;
  showBackupResult('导入中…');
  try {
    const payload = JSON.parse(await file.text());
    const { result } = await syncSend({ type: 'BACKUP_IMPORT', payload, passphrase: $('syncPassphrase').value });
    const parts = [`新增 ${result.vocab.added} 个生词`, `合并 ${result.vocab.merged} 个`];
    if (result.vocab.deleted) parts.push(`删除 ${result.vocab.deleted} 个`);
    if (result.settingsChanged) parts.push('更新了设置');
    if (result.keysAdded) parts.push(`带回 ${result.keysAdded} 个 API Key`);
    showBackupResult(
      `导入完成：${parts.join('，')}${result.secretsError ? `。注意：${result.secretsError}` : ''}`,
      result.secretsError ? 'error' : 'ok'
    );
    // 设置可能被合并改过，重新载入表单，别让用户看着旧值
    settings = await DST.loadSettings();
    providers = settings.providers.map((p) => Object.assign({}, p));
    activeProviderId = settings.activeProviderId;
    await refreshKeyMasks();
    renderProviders();
    fillForm();
  } catch (err) {
    showBackupResult(err?.message || String(err), 'error');
  }
});

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
  loadSyncForm().catch((err) => showSyncResult(err?.message || String(err), 'error'));
})();
