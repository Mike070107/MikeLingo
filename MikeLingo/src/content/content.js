/* MikeLingo - 内容脚本 */
(function () {
  if (window.__dstLoaded) return;
  window.__dstLoaded = true;

  const DST = globalThis.DST;
  // 划词翻译需要在 iframe 里也能用，但整页翻译、HUD、自动翻译只在顶层框架跑
  const IS_TOP = (() => {
    try {
      return window.top === window;
    } catch {
      return false; // 跨域访问 window.top 抛错，说明自己是子框架
    }
  })();
  const FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Hiragino Sans GB", sans-serif';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT',
    'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO', 'IMG', 'TITLE',
    'DST-TRANS', 'DST-ORIGIN', 'DST-ROW'
  ]);
  const BLOCK_DISPLAYS = new Set([
    'block', 'flex', 'grid', 'list-item', 'table', 'table-cell', 'table-caption', 'table-row',
    'flow-root', 'inline-block', 'inline-flex', 'inline-grid'
  ]);

  const state = {
    settings: null,
    active: false,
    mode: 'inline',
    done: 0,
    total: 0,
    error: '',
    records: [],
    seen: new WeakSet(),
    queue: [],
    running: 0,
    session: 0,
    stopped: false,
    observer: null,
    mutationObserver: null,
    keepAliveTimer: null
  };

  /* -------------------------------- 设置读取 ------------------------------- */

  // 子框架不在初始化时读设置（页面里可能有几十个广告 iframe），
  // 等真的发生划词再懒加载；读取失败也要退回默认值，否则划词会被永久禁用。
  let settingsPromise = null;
  function ensureSettings() {
    if (state.settings) return Promise.resolve(state.settings);
    if (!settingsPromise) {
      settingsPromise = DST.loadSettings()
        .then((s) => {
          state.settings = s;
          return s;
        })
        .catch(() => {
          settingsPromise = null;
          return DST.normalizeSettings(null);
        });
    }
    return settingsPromise;
  }

  /* ------------------------------ 与后台通信 ------------------------------ */

  async function send(message) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      return res || { ok: false, error: '扩展后台无响应，请重新加载页面' };
    } catch (err) {
      return { ok: false, error: `扩展后台连接失败：${err?.message || err}` };
    }
  }

  function reportState() {
    send({
      type: 'STATE_CHANGED',
      state: { active: state.active, mode: state.mode, done: state.done, total: state.total, error: state.error }
    });
  }

  function startKeepAlive() {
    if (state.keepAliveTimer) return;
    state.keepAliveTimer = setInterval(() => {
      if (state.running > 0 || state.queue.length > 0) send({ type: 'PING' });
      else stopKeepAlive();
    }, 15000);
  }
  function stopKeepAlive() {
    clearInterval(state.keepAliveTimer);
    state.keepAliveTimer = null;
  }

  /* -------------------------------- 段落抽取 ------------------------------- */

  function isBlockContainer(el) {
    const display = getComputedStyle(el).display;
    return BLOCK_DISPLAYS.has(display);
  }

  function isSkipped(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.documentElement) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.isContentEditable) return true;
      if (el.getAttribute && (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-dst-skip'))) return true;
      if (el.classList && el.classList.contains('dst-ui')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  /** 收集页面中可翻译的块级容器 */
  function collectBlocks(root) {
    const map = new Map(); // container -> textNodes[]
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (isSkipped(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      let container = node.parentElement;
      while (container && container !== document.body && !isBlockContainer(container)) {
        container = container.parentElement;
      }
      if (!container || state.seen.has(container)) continue;
      if (!map.has(container)) map.set(container, []);
      map.get(container).push(node);
    }

    const blocks = [];
    for (const [container, textNodes] of map) {
      const text = textNodes.map((n) => n.nodeValue).join(' ').replace(/\s+/g, ' ').trim();
      if (!DST.isTranslatable(text, state.settings.onlyTranslateForeign)) {
        state.seen.add(container);
        continue;
      }
      if (!isVisible(container)) continue;
      blocks.push({ container, textNodes, text });
    }
    return blocks;
  }

  /* -------------------------------- 译文插入 ------------------------------- */

  function createTranslationNode(text) {
    const el = document.createElement('dst-trans');
    el.className = `dst-translation dst-style-${state.settings.styleVariant} dst-font-${state.settings.translationFont}`;
    el.setAttribute('dir', 'auto');
    el.textContent = text;
    if (state.settings.fontScale !== 100) el.style.fontSize = `${state.settings.fontScale}%`;
    if (state.settings.translationFont === 'cjk') el.style.fontFamily = FONT_STACK;
    return el;
  }

  function topInlineAncestor(textNode, container) {
    let node = textNode;
    while (node.parentElement && node.parentElement !== container) node = node.parentElement;
    return node;
  }

  function wrapOriginals(record) {
    record.wrappers = [];
    for (const textNode of record.textNodes) {
      if (!textNode.isConnected || !textNode.parentNode) continue;
      const wrapper = document.createElement('dst-origin');
      wrapper.className = 'dst-origin';
      textNode.parentNode.insertBefore(wrapper, textNode);
      wrapper.appendChild(textNode);
      record.wrappers.push(wrapper);
    }
  }

  /** 并列模式：把原文整段（首个到最后一个文本节点之间）包进同一个容器，避免被拆成多列 */
  function wrapOriginalRange(record) {
    const { container, textNodes } = record;
    const first = topInlineAncestor(textNodes[0], container);
    const last = topInlineAncestor(textNodes[textNodes.length - 1], container);
    if (!first.parentNode) return;
    const wrapper = document.createElement('dst-origin');
    wrapper.className = 'dst-origin';
    container.insertBefore(wrapper, first);
    let node = first;
    while (node) {
      const next = node.nextSibling;
      wrapper.appendChild(node);
      if (node === last) break;
      node = next;
    }
    record.wrappers = [wrapper];
  }

  function applyTranslation(record, translation) {
    const { container, textNodes } = record;
    if (!container.isConnected) return;
    const node = createTranslationNode(translation);
    record.node = node;
    const mode = state.mode;

    if (mode === 'replace') {
      wrapOriginals(record);
      for (const w of record.wrappers) w.classList.add('dst-origin-hidden');
      const anchor = record.wrappers[record.wrappers.length - 1];
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
      else container.appendChild(node);
      return;
    }

    if (mode === 'columns') {
      wrapOriginalRange(record);
      const wrapper = record.wrappers[0];
      if (!wrapper || !wrapper.parentNode) return;
      // 用独立的行容器承载两栏，而不是把原元素改成 flex：
      // 后者会让 li 丢掉项目符号、表格单元格等布局失效。
      const row = document.createElement('dst-row');
      row.className = 'dst-row';
      wrapper.parentNode.insertBefore(row, wrapper);
      wrapper.classList.add('dst-col');
      node.classList.add('dst-col');
      row.append(wrapper, node);
      record.row = row;
      return;
    }

    // inline：译文插在原文下方
    const last = textNodes[textNodes.length - 1];
    if (last && last.isConnected && last.parentNode) {
      const anchor = topInlineAncestor(last, container);
      anchor.parentNode.insertBefore(node, anchor.nextSibling);
    } else {
      container.appendChild(node);
    }
  }

  function unwrap(element) {
    if (!element || !element.parentNode) return;
    while (element.firstChild) element.parentNode.insertBefore(element.firstChild, element);
    element.remove();
  }

  function undoRecord(record) {
    if (record.node && record.node.parentNode) record.node.remove();
    for (const wrapper of record.wrappers || []) unwrap(wrapper);
    unwrap(record.row);
  }

  /* --------------------------------- 队列 --------------------------------- */

  function enqueue(blocks) {
    for (const block of blocks) {
      if (state.seen.has(block.container)) continue;
      state.seen.add(block.container);
      state.queue.push(block);
      state.total++;
    }
    updateHud();
    pump();
  }

  function takeBatch() {
    const batch = [];
    let chars = 0;
    while (state.queue.length && batch.length < state.settings.batchSize) {
      const next = state.queue[0];
      if (batch.length && chars + next.text.length > state.settings.batchChars) break;
      batch.push(state.queue.shift());
      chars += next.text.length;
    }
    return batch;
  }

  async function pump() {
    if (state.stopped) return;
    while (state.running < state.settings.concurrency && state.queue.length) {
      const batch = takeBatch();
      if (!batch.length) break;
      const session = state.session;
      state.running++;
      startKeepAlive();
      runBatch(batch, session).finally(() => {
        if (session !== state.session) return; // 上一轮的请求，不影响本轮计数
        state.running--;
        if (!state.stopped) pump();
        else updateHud();
      });
    }
    updateHud();
  }

  async function runBatch(batch, session) {
    const res = await send({ type: 'TRANSLATE', texts: batch.map((b) => b.text) });
    if (state.stopped || session !== state.session) return;
    if (!res.ok) {
      if (res.code === 'NO_API_KEY') {
        state.error = res.error || '翻译失败';
        state.done += batch.length;
        state.stopped = true;
        state.queue.length = 0;
        updateHud();
        return;
      }
      // 限流 / 超时 / 网络抖动这类暂时性失败：后台已经退避重试过，这里再给一次机会，
      // 把这批段落放回队尾重排（每段只补一次），否则整页会永久留下一块没译的空白。
      if (res.retryable && batch.every((b) => !b.retried)) {
        for (const block of batch) {
          block.retried = true;
          state.queue.push(block);
        }
        updateHud();
        return;
      }
      state.error = res.error || '翻译失败';
      state.done += batch.length;
      updateHud();
      return;
    }
    state.error = '';
    batch.forEach((block, i) => {
      const translation = res.results[i];
      state.done++;
      if (!translation) return;
      const normalized = String(translation).trim();
      if (!normalized || normalized === block.text) return;
      const record = { container: block.container, textNodes: block.textNodes, wrappers: [] };
      try {
        applyTranslation(record, normalized);
        state.records.push(record);
      } catch {
        /* 个别节点插入失败不影响整体 */
      }
    });
    updateHud();
  }

  /* --------------------------------- 开关 --------------------------------- */

  function observeViewport(blocks) {
    if (!state.observer) {
      const pending = new Map();
      // 回调只认自己这一轮的 observer：停止翻译后残留的回调若操作新一轮的实例，
      // 会把刚注册的元素 unobserve 掉，导致整页一个段落都收集不到。
      const observer = new IntersectionObserver(
        (entries, self) => {
          if (state.observer !== self) return;
          const ready = [];
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            self.unobserve(entry.target);
            const block = pending.get(entry.target);
            if (block) {
              pending.delete(entry.target);
              ready.push(block);
            }
          }
          if (ready.length) enqueue(ready);
        },
        { rootMargin: '600px 0px' }
      );
      state.observer = observer;
      state.pendingMap = pending;
    }
    for (const block of blocks) {
      state.pendingMap.set(block.container, block);
      state.observer.observe(block.container);
    }
  }

  function scan(root) {
    const blocks = collectBlocks(root);
    if (!blocks.length) return;
    observeViewport(blocks);
  }

  function watchMutations() {
    if (state.mutationObserver) return;
    state.mutationObserver = new MutationObserver((mutations) => {
      if (!state.active) return;
      const hasNew = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (n) => (n.nodeType === 1 && !SKIP_TAGS.has(n.tagName)) || (n.nodeType === 3 && n.nodeValue.trim())
        )
      );
      if (!hasNew) return;
      clearTimeout(state.mutationTimer);
      // 停止翻译后这个延时回调仍可能触发，必须再次确认状态，
      // 否则会把段落塞进已停用的队列，并让下一轮把它们误判成「已处理」而整页跳过。
      state.mutationTimer = setTimeout(() => {
        if (state.active) scan(document.body);
      }, 800);
    });
    state.mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  async function startTranslate() {
    settingsPromise = null; // 每次开始翻译都取最新设置
    state.settings = null;
    state.settings = await ensureSettings();
    state.mode = state.settings.displayMode;
    state.active = true;
    state.stopped = false;
    state.error = '';
    state.done = 0;
    state.total = 0;
    state.running = 0;
    state.session++;
    state.queue.length = 0;
    state.seen = new WeakSet();
    showHud();
    scan(document.body);
    watchMutations();
    reportState();
    updateHud();
  }

  function stopTranslate() {
    state.stopped = true;
    state.active = false;
    state.queue.length = 0;
    state.observer?.disconnect();
    state.observer = null;
    state.pendingMap = null;
    state.mutationObserver?.disconnect();
    state.mutationObserver = null;
    clearTimeout(state.mutationTimer);
    stopKeepAlive();
    for (const record of state.records) {
      try {
        undoRecord(record);
      } catch {
        /* ignore */
      }
    }
    state.records = [];
    state.seen = new WeakSet();
    state.done = 0;
    state.total = 0;
    state.error = '';
    hideHud();
    reportState();
  }

  async function toggleTranslate() {
    if (state.active) stopTranslate();
    else await startTranslate();
  }

  async function setMode(mode) {
    const wasActive = state.active;
    await DST.saveSettings({ displayMode: mode });
    if (wasActive) {
      stopTranslate();
      await startTranslate();
    } else {
      state.settings = await DST.loadSettings();
    }
  }

  /* ------------------------------- 悬浮界面 ------------------------------- */

  const ui = { host: null, root: null, hud: null, button: null, card: null };

  const UI_STYLES = `
    :host { all: initial; }
    :where(div, span, button, p, section) { box-sizing: border-box; margin: 0; padding: 0; font-family: ${FONT_STACK}; }
    :where(button) { border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
    .hud, .card, .trigger { position: fixed; z-index: 2147483647; }
    .hud {
      right: 20px; bottom: 20px; display: none; align-items: center; gap: 12px;
      padding: 10px 14px; border-radius: 12px; background: #111827; color: #f9fafb;
      font-size: 13px; line-height: 1.5; box-shadow: 0 8px 28px rgba(0,0,0,.28); max-width: 380px;
    }
    .hud.show { display: flex; }
    .hud.error { background: #7f1d1d; }
    .hud-text { flex: 1; min-width: 0; }
    .hud-title { font-weight: 600; }
    .hud-detail { margin-top: 2px; color: #d1d5db; word-break: break-word; }
    .hud.error .hud-detail { color: #fecaca; }
    .hud-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .hud button {
      padding: 5px 10px; border-radius: 8px; background: rgba(255,255,255,.14); color: #fff;
      font-size: 12px; transition: background .2s ease;
    }
    .hud button:hover { background: rgba(255,255,255,.26); }
    .spinner {
      width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.28); border-top-color: #fff;
      border-radius: 50%; animation: dst-spin .8s linear infinite; flex-shrink: 0;
    }
    @keyframes dst-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2s; } }

    .trigger {
      display: none; align-items: center; justify-content: center; width: 30px; height: 30px;
      border-radius: 8px; background: #2563eb; color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,.4);
      transition: transform .15s ease, background .15s ease;
    }
    .trigger.show { display: flex; }
    .trigger:hover { background: #1d4ed8; transform: translateY(-1px); }
    .trigger svg { width: 17px; height: 17px; }

    /* max-height 给到 72vh：真实的详解（释义 + 例句 + 用法 + 相关词）在 60vh 下
       会把"用法"这类关键信息压到折叠区里，用户不翻就看不到 */
    .card {
      display: none; width: 380px; max-width: calc(100vw - 32px); max-height: 72vh; overflow: hidden;
      flex-direction: column; border-radius: 14px; background: #fff; color: #111827;
      box-shadow: 0 12px 40px rgba(0,0,0,.18); border: 1px solid #e5e7eb;
    }
    .card.show { display: flex; }
    .card-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 10px 14px; border-bottom: 1px solid #f1f5f9; font-size: 12px; color: #6b7280;
    }
    .card-title { display: flex; align-items: center; gap: 6px; font-weight: 600; color: #374151; }
    .card-lang { margin-left: auto; font-size: 11.5px; color: #9ca3af; white-space: nowrap; }
    .card-title svg { width: 14px; height: 14px; color: #2563eb; }
    .icon-btn { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; color: #9ca3af; }
    .icon-btn:hover { background: #f3f4f6; color: #374151; }
    .icon-btn svg { width: 14px; height: 14px; }
    .card-body { padding: 12px 14px; overflow: auto; font-size: 14px; line-height: 1.7; }
    .card-source { color: #6b7280; font-size: 13px; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px dashed #e5e7eb; white-space: pre-wrap; }
    .card-result { white-space: pre-wrap; word-break: break-word; }

    /* 音标行：音标是次要信息，用等宽以免 IPA 字符间距忽宽忽窄 */
    .card-pron { display: flex; align-items: center; gap: 8px; margin-top: 6px; white-space: normal; }
    .card-phonetic {
      font-family: "Segoe UI", "Lucida Sans Unicode", ${FONT_STACK};
      font-size: 12.5px; color: #6b7280; letter-spacing: .2px;
    }
    .card-phonetic:empty { display: none; }
    .speak-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      height: 24px; padding: 0 8px; border-radius: 999px; background: #eef2ff; color: #4338ca;
      font-size: 12px; transition: background .2s ease, color .2s ease;
    }
    .speak-btn:hover { background: #e0e7ff; }
    .speak-btn:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
    .speak-btn[disabled] { opacity: .55; cursor: default; }
    .speak-btn svg { width: 13px; height: 13px; }
    .speak-btn.playing { background: #4f46e5; color: #fff; }
    .card-pron-hint { font-size: 11.5px; color: #9ca3af; }
    .card-error { color: #b91c1c; }
    .card-error button { margin-top: 8px; padding: 5px 10px; border-radius: 8px; background: #fee2e2; color: #991b1b; font-size: 12px; }
    .card-loading { display: flex; align-items: center; gap: 8px; color: #6b7280; font-size: 13px; }
    .card-loading .spinner { border-color: #e5e7eb; border-top-color: #2563eb; }
    .card-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 8px 14px; border-top: 1px solid #f1f5f9; }
    .card-foot button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: 8px; background: #f3f4f6; color: #374151; font-size: 12px; transition: background .2s ease; }
    .card-foot button:hover { background: #e5e7eb; }
    .card-foot button:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
    .card-foot button svg { width: 13px; height: 13px; }
    .card-foot .save-btn { margin-right: auto; }
    .card-foot .save-btn.saved { background: #dcfce7; color: #15803d; }
    .card-foot .save-btn.saved:hover { background: #bbf7d0; }
    .card-foot .save-btn[disabled] { opacity: .6; cursor: default; }

    /* 词典详解：和译文之间拉开一条分隔线，层级上属于"补充信息"，字号比译文小一档 */
    .card-explain:empty { display: none; }
    .card-explain { margin-top: 12px; padding-top: 12px; border-top: 1px solid #f1f5f9; }
    .ex { display: flex; flex-direction: column; gap: 10px; font-size: 13px; line-height: 1.7; }
    .ex-summary { color: #374151; }
    .ex-kind {
      display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 5px;
      background: #eef2ff; color: #4338ca; font-size: 11px; vertical-align: 1px;
    }
    .ex-senses { display: flex; flex-direction: column; gap: 6px; margin: 0; padding-left: 18px; list-style: decimal outside; }
    .ex-senses li { color: #374151; }
    .ex-pos {
      margin-right: 6px; color: #6366f1; font-size: 12px; font-style: italic;
      font-family: "Segoe UI", ${FONT_STACK};
    }
    .ex-detail { display: block; margin-top: 2px; color: #6b7280; font-size: 12.5px; }
    .ex-block { display: flex; flex-direction: column; gap: 5px; }
    .ex-label { color: #9ca3af; font-size: 11.5px; letter-spacing: .5px; }
    .ex-examples { display: flex; flex-direction: column; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .ex-examples li { padding-left: 9px; border-left: 2px solid #e0e7ff; }
    .ex-src { display: block; color: #374151; }
    .ex-trans { display: block; color: #6b7280; font-size: 12.5px; }
    .ex-notes { margin: 0; color: #6b7280; }
    .ex-related { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; }
    .ex-label-inline { color: #9ca3af; font-size: 11.5px; }
    .ex-tag { padding: 1px 8px; border-radius: 999px; background: #f3f4f6; color: #4b5563; font-size: 12px; }
    .ex-error { display: flex; align-items: center; gap: 8px; color: #b91c1c; font-size: 12.5px; }
    .ex-error button { padding: 3px 10px; border-radius: 8px; background: #fee2e2; color: #991b1b; font-size: 12px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1f2937; color: #f3f4f6; border-color: #374151; }
      .card-head, .card-foot { border-color: #374151; }
      .card-title { color: #e5e7eb; }
      .card-source { color: #9ca3af; border-color: #374151; }
      .card-foot button { background: #374151; color: #e5e7eb; }
      .card-foot .save-btn.saved { background: #14532d; color: #bbf7d0; }
      .icon-btn:hover { background: #374151; }
      .card-phonetic { color: #9ca3af; }
      .speak-btn { background: #312e81; color: #c7d2fe; }
      .speak-btn:hover { background: #3730a3; }
      .speak-btn.playing { background: #6366f1; color: #fff; }
      .card-explain { border-color: #374151; }
      .ex-summary, .ex-senses li, .ex-src { color: #e5e7eb; }
      .ex-kind { background: #312e81; color: #c7d2fe; }
      .ex-pos { color: #a5b4fc; }
      .ex-detail, .ex-trans, .ex-notes { color: #9ca3af; }
      .ex-examples li { border-color: #4338ca; }
      .ex-tag { background: #374151; color: #d1d5db; }
    }
    @media (prefers-reduced-motion: reduce) {
      .speak-btn, .card-foot button, .trigger { transition: none; }
    }
  `;

  const ICONS = {
    translate:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10"/><path d="M9 3v2c0 4.4-2.7 8-6 8"/><path d="M5 9c0 2.8 2.7 5.2 6 6"/><path d="m12 20 4.5-11L21 20"/><path d="M14 16h5"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    speaker:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    bookmark:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    book:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7"/></svg>'
  };

  function ensureUi() {
    if (ui.host) return;
    const host = document.createElement('div');
    host.className = 'dst-ui';
    host.setAttribute('data-dst-skip', '');
    // position: fixed 会让宿主自成层叠上下文，内部的 z-index 只在该上下文内有效。
    // 宿主自己必须也拿最高 z-index，否则站点里任何 z-index>0 的浮层都会盖住划词按钮和卡片。
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_STYLES;
    root.appendChild(style);

    const hud = document.createElement('div');
    hud.className = 'hud';
    root.appendChild(hud);

    const trigger = document.createElement('button');
    trigger.className = 'trigger';
    trigger.type = 'button';
    trigger.title = '翻译选中文本';
    trigger.innerHTML = ICONS.translate;
    trigger.addEventListener('mousedown', (e) => e.preventDefault());
    trigger.addEventListener('click', () => {
      hideTrigger();
      translateSelection(selectionCache.text, selectionCache.rect);
    });
    root.appendChild(trigger);

    const card = document.createElement('section');
    card.className = 'card';
    root.appendChild(card);

    (document.body || document.documentElement).appendChild(host);
    Object.assign(ui, { host, root, hud, button: trigger, card });
  }

  function showHud() {
    ensureUi();
    ui.hud.classList.add('show');
  }
  function hideHud() {
    if (ui.hud) ui.hud.classList.remove('show');
  }

  function updateHud() {
    if (!state.active && !state.error) return;
    ensureUi();
    const finished = state.done >= state.total && state.running === 0 && state.queue.length === 0;
    ui.hud.classList.toggle('error', Boolean(state.error));
    const pendingScroll = state.pendingMap ? state.pendingMap.size : 0;

    if (state.error) {
      ui.hud.innerHTML = `
        <div class="hud-text">
          <div class="hud-title">翻译出错</div>
          <div class="hud-detail"></div>
        </div>
        <div class="hud-actions">
          <button data-act="settings">去设置</button>
          <button data-act="close">关闭</button>
        </div>`;
      ui.hud.querySelector('.hud-detail').textContent = state.error;
    } else if (finished) {
      ui.hud.innerHTML = `
        <div class="hud-text">
          <div class="hud-title">已翻译 ${state.done} 个段落</div>
          <div class="hud-detail">${pendingScroll ? '继续滚动可翻译更多内容' : '滚动或点击工具栏图标可还原原文'}</div>
        </div>
        <div class="hud-actions">
          <button data-act="restore">还原</button>
          <button data-act="close">关闭</button>
        </div>`;
    } else {
      ui.hud.innerHTML = `
        <div class="spinner"></div>
        <div class="hud-text">
          <div class="hud-title">正在翻译 ${state.done}/${state.total}</div>
          <div class="hud-detail">${escapeHtml(DST.activeProvider(state.settings).name)} · ${modeLabel(state.mode)}</div>
        </div>
        <div class="hud-actions"><button data-act="restore">停止</button></div>`;
    }
    ui.hud.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'settings') send({ type: 'OPEN_OPTIONS' });
        if (act === 'restore') stopTranslate();
        if (act === 'close') {
          state.error = '';
          hideHud();
        }
      });
    });
    ui.hud.classList.add('show');
    reportState();
  }

  function modeLabel(mode) {
    return { inline: '段落对照', columns: '左右并列', replace: '仅显示译文' }[mode] || mode;
  }

  /* ------------------------------- 划词翻译 ------------------------------- */

  const selectionCache = { text: '', rect: null, context: '' };

  // 当前卡片承载的内容：朗读、加入生词本都从这里取，避免再去读 DOM
  const cardData = {
    text: '',
    translation: '',
    targetLang: '',
    lang: 'en',
    phonetic: '',
    audioUrl: '',
    key: '',
    saved: false,
    explain: null,
    explainState: 'idle', // idle | loading | done | error
    explainError: ''
  };

  function resetCardData(text) {
    cardData.text = text;
    cardData.translation = '';
    cardData.targetLang = '';
    cardData.lang = DST.guessVocabLang(text);
    cardData.phonetic = '';
    cardData.audioUrl = '';
    cardData.key = DST.vocabKey(text, cardData.lang);
    cardData.saved = false;
    cardData.explain = null;
    cardData.explainState = 'idle';
    cardData.explainError = '';
  }

  function hideTrigger() {
    if (ui.button) ui.button.classList.remove('show');
  }
  function hideCard() {
    if (ui.card) ui.card.classList.remove('show');
  }

  function placeElement(el, rect, width, height) {
    const margin = 8;
    let left = rect.left;
    let top = rect.bottom + margin;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    if (top + height > window.innerHeight - margin) {
      const above = rect.top - height - margin;
      top = above > margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function showTrigger(rect) {
    ensureUi();
    ui.button.classList.add('show');
    placeElement(ui.button, rect, 30, 30);
  }

  /** 卡片内容高度会变（详解回来、报错），每次变完都要重新贴一次位置 */
  function positionCard(rect) {
    if (!ui.card || !rect) return;
    const height = Math.min(ui.card.offsetHeight || 200, window.innerHeight * 0.6);
    placeElement(ui.card, rect, ui.card.offsetWidth || 380, height);
  }

  function renderCard(inner, rect) {
    ensureUi();
    ui.card.innerHTML = inner;
    ui.card.classList.add('show');
    positionCard(rect);
    ui.card.querySelector('[data-act="close"]')?.addEventListener('click', hideCard);
    ui.card.querySelector('[data-act="copy"]')?.addEventListener('click', async (e) => {
      const text = ui.card.querySelector('.card-result')?.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        e.currentTarget.textContent = '已复制';
        setTimeout(() => (e.currentTarget.textContent = '复制译文'), 1500);
      } catch {
        e.currentTarget.textContent = '复制失败';
      }
    });
    ui.card.querySelector('[data-act="settings"]')?.addEventListener('click', () => send({ type: 'OPEN_OPTIONS' }));
    ui.card.querySelector('[data-act="retry"]')?.addEventListener('click', () => translateSelection(selectionCache.text, rect));
    ui.card.querySelector('[data-act="speak"]')?.addEventListener('click', (e) => speakFromCard(e.currentTarget));
    ui.card.querySelector('[data-act="save"]')?.addEventListener('click', (e) => toggleSaveWord(e.currentTarget));
    ui.card.querySelector('[data-act="vocab"]')?.addEventListener('click', () => send({ type: 'OPEN_VOCAB' }));
    ui.card.querySelector('[data-act="explain"]')?.addEventListener('click', () => loadExplain(cardData.text, rect));
    renderExplain(rect);
  }

  function cardShell(bodyHtml, footHtml, targetLang) {
    return `
      <div class="card-head">
        <div class="card-title">${ICONS.translate}<span>划词翻译</span></div>
        <span class="card-lang">${targetLang ? `译为 ${escapeHtml(targetLang)}` : ''}</span>
        <button class="icon-btn" data-act="close" title="关闭">${ICONS.close}</button>
      </div>
      <div class="card-body">${bodyHtml}</div>
      ${footHtml || ''}`;
  }

  /* --------------------------- 音标 / 朗读 / 生词本 --------------------------- */

  /** 原文行：音标查到才显示，朗读按钮始终可用（查不到音标也能用系统语音读） */
  function pronunciationHtml() {
    return `
      <div class="card-pron">
        <button type="button" class="speak-btn" data-act="speak" title="朗读原文" aria-label="朗读原文">
          ${ICONS.speaker}<span>朗读</span>
        </button>
        <span class="card-phonetic">${escapeHtml(cardData.phonetic)}</span>
        <span class="card-pron-hint"></span>
      </div>`;
  }

  function saveButtonHtml() {
    return `
      <button type="button" class="save-btn${cardData.saved ? ' saved' : ''}" data-act="save">
        ${cardData.saved ? ICONS.check : ICONS.bookmark}<span>${cardData.saved ? '已加入生词本' : '加入生词本'}</span>
      </button>`;
  }

  /* -------------------------------- 词典详解 -------------------------------- */

  /** 手动详解的按钮：auto 模式下已经自动查了就不再显示 */
  function explainButtonHtml() {
    const mode = state.settings?.explainMode || DST.DEFAULT_SETTINGS.explainMode;
    if (mode === 'off' || !DST.isExplainable(cardData.text)) return '';
    if (cardData.explainState !== 'idle') return '';
    if (DST.shouldAutoExplain(cardData.text, mode)) return ''; // 自动模式下已经在查了
    return `<button type="button" data-act="explain">${ICONS.book}<span>详细解释</span></button>`;
  }

  /**
   * 详解区域单独渲染，不重画整张卡片——重画会丢掉已经填好的音标、
   * 也会让用户正在读的内容跳一下。
   */
  function renderExplain(rect) {
    const slot = ui.card?.querySelector('.card-explain');
    if (!slot) return;
    if (cardData.explainState === 'loading') {
      slot.innerHTML = `<div class="card-loading"><span class="spinner"></span><span>正在查词典…</span></div>`;
    } else if (cardData.explainState === 'error') {
      slot.innerHTML = `<div class="ex-error">${escapeHtml(cardData.explainError)}<button type="button" data-act="explain">重试</button></div>`;
      slot.querySelector('[data-act="explain"]')?.addEventListener('click', () => loadExplain(cardData.text, rect));
    } else if (cardData.explain) {
      slot.innerHTML = DST.explainHtml(cardData.explain);
    } else {
      slot.innerHTML = '';
      return;
    }
    positionCard(rect || selectionCache.rect);
  }

  /** 查详解；期间卡片可能已经换了内容，回来时要比对一次 */
  async function loadExplain(text, rect) {
    const clean = String(text || '').trim();
    if (!clean || cardData.explainState === 'loading') return;
    cardData.explainState = 'loading';
    cardData.explainError = '';
    // 「详细解释」按钮点完就没用了，去掉它，位置让给详解内容
    ui.card?.querySelector('.card-foot [data-act="explain"]')?.remove();
    renderExplain(rect);

    const res = await send({ type: 'EXPLAIN', text: clean, targetLang: cardData.targetLang || undefined });
    if (cardData.text !== clean || !ui.card?.classList.contains('show')) return;

    if (res.ok && res.explain) {
      cardData.explain = res.explain;
      cardData.explainState = 'done';
      // 详解比「加入生词本」晚回来时，把已存的词条补全，否则复习时只有一句译文
      if (cardData.saved && cardData.key) {
        send({ type: 'VOCAB_UPDATE', key: cardData.key, patch: { explain: res.explain } });
      }
    } else {
      cardData.explainState = 'error';
      cardData.explainError = res.error || '详解失败';
    }
    renderExplain(rect);
  }

  function cardHint(message) {
    const hint = ui.card?.querySelector('.card-pron-hint');
    if (!hint) return;
    hint.textContent = message || '';
  }

  async function speakFromCard(btn) {
    if (!cardData.text) return;
    btn.disabled = true;
    btn.classList.add('playing');
    cardHint('');
    const res = await send({ type: 'SPEAK', text: cardData.text, audioUrl: cardData.audioUrl });
    btn.disabled = false;
    // 播放本身是异步的，按钮只做一个短促的"已触发"反馈
    setTimeout(() => btn.classList.remove('playing'), 700);
    if (!res.ok) cardHint(res.error || '朗读失败');
  }

  function renderSaveButton(btn) {
    btn.classList.toggle('saved', cardData.saved);
    btn.innerHTML = `${cardData.saved ? ICONS.check : ICONS.bookmark}<span>${
      cardData.saved ? '已加入生词本' : '加入生词本'
    }</span>`;
    btn.title = cardData.saved ? '再次点击可从生词本移除' : '加入生词本，之后可以复习';
  }

  async function toggleSaveWord(btn) {
    if (!cardData.text) return;
    btn.disabled = true;
    cardHint('');

    if (cardData.saved) {
      const res = await send({ type: 'VOCAB_REMOVE', key: cardData.key });
      if (res.ok) cardData.saved = false;
      else cardHint(res.error || '移除失败');
    } else {
      const res = await send({
        type: 'VOCAB_ADD',
        entry: {
          word: cardData.text,
          lang: cardData.lang,
          translation: cardData.translation,
          phonetic: cardData.phonetic,
          audioUrl: cardData.audioUrl,
          explain: cardData.explain, // 详解一起存下来，复习时不用再查一次接口
          context: selectionCache.context,
          sourceTitle: document.title || ''
        }
      });
      if (res.ok) {
        cardData.saved = true;
        cardData.key = res.entry.key;
        cardHint(res.created ? '已加入，可在生词本复习' : '生词本里已有这条，已补全信息');
      } else {
        cardHint(res.error || '加入生词本失败');
      }
    }
    btn.disabled = false;
    renderSaveButton(btn);
  }

  /** 查音标：只对单词发起，结果回来时卡片可能已经换内容了，要比对一次 */
  async function loadPronunciation(text) {
    if (!DST.isLookupWord(text)) return;
    const res = await send({ type: 'DICT_LOOKUP', word: text });
    if (!res.ok || cardData.text !== text) return;
    cardData.phonetic = res.phonetic || '';
    cardData.audioUrl = res.audioUrl || '';
    const slot = ui.card?.querySelector('.card-phonetic');
    if (slot) slot.textContent = cardData.phonetic;
  }

  /** 卡片渲染完再问后台这条是不是已经在生词本里，避免重复添加时状态不对 */
  async function syncSavedState(text) {
    const key = DST.vocabKey(text, DST.guessVocabLang(text));
    const res = await send({ type: 'VOCAB_GET', key });
    if (!res.ok || cardData.text !== text) return;
    cardData.saved = Boolean(res.entry);
    if (res.entry) {
      cardData.key = res.entry.key;
      if (!cardData.phonetic && res.entry.phonetic) {
        cardData.phonetic = res.entry.phonetic;
        cardData.audioUrl = cardData.audioUrl || res.entry.audioUrl || '';
        const slot = ui.card?.querySelector('.card-phonetic');
        if (slot) slot.textContent = cardData.phonetic;
      }
    }
    const btn = ui.card?.querySelector('.save-btn');
    if (btn) renderSaveButton(btn);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function translateSelection(text, rect, { autoSave = false } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const anchor = rect || selectionCache.rect || { left: 20, top: 20, bottom: 40, right: 200 };
    selectionCache.text = clean;
    selectionCache.rect = anchor;
    resetCardData(clean);

    const sourceHtml = () =>
      `<div class="card-source">${escapeHtml(clean.slice(0, 300))}${clean.length > 300 ? '…' : ''}${pronunciationHtml()}</div>`;

    renderCard(
      cardShell(`${sourceHtml()}<div class="card-loading"><span class="spinner"></span><span>正在翻译…</span></div>`),
      anchor
    );

    // 音标和翻译同时发起：音标查得快，先回来先显示，不必等翻译
    const pronouncing = loadPronunciation(clean);

    // 选中的本来就是目标语言时自动中英互译，否则模型只会把原文照抄回来
    const settings = await ensureSettings();
    const targetLang = DST.resolveTargetLang(clean, settings.targetLang);
    cardData.targetLang = targetLang;

    const res = await send({ type: 'TRANSLATE', texts: [clean], targetLang });
    if (!ui.card.classList.contains('show') || cardData.text !== clean) return;

    if (!res.ok) {
      renderCard(
        cardShell(
          `${sourceHtml()}
          <div class="card-error">
            <div>${escapeHtml(res.error || '翻译失败')}</div>
            <button data-act="${res.code === 'NO_API_KEY' ? 'settings' : 'retry'}">${
              res.code === 'NO_API_KEY' ? '前往设置' : '重试'
            }</button>
          </div>`,
          '',
          targetLang
        ),
        anchor
      );
      return;
    }

    const translation = res.results[0] || '（未返回译文）';
    cardData.translation = translation;
    renderCard(
      cardShell(
        `${sourceHtml()}<div class="card-result">${escapeHtml(translation)}</div><div class="card-explain"></div>`,
        `<div class="card-foot">${saveButtonHtml()}${explainButtonHtml()}<button data-act="copy">复制译文</button></div>`,
        targetLang
      ),
      anchor
    );
    // 词和短语顺手把词典详解也带出来；长句只在用户点「详细解释」时才查，不白烧 token
    if (DST.shouldAutoExplain(clean, settings.explainMode)) loadExplain(clean, anchor);

    // 重新渲染会丢掉之前塞进去的音标，等查询结束再补一次
    pronouncing.then(() => {
      if (cardData.text !== clean) return;
      const slot = ui.card?.querySelector('.card-phonetic');
      if (slot) slot.textContent = cardData.phonetic;
    });

    await syncSavedState(clean);
    if (autoSave && !cardData.saved) {
      const btn = ui.card?.querySelector('.save-btn');
      if (btn) await toggleSaveWord(btn);
    }
  }

  const EDITABLE_INPUT_TYPES = /^(text|search|url|email|tel|number|password|)$/i;

  /** 输入框 / 文本域里的选区不会出现在 window.getSelection() 里，需要单独取 */
  function editableSelectionInfo() {
    const el = document.activeElement;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return null;
    if (el.tagName === 'INPUT' && !EDITABLE_INPUT_TYPES.test(el.type || '')) return null;
    let start;
    let end;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      return null; // 部分 input 类型访问 selectionStart 会抛错
    }
    if (start == null || end == null || start === end) return null;
    const value = String(el.value || '');
    const text = value.slice(start, end).replace(/\s+/g, ' ').trim();
    if (text.length < 2) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { text, rect, context: sentenceAround(value, start, end) };
  }

  /**
   * 取选中内容所在的那句话，加入生词本时一起存下来——
   * 单看一个词很难记住用法，复习时有原句才有用。
   */
  function sentenceAround(full, start, end) {
    const text = String(full || '');
    if (!text || start == null) return '';
    const before = text.slice(Math.max(0, start - 200), start);
    const after = text.slice(end, end + 200);
    const head = before.split(/(?<=[.!?。！？\n])\s*/).pop() || '';
    const tail = after.split(/(?<=[.!?。！？\n])\s*/).shift() || '';
    const sentence = `${head}${text.slice(start, end)}${tail}`.replace(/\s+/g, ' ').trim();
    return sentence.length > 4 ? sentence.slice(0, 300) : '';
  }

  /** 选区所在块级元素的整段文字，用来截出上下文原句 */
  function blockTextAround(range, selected) {
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const block = node?.closest?.('p, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, div, section, article');
    if (!block) return '';
    const full = (block.textContent || '').replace(/\s+/g, ' ').trim();
    if (!full || full.length > 2000) return '';
    const at = full.indexOf(selected);
    if (at < 0) return '';
    return sentenceAround(full, at, at + selected.length);
  }

  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return editableSelectionInfo();
    const range = selection.getRangeAt(0);
    // 整页翻译后选中原文会连带选到注入的译文，这里只取原文
    const fragment = range.cloneContents();
    for (const injected of fragment.querySelectorAll('dst-trans')) injected.remove();
    const text = (fragment.textContent || selection.toString()).replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) return editableSelectionInfo();
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return editableSelectionInfo();
    return { text, rect, context: blockTextAround(range, text) };
  }

  const pointer = { down: false, altKey: false };
  let fallbackTimer = 0;
  let lastHandledText = '';

  /** 选区结束后按配置弹按钮或直接翻译 */
  async function handleSelectionEnd(altKey) {
    const info = getSelectionInfo(); // 必须先同步取选区，await 之后选区可能已被页面清掉
    if (!info) {
      hideTrigger();
      lastHandledText = '';
      return;
    }
    const settings = await ensureSettings();
    if (!settings.selectionEnabled) return;
    selectionCache.text = info.text;
    selectionCache.rect = info.rect;
    selectionCache.context = info.context || '';
    lastHandledText = info.text;
    if (settings.selectionTrigger === 'instant' || (settings.selectionTrigger === 'alt' && altKey)) {
      translateSelection(info.text, info.rect);
    } else if (settings.selectionTrigger === 'button') {
      showTrigger(info.rect);
    }
  }

  function insideUi(event) {
    return Boolean(ui.host) && typeof event.composedPath === 'function' && event.composedPath().includes(ui.host);
  }

  // 全部用 window 捕获阶段：不少站点（X、Notion、部分文档站）会在自己的元素上
  // stopPropagation 掉 mouseup，冒泡到 document 的监听器根本收不到，划词就"没反应"。
  const CAPTURE = { capture: true, passive: true };

  window.addEventListener(
    'mousedown',
    (event) => {
      pointer.down = true;
      pointer.altKey = event.altKey;
      if (insideUi(event)) return;
      lastHandledText = '';
      hideTrigger();
      hideCard();
    },
    CAPTURE
  );

  window.addEventListener(
    'mouseup',
    (event) => {
      pointer.down = false;
      pointer.altKey = event.altKey;
      if (insideUi(event)) return;
      clearTimeout(fallbackTimer);
      const altKey = event.altKey;
      setTimeout(() => handleSelectionEnd(altKey), 10);
    },
    CAPTURE
  );

  // 兜底：站点连 mouseup 都吞掉（或用键盘选词）时，靠选区变化触发。
  // 只在选区稳定一段时间、且鼠标没按下、内容与上次处理过的不同才动作，避免拖选途中反复调接口。
  document.addEventListener('selectionchange', () => {
    if (pointer.down) return;
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (pointer.down) return;
      const info = getSelectionInfo();
      if (!info) {
        lastHandledText = '';
        return;
      }
      if (info.text === lastHandledText) return;
      handleSelectionEnd(pointer.altKey);
    }, 500);
  });

  window.addEventListener(
    'keydown',
    (event) => {
      pointer.altKey = event.altKey;
      if (event.key === 'Escape') {
        hideTrigger();
        hideCard();
      }
    },
    CAPTURE
  );

  // 页面内部滚动容器的 scroll 事件不会冒泡到 window，必须用捕获
  window.addEventListener('scroll', hideTrigger, CAPTURE);

  /* -------------------------------- 消息入口 ------------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 子框架只处理"翻译选中文本"，其余一律不回应：
    // tabs.sendMessage 会广播到所有框架，谁先回应谁生效，子框架抢答会让弹窗读到错误的页面状态。
    if (!IS_TOP && msg?.type !== 'TRANSLATE_SELECTION' && msg?.type !== 'ADD_SELECTION_TO_VOCAB') return false;
    (async () => {
      try {
        return await handleMessage(msg, sendResponse);
      } catch (err) {
        sendResponse({ ok: false, error: `内容脚本处理失败：${err?.message || err}` });
      }
    })();
    return true;
  });

  async function handleMessage(msg, sendResponse) {
    switch (msg?.type) {
      case 'TOGGLE_TRANSLATE':
        await toggleTranslate();
        return sendResponse({ ok: true, active: state.active });
      case 'TRANSLATE_SELECTION':
      case 'ADD_SELECTION_TO_VOCAB': {
        const info = getSelectionInfo();
        if (info?.context) selectionCache.context = info.context;
        await translateSelection(msg.text || info?.text || selectionCache.text, info?.rect || selectionCache.rect, {
          autoSave: msg.type === 'ADD_SELECTION_TO_VOCAB'
        });
        return sendResponse({ ok: true });
      }
      case 'SET_MODE':
        await setMode(msg.mode);
        return sendResponse({ ok: true });
      case 'GET_PAGE_STATE':
        return sendResponse({
          ok: true,
          state: {
            active: state.active,
            mode: state.settings?.displayMode || 'inline',
            done: state.done,
            total: state.total,
            error: state.error,
            queued: state.queue.length,
            running: state.running
          }
        });
      case 'SETTINGS_UPDATED':
        state.settings = await DST.loadSettings();
        return sendResponse({ ok: true });
      default:
        return sendResponse({ ok: false });
    }
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    // 还没读过设置的子框架不必因为别处改配置就去读一遍
    if (area === 'sync' && changes[DST.SETTINGS_KEY] && state.settings) {
      state.settings = DST.normalizeSettings(changes[DST.SETTINGS_KEY].newValue);
    }
  });

  /* --------------------------------- 启动 --------------------------------- */

  (async function init() {
    if (!IS_TOP) return; // 子框架等首次划词时再懒加载设置
    const settings = await ensureSettings();
    if (DST.siteMatches(settings.autoTranslateSites, location.href)) {
      startTranslate();
    }
  })();
})();
