/**
 * 同时被内容脚本（普通脚本）和 service worker / 页面（ES module）加载，
 * 因此不能使用 import / export，统一挂在 globalThis.DST 上。
 */
(function () {
  /** 单个翻译接口的配置模板；旧版的单接口设置会迁移成这样一条 */
  const DEFAULT_PROVIDER = {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 1.3,
    timeout: 60000
  };
  const MAX_PROVIDERS = 10;

  const DEFAULT_SETTINGS = {
    // API：可配置多个接口，同一时刻只有 activeProviderId 指向的那个生效
    providers: [Object.assign({}, DEFAULT_PROVIDER)],
    activeProviderId: DEFAULT_PROVIDER.id,
    // 翻译
    targetLang: '简体中文',
    onlyTranslateForeign: true,
    customPrompt: '',
    batchSize: 10,
    batchChars: 1800,
    concurrency: 3,
    maxRetries: 2,
    cacheEnabled: true,
    // 显示
    displayMode: 'inline', // inline 段落对照 | columns 左右并列 | replace 仅译文
    styleVariant: 'dashed', // none | dashed | solid | quote | highlight
    translationFont: 'cjk', // cjk 系统中文字体 | inherit 跟随原文
    fontScale: 100,
    // 划词
    selectionEnabled: true,
    selectionTrigger: 'button', // button 显示按钮 | instant 直接翻译 | alt 按住 Alt
    // 自动翻译
    autoTranslateSites: [],
    // 词典详解：释义、例句、用法，另发一次请求
    explainMode: 'auto', // auto 词和短语自动详解 | manual 点「详细解释」才查 | off 关闭
    // 详解用哪个接口。空 = 跟随当前启用的翻译接口；
    // 翻译常用 qwen-mt 这类翻译专用模型（便宜、专精），但它做不了详解，
    // 所以允许把详解单独指到一个通用对话模型的接口上。
    explainProviderId: '',
    // 详解用哪个模型。空 = 用该接口自己配的模型。
    // 同一家服务商（同地址同密钥）想翻译用 qwen-mt-turbo、详解用 qwen-plus 时，
    // 只填这一个字段就够了，不必再配一个接口。
    explainModel: '',
    // 音标与发音
    dictEnabled: true, // 单词查音标（免费词典接口，失败不影响翻译）
    // auto 单词用有道真人发音、整句用百度 | youdao | baidu | dict 只用 dictionaryapi | none 只用系统语音
    audioSource: 'auto',
    speechAccent: 'us', // us 美式 | uk 英式
    speechRate: 1, // 0.5–2
    // 生词本
    vocabSaveContext: true, // 加入生词本时一并保存原句与来源页面
    // 更新源：GitHub 仓库 owner/repo，设置页「检查更新」读它的 Releases。留空则不检查
    updateRepo: 'Mike070107/MikeLingo'
  };

  const SETTINGS_KEY = 'settings';
  const API_KEYS_KEY = 'apiKeys'; // { [providerId]: key }
  const LEGACY_API_KEY = 'apiKey'; // 1.1.0 及以前的单密钥

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeProvider(raw, index, usedIds) {
    const p = Object.assign({}, DEFAULT_PROVIDER, raw || {});
    const base = String(p.id || '').trim().slice(0, 40) || `api-${index + 1}`;
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`; // 同 id 会互相覆盖密钥，必须去重
    usedIds.add(id);
    return {
      id,
      name: String(p.name || '').trim().slice(0, 40) || `接口 ${index + 1}`,
      baseUrl: String(p.baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_PROVIDER.baseUrl,
      model: String(p.model || '').trim() || DEFAULT_PROVIDER.model,
      temperature: clampNumber(p.temperature, 0, 2, DEFAULT_PROVIDER.temperature),
      timeout: clampNumber(p.timeout, 5000, 300000, DEFAULT_PROVIDER.timeout)
    };
  }

  function normalizeSettings(raw) {
    const legacy = raw || {};
    const s = Object.assign({}, DEFAULT_SETTINGS, legacy);

    // 必须看原始数据有没有 providers：s 已经合并了默认值，用 s 判断会让旧配置的接口地址被丢掉
    let list = Array.isArray(legacy.providers) ? legacy.providers.filter(Boolean) : [];
    if (!list.length) {
      // 旧版是单接口平铺字段，迁移成默认的那一条（字段缺失时由 normalizeProvider 回落到默认值）
      list = [
        {
          id: DEFAULT_PROVIDER.id,
          name: DEFAULT_PROVIDER.name,
          baseUrl: legacy.baseUrl,
          model: legacy.model,
          temperature: legacy.temperature,
          timeout: legacy.timeout
        }
      ];
    }
    const usedIds = new Set();
    s.providers = list.slice(0, MAX_PROVIDERS).map((p, i) => normalizeProvider(p, i, usedIds));
    s.activeProviderId = String(s.activeProviderId || '');
    if (!s.providers.some((p) => p.id === s.activeProviderId)) s.activeProviderId = s.providers[0].id;
    // 接口参数只以 providers 为准，避免旧的平铺字段成为第二份真相
    delete s.baseUrl;
    delete s.model;
    delete s.temperature;
    delete s.timeout;

    s.targetLang = String(s.targetLang || DEFAULT_SETTINGS.targetLang).trim() || DEFAULT_SETTINGS.targetLang;
    s.batchSize = Math.round(clampNumber(s.batchSize, 1, 40, DEFAULT_SETTINGS.batchSize));
    s.batchChars = Math.round(clampNumber(s.batchChars, 200, 6000, DEFAULT_SETTINGS.batchChars));
    s.concurrency = Math.round(clampNumber(s.concurrency, 1, 10, DEFAULT_SETTINGS.concurrency));
    s.maxRetries = Math.round(clampNumber(s.maxRetries, 0, 5, DEFAULT_SETTINGS.maxRetries));
    s.fontScale = Math.round(clampNumber(s.fontScale, 70, 150, DEFAULT_SETTINGS.fontScale));
    if (!['inline', 'columns', 'replace'].includes(s.displayMode)) s.displayMode = DEFAULT_SETTINGS.displayMode;
    if (!['none', 'dashed', 'solid', 'quote', 'highlight'].includes(s.styleVariant)) s.styleVariant = DEFAULT_SETTINGS.styleVariant;
    if (!['cjk', 'inherit'].includes(s.translationFont)) s.translationFont = DEFAULT_SETTINGS.translationFont;
    if (!['button', 'instant', 'alt'].includes(s.selectionTrigger)) s.selectionTrigger = DEFAULT_SETTINGS.selectionTrigger;
    if (!['auto', 'manual', 'off'].includes(s.explainMode)) s.explainMode = DEFAULT_SETTINGS.explainMode;
    // 指向已删除的接口时回落到"跟随翻译接口"，否则详解会一直用一个不存在的接口报错
    s.explainProviderId = String(s.explainProviderId || '');
    if (s.explainProviderId && !s.providers.some((p) => p.id === s.explainProviderId)) s.explainProviderId = '';
    s.explainModel = String(s.explainModel || '').trim().slice(0, 80);
    if (!['us', 'uk'].includes(s.speechAccent)) s.speechAccent = DEFAULT_SETTINGS.speechAccent;
    if (!['auto', 'youdao', 'baidu', 'dict', 'none'].includes(s.audioSource)) s.audioSource = DEFAULT_SETTINGS.audioSource;
    s.speechRate = clampNumber(s.speechRate, 0.5, 2, DEFAULT_SETTINGS.speechRate);
    s.onlyTranslateForeign = Boolean(s.onlyTranslateForeign);
    s.cacheEnabled = Boolean(s.cacheEnabled);
    s.selectionEnabled = Boolean(s.selectionEnabled);
    s.dictEnabled = Boolean(s.dictEnabled);
    s.vocabSaveContext = Boolean(s.vocabSaveContext);
    s.customPrompt = String(s.customPrompt || '').slice(0, 2000);
    s.updateRepo = parseRepo(s.updateRepo);
    s.autoTranslateSites = Array.isArray(s.autoTranslateSites)
      ? s.autoTranslateSites.map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 200)
      : [];
    return s;
  }

  async function loadSettings() {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    return normalizeSettings(stored[SETTINGS_KEY]);
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    const next = normalizeSettings(Object.assign({}, current, patch));
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
    return next;
  }

  /** 读全部密钥 { providerId: key }，顺带兼容旧版单密钥 */
  async function loadApiKeys() {
    const stored = await chrome.storage.local.get([API_KEYS_KEY, LEGACY_API_KEY]);
    const map = {};
    const raw = stored[API_KEYS_KEY];
    if (raw && typeof raw === 'object') {
      for (const [id, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value) map[id] = value;
      }
    }
    const legacy = stored[LEGACY_API_KEY];
    if (!map[DEFAULT_PROVIDER.id] && typeof legacy === 'string' && legacy) map[DEFAULT_PROVIDER.id] = legacy;
    return map;
  }

  async function loadApiKey(providerId) {
    const map = await loadApiKeys();
    return map[providerId || DEFAULT_PROVIDER.id] || '';
  }

  async function saveApiKey(providerId, key) {
    const id = providerId || DEFAULT_PROVIDER.id;
    const map = await loadApiKeys();
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (trimmed) map[id] = trimmed;
    else delete map[id];
    await chrome.storage.local.set({ [API_KEYS_KEY]: map });
    // 旧键的值已并入 map，留着只会让"清除密钥"看起来没生效
    if (id === DEFAULT_PROVIDER.id) await chrome.storage.local.remove(LEGACY_API_KEY);
    return trimmed;
  }

  /** 删除接口后清掉它的密钥，避免残留在本机 */
  async function pruneApiKeys(validIds) {
    const map = await loadApiKeys();
    let changed = false;
    for (const id of Object.keys(map)) {
      if (!validIds.includes(id)) {
        delete map[id];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ [API_KEYS_KEY]: map });
    return map;
  }

  /** 当前生效的接口配置 */
  function activeProvider(settings) {
    const list = (settings && Array.isArray(settings.providers) && settings.providers.length
      ? settings.providers
      : DEFAULT_SETTINGS.providers);
    return list.find((p) => p.id === settings?.activeProviderId) || list[0];
  }

  /**
   * 详解用的接口：单独指定了就用它，没指定（或指向的接口已被删）就跟随翻译接口；
   * 再叠加 explainModel 覆盖模型名——这样同一个接口可以翻译走 qwen-mt、详解走 qwen-plus。
   */
  function explainProvider(settings) {
    const id = settings?.explainProviderId;
    const list = Array.isArray(settings?.providers) ? settings.providers : [];
    const base = (id && list.find((p) => p.id === id)) || activeProvider(settings);
    const model = String(settings?.explainModel || '').trim();
    return model && model !== base.model ? Object.assign({}, base, { model }) : base;
  }

  /** 只回显脱敏预览，密钥本身不出现在界面和日志里 */
  function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return `${key.slice(0, 2)}${'•'.repeat(6)}`;
    return `${key.slice(0, 4)}${'•'.repeat(8)}${key.slice(-4)}`;
  }

  /** 支持 example.com / *.example.com / 完整 URL 前缀 */
  function siteMatches(patterns, url) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return (patterns || []).some((raw) => {
      const p = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!p) return false;
      if (p.startsWith('*.')) {
        const base = p.slice(2);
        return hostname === base || hostname.endsWith(`.${base}`);
      }
      return hostname === p || hostname.endsWith(`.${p}`);
    });
  }

  const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;
  const LETTER_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

  /** 判断一段文本是否值得翻译 */
  function isTranslatable(text, onlyForeign) {
    const t = (text || '').trim();
    if (t.length < 2) return false;
    if (!/[\p{L}]/u.test(t)) return false; // 纯数字 / 符号
    if (/^[\d\s\p{P}\p{S}]+$/u.test(t)) return false;
    if (!onlyForeign) return true;
    let cjk = 0;
    let letters = 0;
    for (const ch of t) {
      if (CJK_RE.test(ch)) cjk++;
      else if (LETTER_RE.test(ch)) letters++;
    }
    if (cjk === 0) return letters > 0;
    // 中文占比高的内容视为已是目标语言
    return cjk / (cjk + letters) < 0.3;
  }

  const CHINESE_TARGET_RE = /中文|汉语|漢語|chinese/i;
  const ENGLISH_TARGET_RE = /english|英文|英语/i;

  /** 粗略判断一段文本是中文还是拉丁文字 */
  function guessTextLang(text) {
    let cjk = 0;
    let letters = 0;
    for (const ch of String(text || '')) {
      if (CJK_RE.test(ch)) cjk++;
      else if (LETTER_RE.test(ch)) letters++;
    }
    if (!cjk && !letters) return 'unknown';
    return cjk / (cjk + letters) >= 0.3 ? 'zh' : 'latin';
  }

  /**
   * 中英互译：原文本来就是目标语言时（中文→中文、英文→英文），模型只会原样返回，
   * 这里自动翻到另一边；其它语言仍按用户设定的目标语言翻。
   */
  function resolveTargetLang(text, targetLang) {
    const target = String(targetLang || '').trim() || DEFAULT_SETTINGS.targetLang;
    const lang = guessTextLang(text);
    if (lang === 'zh' && CHINESE_TARGET_RE.test(target)) return 'English';
    if (lang === 'latin' && ENGLISH_TARGET_RE.test(target)) return '简体中文';
    return target;
  }

  /* -------------------------------- 检查更新 -------------------------------- */

  /**
   * 把用户填的更新源规整成 `owner/repo`。
   * 直接粘仓库网址（甚至带 /releases 尾巴）也认，省得还要教怎么填。
   */
  function parseRepo(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const fromUrl = text.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
    const pair = fromUrl ? [fromUrl[1], fromUrl[2]] : text.split('/');
    if (pair.length !== 2) return '';
    const owner = String(pair[0]).trim();
    const repo = String(pair[1]).trim().replace(/\.git$/i, '');
    if (!/^[\w.-]{1,39}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo)) return '';
    return `${owner}/${repo}`;
  }

  /**
   * 版本号比较，返回 -1 / 0 / 1。只认点分数字（1.9.10 > 1.9.2），
   * 位数不同时缺的位当 0（1.9 == 1.9.0）；非数字段一律忽略，避免 tag 里带后缀就比崩。
   */
  function compareVersions(a, b) {
    const parts = (v) =>
      String(v || '')
        .trim()
        .replace(/^v/i, '')
        .split('.')
        .map((x) => parseInt(x, 10) || 0);
    const left = parts(a);
    const right = parts(b);
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i++) {
      const l = left[i] || 0;
      const r = right[i] || 0;
      if (l !== r) return l > r ? 1 : -1;
    }
    return 0;
  }

  /* ------------------------------- 词典详解 ------------------------------- */

  // 自动详解的长度上限：超过这个长度就是句子/段落，词典式释义没有意义，
  // 也没必要每划一段话就多烧一次 token——用户仍可手动点「详细解释」。
  const EXPLAIN_AUTO_MAX_CHARS = 60;
  const EXPLAIN_MAX_CHARS = 400; // 手动详解也有上限，整段文章不给详解

  /** 这段内容能不能出详解（决定要不要显示「详细解释」按钮） */
  function isExplainable(text) {
    const t = String(text || '').trim();
    return t.length >= 1 && t.length <= EXPLAIN_MAX_CHARS && /[\p{L}]/u.test(t);
  }

  /**
   * auto 模式下是否自动发起详解。
   * 只认「词 / 短语 / 专有名词」这类短内容：英文按词数（≤5 个词，够覆盖 San Jose、
   * machine learning、in terms of 这类），中文按字数（≤12 字）。
   */
  function shouldAutoExplain(text, mode) {
    if (mode !== 'auto') return false;
    const t = String(text || '').trim();
    if (!isExplainable(t) || t.length > EXPLAIN_AUTO_MAX_CHARS) return false;
    if (guessTextLang(t) === 'zh') return t.length <= 12;
    return t.split(/\s+/).filter(Boolean).length <= 5;
  }

  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  /**
   * 把模型返回的详解规整成固定形状：字段一律存在、长度有上限。
   * 模型偶尔会少字段或多塞几十条例句，UI 和生词本都不该为此写防御代码。
   */
  function normalizeExplain(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const senses = (Array.isArray(src.senses) ? src.senses : [])
      .map((s) => ({
        pos: str(s?.pos, 20),
        meaning: str(s?.meaning, 200),
        detail: str(s?.detail, 400)
      }))
      .filter((s) => s.meaning || s.detail)
      .slice(0, 5);
    const examples = (Array.isArray(src.examples) ? src.examples : [])
      .map((e) => ({ src: str(e?.src, 300), trans: str(e?.trans, 300) }))
      .filter((e) => e.src)
      .slice(0, 3);
    const related = (Array.isArray(src.related) ? src.related : [])
      .map((r) => str(r, 40))
      .filter(Boolean)
      .slice(0, 6);
    const kind = ['word', 'phrase', 'proper', 'sentence'].includes(src.kind) ? src.kind : '';
    const explain = {
      title: str(src.title, 200),
      kind,
      summary: str(src.summary, 300),
      senses,
      examples,
      notes: str(src.notes, 500),
      related
    };
    // 一条释义、一句例句、一段说明都没有的详解等于没查到
    return explain.summary || senses.length || examples.length || explain.notes ? explain : null;
  }

  const KIND_LABEL = { word: '单词', phrase: '短语', proper: '专有名词', sentence: '句子' };

  function escapeHtmlText(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  /**
   * 详解的 HTML 片段。划词卡片（shadow DOM）、弹窗、生词本三处共用同一份结构与
   * ex-* 类名，各自的样式表分别配色，避免三处各写一遍渲染逻辑还长得不一样。
   */
  function explainHtml(explain) {
    const e = normalizeExplain(explain);
    if (!e) return '';
    const esc = escapeHtmlText;
    const parts = [];

    if (e.summary) {
      parts.push(
        `<p class="ex-summary">${e.kind ? `<span class="ex-kind">${esc(KIND_LABEL[e.kind])}</span>` : ''}${esc(e.summary)}</p>`
      );
    }
    if (e.senses.length) {
      parts.push(
        `<ol class="ex-senses">${e.senses
          .map(
            (s) =>
              `<li>${s.pos ? `<span class="ex-pos">${esc(s.pos)}</span>` : ''}` +
              `<span class="ex-meaning">${esc(s.meaning)}</span>` +
              `${s.detail ? `<span class="ex-detail">${esc(s.detail)}</span>` : ''}</li>`
          )
          .join('')}</ol>`
      );
    }
    if (e.examples.length) {
      parts.push(
        `<div class="ex-block"><div class="ex-label">例句</div>` +
          `<ul class="ex-examples">${e.examples
            .map(
              (x) =>
                `<li><span class="ex-src">${esc(x.src)}</span>` +
                `${x.trans ? `<span class="ex-trans">${esc(x.trans)}</span>` : ''}</li>`
            )
            .join('')}</ul></div>`
      );
    }
    if (e.notes) {
      parts.push(`<div class="ex-block"><div class="ex-label">用法</div><p class="ex-notes">${esc(e.notes)}</p></div>`);
    }
    if (e.related.length) {
      parts.push(
        `<p class="ex-related"><span class="ex-label-inline">相关</span>${e.related
          .map((r) => `<span class="ex-tag">${esc(r)}</span>`)
          .join('')}</p>`
      );
    }
    return `<div class="ex">${parts.join('')}</div>`;
  }

  /** 详解压成一行纯文本，供生词本导出 CSV / 复制用 */
  function explainToText(explain) {
    const e = normalizeExplain(explain);
    if (!e) return '';
    const lines = [];
    if (e.summary) lines.push(e.summary);
    for (const s of e.senses) lines.push(`${s.pos ? `${s.pos} ` : ''}${s.meaning}${s.detail ? `（${s.detail}）` : ''}`);
    for (const x of e.examples) lines.push(`例：${x.src}${x.trans ? ` — ${x.trans}` : ''}`);
    if (e.notes) lines.push(`用法：${e.notes}`);
    if (e.related.length) lines.push(`相关：${e.related.join('、')}`);
    return lines.join('\n');
  }

  /* ----------------------------- 音标 / 生词本 ----------------------------- */

  // 允许 well-known、naïve、don't 这类写法；不允许空格（词典接口只收单词）
  const SINGLE_WORD_RE = /^[A-Za-zÀ-ÿ]+(?:[-'’][A-Za-zÀ-ÿ]+)*$/;

  /** 是否是可以查音标的英文单词（词典接口只支持单词，短语会 404） */
  function isLookupWord(text) {
    const t = String(text || '').trim();
    return t.length >= 2 && t.length <= 40 && SINGLE_WORD_RE.test(t);
  }

  /** 生词本主键：同一个词不同大小写视为一条 */
  function vocabKey(text, lang) {
    return `${lang || guessVocabLang(text)}|${String(text || '').trim().toLowerCase()}`;
  }

  /** 生词本条目的语种标记，决定朗读用哪种嗓音 */
  function guessVocabLang(text) {
    return guessTextLang(text) === 'zh' ? 'zh' : 'en';
  }

  const KANA_RE = /[぀-ヿ]/;
  const HANGUL_RE = /[가-힣ᄀ-ᇿ]/;

  /**
   * 朗读语种。guessTextLang 把假名也算作 CJK，用它挑嗓音会把日文念成中文，
   * 所以这里单独认一遍假名和谚文。返回 chrome.tts 用的 BCP-47 和百度用的语言码。
   */
  function detectSpeechLang(text, accent) {
    const t = String(text || '');
    if (KANA_RE.test(t)) return { bcp47: 'ja-JP', baidu: 'jp' };
    if (HANGUL_RE.test(t)) return { bcp47: 'ko-KR', baidu: 'kor' };
    if (guessTextLang(t) === 'zh') return { bcp47: 'zh-CN', baidu: 'zh' };
    return { bcp47: accent === 'uk' ? 'en-GB' : 'en-US', baidu: 'en' };
  }

  /** 朗读用的 BCP-47 语言标记 */
  function speechLang(text, accent) {
    return detectSpeechLang(text, accent).bcp47;
  }

  const YOUDAO_AUDIO = 'https://dict.youdao.com/dictvoice';
  // 有道只认词典里的英文词条和短词组：整句和中文一律返回 500，长度和词数先在本地挡掉
  const YOUDAO_TEXT_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*(?: [A-Za-zÀ-ÿ'’-]+){0,2}$/;

  /**
   * 有道词典的发音音频地址（type=1 英式、2 美式）。
   * 不适合的内容返回空串，调用方据此跳过这个音源。
   */
  function youdaoAudioUrl(text, accent, base) {
    const t = String(text || '').trim();
    if (!t || t.length > 40 || !YOUDAO_TEXT_RE.test(t)) return '';
    return `${base || YOUDAO_AUDIO}?audio=${encodeURIComponent(t)}&type=${accent === 'uk' ? 1 : 2}`;
  }

  const BAIDU_TTS = 'https://fanyi.baidu.com/gettts';
  const MAX_SPEAK_CHARS = 1000;

  /**
   * 百度翻译的朗读接口：整句、中日韩都能读，有道那条只认词典词条的路走不通时靠它。
   * 语速不用它的 spd 参数——统一交给播放端的 playbackRate，几个音源的语速才一致。
   */
  function baiduAudioUrl(text, lang, base) {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length > MAX_SPEAK_CHARS) return '';
    return `${base || BAIDU_TTS}?lan=${encodeURIComponent(lang || 'en')}&text=${encodeURIComponent(t)}&spd=3&source=web`;
  }

  /**
   * 翻译专用模型（通义 qwen-mt 系列）：不看 system prompt，目标语言必须通过
   * translation_options 传，也不能用 <seg> 分段协议，需要逐条单发。
   */
  function isTranslationOnlyModel(model) {
    return /(^|[/:])qwen-mt/i.test(String(model || ''));
  }

  /** 把目标语言转成 qwen-mt 认识的语言名 */
  const MT_LANG_MAP = {
    简体中文: 'Chinese',
    中文: 'Chinese',
    繁體中文: 'Traditional Chinese',
    繁体中文: 'Traditional Chinese',
    粤语: 'Cantonese',
    English: 'English',
    英语: 'English',
    日本語: 'Japanese',
    日语: 'Japanese',
    한국어: 'Korean',
    韩语: 'Korean',
    Français: 'French',
    法语: 'French',
    Deutsch: 'German',
    德语: 'German',
    Español: 'Spanish',
    西班牙语: 'Spanish',
    Русский: 'Russian',
    俄语: 'Russian',
    ไทย: 'Thai',
    泰语: 'Thai',
    'Tiếng Việt': 'Vietnamese',
    越南语: 'Vietnamese'
  };

  function mtTargetLang(targetLang) {
    const raw = String(targetLang || '').trim();
    if (MT_LANG_MAP[raw]) return MT_LANG_MAP[raw];
    if (/^[A-Za-z][A-Za-z ()-]*$/.test(raw)) return raw; // 用户直接填了英文语言名
    return CHINESE_TARGET_RE.test(raw) ? 'Chinese' : 'English';
  }

  async function hashText(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  globalThis.DST = {
    DEFAULT_SETTINGS,
    DEFAULT_PROVIDER,
    MAX_PROVIDERS,
    SETTINGS_KEY,
    API_KEYS_KEY,
    normalizeSettings,
    normalizeProvider,
    activeProvider,
    explainProvider,
    loadSettings,
    saveSettings,
    loadApiKey,
    loadApiKeys,
    saveApiKey,
    pruneApiKeys,
    maskKey,
    siteMatches,
    isTranslatable,
    guessTextLang,
    resolveTargetLang,
    parseRepo,
    compareVersions,
    EXPLAIN_AUTO_MAX_CHARS,
    EXPLAIN_MAX_CHARS,
    isExplainable,
    shouldAutoExplain,
    normalizeExplain,
    explainHtml,
    explainToText,
    isLookupWord,
    vocabKey,
    guessVocabLang,
    speechLang,
    detectSpeechLang,
    youdaoAudioUrl,
    baiduAudioUrl,
    MAX_SPEAK_CHARS,
    isTranslationOnlyModel,
    mtTargetLang,
    hashText
  };
})();
