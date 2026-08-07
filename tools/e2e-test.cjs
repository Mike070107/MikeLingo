/**
 * 端到端验证：加载未打包扩展 + 本地假接口，真实跑一遍段落对照 / 左右并列 / 划词翻译。
 * 用法：node tools/e2e-test.cjs [--headful]
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const EXT_PATH = path.join(__dirname, '..', 'MikeLingo');
const SHOT_DIR = path.join(__dirname, 'screenshots');
const PORT = 8787;
const PAGE_URL = `http://127.0.0.1:${PORT}/test.html`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** baseUrl / model 会写进第一个 provider（新版结构），密钥写进 apiKeys 映射 */
async function applySettings(worker, patch, apiKey) {
  await worker.evaluate(
    async (patchArg, keyArg) => {
      const current = (await chrome.storage.sync.get('settings')).settings || {};
      const next = Object.assign({}, current, patchArg);
      const provider = Object.assign(
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 1.3, timeout: 60000 },
        (current.providers || [])[0] || {}
      );
      if (patchArg.baseUrl) provider.baseUrl = patchArg.baseUrl;
      if (patchArg.model) provider.model = patchArg.model;
      delete next.baseUrl;
      delete next.model;
      next.providers = [provider];
      next.activeProviderId = provider.id;
      await chrome.storage.sync.set({ settings: next });
      if (keyArg !== null) await chrome.storage.local.set({ apiKeys: { [provider.id]: keyArg }, apiKey: '' });
    },
    patch,
    apiKey === undefined ? null : apiKey
  );
}

/** 词典与发音默认打外网；测试里全部指到本地假接口，跑测试不出网 */
async function useMockDictionary(worker, port) {
  await worker.evaluate(
    async (base, voice) => {
      await chrome.storage.local.set({
        dictBaseUrl: base,
        youdaoBaseUrl: `${voice}/dictvoice`,
        baiduBaseUrl: `${voice}/gettts`
      });
    },
    `http://127.0.0.1:${port}/dict`,
    `http://127.0.0.1:${port}`
  );
}

/** service worker 收不到自己发的消息，借一个普通扩展页面发 */
function askBackground(somePage, message) {
  return somePage.evaluate(async (msg) => chrome.runtime.sendMessage(msg), message);
}

async function toggle(worker) {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
  });
}

/**
 * waitForTarget 拿到 service worker 时，它的执行上下文可能还没挂上扩展 API，
 * 这时候 evaluate 里的 chrome.storage 是 undefined。机器一忙就会撞上，
 * 所以先轮询到 API 真的可用再往下跑。
 */
async function waitForWorkerReady(worker, timeout = 20000) {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeout) {
    try {
      if (await worker.evaluate(() => typeof chrome?.storage?.sync?.get === 'function')) return true;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await sleep(250);
  }
  throw new Error(`Service Worker 执行上下文迟迟不可用${lastError ? `：${lastError}` : ''}`);
}

async function waitFor(page, fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return true;
    await sleep(250);
  }
  return false;
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-server.cjs'), String(PORT)], { stdio: 'inherit' });
  await sleep(800);

  const browser = await puppeteer.launch({
    headless: false,
    // 整页截图在机器忙的时候会超过默认的 30s，超时会把整轮测试打断
    protocolTimeout: 120000,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      // Chrome 137+ 默认禁用 --load-extension，测试时需显式关掉该限制
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900'
    ],
    defaultViewport: { width: 1280, height: 860 }
  });

  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15000 });
    const worker = await swTarget.worker();
    await waitForWorkerReady(worker);
    check('Service Worker 启动', Boolean(worker), swTarget.url());

    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text());
    });

    /* --- 1. 未配置 API Key 的错误提示 --- */
    await applySettings(worker, { baseUrl: `http://127.0.0.1:${PORT}`, displayMode: 'inline' }, '');
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const noKeyOk = await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent || '').includes('API Key')
    );
    check('未配置密钥时提示前往设置', noKeyOk);
    await page.screenshot({ path: path.join(SHOT_DIR, '1-no-key.png') });
    await toggle(worker); // 还原

    /* --- 2. 段落对照 --- */
    await applySettings(worker, { baseUrl: `http://127.0.0.1:${PORT}`, displayMode: 'inline', styleVariant: 'dashed' }, 'sk-mock-key-123456');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const inlineOk = await waitFor(page, () => document.querySelectorAll('dst-trans').length >= 6);
    const inlineInfo = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('dst-trans'));
      const p1 = document.querySelector('#p1');
      const p2 = document.querySelector('#p2');
      return {
        count: nodes.length,
        p1: p1?.querySelector('dst-trans')?.textContent || '',
        p2Merged: (p2?.querySelector('dst-trans')?.textContent || '').includes('inline link'),
        p2Text: p2?.querySelector('dst-trans')?.textContent || '',
        chineseSkipped: !document.querySelector('#cn dst-trans'),
        codeSkipped: !document.querySelector('#code dst-trans'),
        display: p1 ? getComputedStyle(p1.querySelector('dst-trans')).display : '',
        decoration: p1 ? getComputedStyle(p1.querySelector('dst-trans')).textDecorationStyle : '',
        fontFamily: p1 ? getComputedStyle(p1.querySelector('dst-trans')).fontFamily : '',
        hud: document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent?.trim() || ''
      };
    });
    check('段落对照插入译文', inlineOk, `共 ${inlineInfo.count} 段，示例「${inlineInfo.p1.slice(0, 24)}」`);
    check('多文本节点合并为一段', inlineInfo.p2Merged, inlineInfo.p2Text.slice(0, 60));
    check('中文段落被跳过', inlineInfo.chineseSkipped);
    check('代码块被跳过', inlineInfo.codeSkipped);
    check('译文为块级显示', inlineInfo.display === 'block', inlineInfo.display);
    check('虚线样式生效', inlineInfo.decoration === 'dashed', inlineInfo.decoration);
    check('中文字体回退生效', /PingFang|YaHei|Noto Sans SC/i.test(inlineInfo.fontFamily), inlineInfo.fontFamily);
    check('HUD 显示完成状态', /已翻译|正在翻译/.test(inlineInfo.hud), inlineInfo.hud.replace(/\s+/g, ' '));
    await page.screenshot({ path: path.join(SHOT_DIR, '2-inline.png'), fullPage: true });

    /* --- 3. 还原原文 --- */
    await toggle(worker);
    await sleep(400);
    const restored = await page.evaluate(() => ({
      trans: document.querySelectorAll('dst-trans').length,
      origin: document.querySelectorAll('dst-origin').length,
      text: document.querySelector('#p1').textContent.trim().slice(0, 40),
      styleAttr: document.querySelector('#p1').getAttribute('style')
    }));
    check(
      '还原后 DOM 干净',
      restored.trans === 0 && restored.origin === 0 && !restored.styleAttr,
      `trans=${restored.trans} origin=${restored.origin} style=${restored.styleAttr}`
    );
    check('原文完整保留', restored.text.startsWith('Large language models'), restored.text);

    /* --- 4. 左右并列 --- */
    await applySettings(worker, { displayMode: 'columns' });
    await sleep(200);
    await toggle(worker);
    const colOk = await waitFor(page, () => document.querySelectorAll('dst-trans.dst-col').length >= 5);
    const colInfo = await page.evaluate(() => {
      const p1 = document.querySelector('#p1');
      const origin = p1?.querySelector('dst-origin');
      const trans = p1?.querySelector('dst-trans');
      const li = document.querySelector('li');
      if (!origin || !trans) return null;
      return {
        rowDisplay: getComputedStyle(p1.querySelector('dst-row')).display,
        containerDisplay: getComputedStyle(p1).display,
        containerStyle: p1.getAttribute('style'),
        originCount: p1.querySelectorAll('dst-origin').length,
        listDisplay: li ? getComputedStyle(li).display : '',
        sameRow: Math.abs(origin.getBoundingClientRect().top - trans.getBoundingClientRect().top) < 8,
        leftRight: origin.getBoundingClientRect().right <= trans.getBoundingClientRect().left + 1,
        widths: [Math.round(origin.getBoundingClientRect().width), Math.round(trans.getBoundingClientRect().width)]
      };
    });
    check('并列模式插入 flex 行容器', colOk && colInfo?.rowDisplay === 'flex', colInfo?.rowDisplay);
    check(
      '原元素 display 未被篡改',
      colInfo?.containerDisplay === 'block' && !colInfo?.containerStyle,
      `display=${colInfo?.containerDisplay} style=${colInfo?.containerStyle}`
    );
    check('列表项仍保留项目符号', colInfo?.listDisplay === 'list-item', colInfo?.listDisplay);
    check('原文只包一层，未被拆成多列', colInfo?.originCount === 1, `wrappers=${colInfo?.originCount}`);
    check('原文与译文左右同排', Boolean(colInfo?.sameRow && colInfo?.leftRight), `宽度 ${colInfo?.widths?.join(' / ')}`);
    await page.screenshot({ path: path.join(SHOT_DIR, '3-columns.png'), fullPage: true });
    await toggle(worker);
    await sleep(300);
    const colRestored = await page.evaluate(() => ({
      display: getComputedStyle(document.querySelector('#p1')).display,
      style: document.querySelector('#p1').getAttribute('style'),
      origins: document.querySelectorAll('dst-origin').length,
      trans: document.querySelectorAll('dst-trans').length,
      p1Html: document.querySelector('#p1').innerHTML.slice(0, 120)
    }));
    check('并列模式还原后行内样式清除', colRestored.display === 'block' && !colRestored.style, `display=${colRestored.display}`);
    check(
      '并列模式还原后包装元素清除',
      colRestored.origins === 0 && colRestored.trans === 0,
      `origin=${colRestored.origins} trans=${colRestored.trans} html=${colRestored.p1Html}`
    );

    /* --- 5. 仅译文 --- */
    await applySettings(worker, { displayMode: 'replace' });
    await sleep(200);
    await toggle(worker);
    await waitFor(page, () => document.querySelectorAll('dst-trans').length >= 5);
    const replaceInfo = await page.evaluate(() => {
      const p1 = document.querySelector('#p1');
      const hidden = p1.querySelector('dst-origin');
      return {
        originHidden: hidden ? getComputedStyle(hidden).display === 'none' : false,
        visible: p1.innerText.trim().slice(0, 20)
      };
    });
    check('仅译文模式隐藏原文', replaceInfo.originHidden, `可见文本「${replaceInfo.visible}」`);
    await page.screenshot({ path: path.join(SHOT_DIR, '4-replace.png') });
    await toggle(worker);
    await sleep(300);

    /* --- 6. 划词翻译 --- */
    await applySettings(worker, { displayMode: 'inline', selectionEnabled: true, selectionTrigger: 'instant' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(600);
    await page.evaluate(() => {
      const node = document.querySelector('#tail');
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const cardOk = await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-result')?.textContent || '').includes('译文')
    );
    const cardInfo = await page.evaluate(() => {
      const root = document.querySelector('.dst-ui').shadowRoot;
      const card = root.querySelector('.card');
      const rect = card.getBoundingClientRect();
      return {
        text: root.querySelector('.card-result')?.textContent || '',
        inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1,
        hasCopy: Boolean(root.querySelector('[data-act="copy"]'))
      };
    });
    check('划词翻译弹出译文卡片', cardOk, cardInfo.text.slice(0, 40));
    check('卡片完整位于可视区内', cardInfo.inViewport);
    check('卡片提供复制按钮', cardInfo.hasCopy);
    await page.screenshot({ path: path.join(SHOT_DIR, '5-selection.png') });

    // 整页翻译后再划词，选区不应把注入的译文一起当作原文
    await toggle(worker);
    await waitFor(page, () => document.querySelectorAll('dst-trans').length >= 5);
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#p1'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await sleep(1500);
    const source = await page.evaluate(
      () => document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-source')?.textContent || ''
    );
    check('划词原文剔除已注入的译文', source.length > 0 && !source.includes('【译文】'), source.slice(0, 50));
    await toggle(worker);
    await sleep(300);

    /* --- 6b. 默认「显示按钮」模式 + 站点吞掉 mouseup + 高 z-index 浮层 --- */
    await applySettings(worker, { selectionTrigger: 'button' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(700);
    await page.evaluate(() => {
      // 真实站点常见的两种「杀手」：在自己元素上 stopPropagation，以及全屏高层级浮层
      document.querySelector('#p1').addEventListener('mouseup', (e) => e.stopPropagation());
      const overlay = document.createElement('div');
      overlay.id = 'overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.02);pointer-events:none';
      document.body.appendChild(overlay);
    });
    const p1Box = await page.evaluate(() => {
      const r = document.querySelector('#p1').getBoundingClientRect();
      return { x: r.left, y: r.top };
    });
    await page.mouse.click(p1Box.x + 60, p1Box.y + 12, { clickCount: 2 });
    await sleep(600);
    const triggerInfo = await page.evaluate(() => {
      const host = document.querySelector('.dst-ui');
      if (!host) return { shown: false, onTop: false };
      const btn = host.shadowRoot.querySelector('.trigger');
      const r = btn.getBoundingClientRect();
      const overlay = document.getElementById('overlay');
      overlay.style.pointerEvents = 'auto'; // 还原真实站点浮层可点击的情况，验证绘制顺序
      const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      overlay.style.pointerEvents = 'none';
      return {
        shown: btn.classList.contains('show'),
        onTop: top === host,
        topId: top ? top.id || top.className : '',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      };
    });
    check('站点 stopPropagation 掉 mouseup 时仍弹出划词按钮', triggerInfo.shown);
    check('划词按钮盖在站点高 z-index 浮层之上', triggerInfo.onTop, `命中 ${triggerInfo.topId}`);
    if (triggerInfo.rect) {
      await page.mouse.click(triggerInfo.rect.x + triggerInfo.rect.w / 2, triggerInfo.rect.y + triggerInfo.rect.h / 2);
    }
    const btnCardOk = await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-result')?.textContent || '').includes('译文')
    );
    check('点击划词按钮弹出译文卡片', btnCardOk);
    await page.screenshot({ path: path.join(SHOT_DIR, '5b-selection-button.png') });

    /* --- 6c. 输入框内选中文本 --- */
    await page.evaluate(() => {
      document.getElementById('overlay')?.remove();
      getSelection().removeAllRanges();
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const input = document.createElement('input');
      input.id = 'probe';
      input.value = 'Selection inside a text field should work too.';
      input.style.cssText = 'width:400px;font-size:16px';
      document.body.appendChild(input);
      input.focus();
      input.setSelectionRange(0, 20);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await sleep(500);
    const inputSel = await page.evaluate(() => {
      const host = document.querySelector('.dst-ui');
      return host ? host.shadowRoot.querySelector('.trigger').classList.contains('show') : false;
    });
    check('输入框内选中文本也能划词', inputSel);

    /* --- 6d. iframe 内划词 --- */
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'inner';
      frame.src = location.href;
      frame.style.cssText = 'width:640px;height:220px;border:1px solid #ccc';
      document.body.appendChild(frame);
    });
    await sleep(2000);
    const inner = page.frames().find((f) => f !== page.mainFrame());
    let frameSel = false;
    if (inner) {
      await inner.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#tail'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      await sleep(600);
      frameSel = await inner.evaluate(
        () => document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.trigger')?.classList.contains('show') || false
      );
    }
    check('iframe 内选中文本也能划词', frameSel);
    // tabs.sendMessage 会广播到所有框架，子框架抢答会让弹窗读到错误状态
    const stateWithFrame = await worker.evaluate(async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(t.id, { type: 'GET_PAGE_STATE' });
    });
    check(
      '有 iframe 时页面状态仍由顶层框架回应',
      Boolean(stateWithFrame?.ok) && stateWithFrame.state?.active === false,
      JSON.stringify(stateWithFrame?.state)
    );
    await page.evaluate(() => {
      document.getElementById('inner')?.remove();
      document.getElementById('probe')?.remove();
    });

    /* --- 6e. 选中的本来就是中文时，自动改译成英文（中英互译） --- */
    await applySettings(worker, { selectionTrigger: 'instant', targetLang: '简体中文' });
    await sleep(400); // 内容脚本靠 storage.onChanged 更新设置
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#cn'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const zhToEn = await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-lang')?.textContent || '').includes('English')
    );
    const zhCard = await page.evaluate(() => {
      const root = document.querySelector('.dst-ui').shadowRoot;
      return {
        lang: root.querySelector('.card-lang')?.textContent || '',
        result: root.querySelector('.card-result')?.textContent || ''
      };
    });
    check('划词选中中文时自动译成英文', zhToEn, `${zhCard.lang} → ${zhCard.result.slice(0, 24)}`);

    // 选中英文时仍按目标语言（简体中文）翻译
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#tail'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const enToZh = await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-lang')?.textContent || '').includes('简体中文')
    );
    check('划词选中英文时译成中文', enToZh);
    await page.screenshot({ path: path.join(SHOT_DIR, '5c-selection-lang.png') });

    /* --- 7. 接口报错时透传真实错误（换模型名以绕开缓存，确保真的走接口） --- */
    await applySettings(worker, { model: 'mock-model-uncached' }, 'bad-key');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const errOk = await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent || '').includes('401')
    );
    const errText = await page.evaluate(
      () => document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent?.replace(/\s+/g, ' ').trim() || ''
    );
    check('接口错误透传原始信息', errOk, errText.slice(0, 120));
    await page.screenshot({ path: path.join(SHOT_DIR, '6-error.png') });

    /* --- 8. 设置页与弹窗渲染 --- */
    const extId = new URL(swTarget.url()).host;
    const optionsPage = await browser.newPage();
    optionsPage.on('pageerror', (err) => pageErrors.push(`设置页: ${err}`));
    optionsPage.on('console', (msg) => {
      // 检查更新那组用例会**故意**打出 404（测"仓库没发过 Release"），
      // Chrome 会把它当成资源加载失败记进控制台。扩展本身已经接住并给了友好提示，
      // 不该算作"页面有报错"，否则这条断言永远红。
      // 出错的 URL 在 location() 里，text() 只有一句 "Failed to load resource: ... 404"
      const url = msg.location()?.url || '';
      const deliberate404 = msg.text().includes('404') && url.includes('/releases/latest');
      if (msg.type() === 'error' && !deliberate404) pageErrors.push(`设置页: ${msg.text()}`);
    });
    await optionsPage.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'networkidle2' });
    await sleep(600);
    const optionsInfo = await optionsPage.evaluate(() => {
      const first = document.querySelector('.provider');
      return {
        count: document.querySelectorAll('.provider').length,
        keyHelp: first.querySelector('.p-keyhelp').textContent,
        keyType: first.querySelector('.p-key').type,
        cache: document.getElementById('cacheInfo').textContent,
        baseUrl: first.querySelector('.p-baseUrl').value,
        expanded: !first.querySelector('.provider-body').hidden,
        badge: !first.querySelector('.p-badge').hidden
      };
    });
    check('设置页密钥脱敏显示', /••/.test(optionsInfo.keyHelp), optionsInfo.keyHelp);
    check('设置页密钥输入为 password', optionsInfo.keyType === 'password');
    check('设置页读取缓存条目', /缓存条目：\d/.test(optionsInfo.cache), optionsInfo.cache);
    check('启用中的接口默认展开并标注', optionsInfo.expanded && optionsInfo.badge, `共 ${optionsInfo.count} 个接口`);
    await optionsPage.screenshot({ path: path.join(SHOT_DIR, '7-options.png'), fullPage: true });

    const popupPage = await browser.newPage();
    await popupPage.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'networkidle2' });
    await sleep(500);
    await popupPage.setViewport({ width: 380, height: 700 });
    check('弹窗页面可渲染', true);

    /* --- 9. 弹窗内的快速翻译小窗 --- */
    await applySettings(worker, { model: 'deepseek-chat' }, 'sk-mock-key-123456');
    await popupPage.reload({ waitUntil: 'networkidle2' });
    await sleep(500);
    const quickInitial = await popupPage.evaluate(() => ({
      hasLabel: document.querySelector('label[for="quickInput"]')?.textContent.trim(),
      btnDisabled: document.getElementById('quickBtn').disabled,
      resultHidden: document.getElementById('quickResult').hidden
    }));
    check('快速翻译有可见 label', quickInitial.hasLabel === '快速翻译', quickInitial.hasLabel);
    check('输入为空时翻译按钮禁用', quickInitial.btnDisabled && quickInitial.resultHidden);

    await popupPage.click('#quickInput');
    await popupPage.type('#quickInput', 'Good morning.\nHow are you today?');
    await popupPage.click('#quickBtn');
    const quickOk = await waitFor(
      popupPage,
      () => !document.getElementById('quickResult').hidden && document.getElementById('quickOutput').textContent.includes('译文')
    );
    const quickInfo = await popupPage.evaluate(() => ({
      output: document.getElementById('quickOutput').textContent,
      lang: document.getElementById('quickResultLang').textContent,
      count: document.getElementById('quickCount').textContent,
      btnLabel: document.getElementById('quickBtnLabel').textContent,
      busy: document.getElementById('quickBtn').disabled,
      errorHidden: document.getElementById('quickError').hidden
    }));
    check('快速翻译返回译文', quickOk, quickInfo.output.replace(/\n/g, ' | ').slice(0, 60));
    check('多行输入按行分别翻译', quickInfo.output.split('\n').length === 2, `行数 ${quickInfo.output.split('\n').length}`);
    check('译文区标注目标语言', /译文 · .+/.test(quickInfo.lang), quickInfo.lang);
    check('翻译结束后按钮恢复可用', quickInfo.btnLabel === '翻译' && !quickInfo.busy && quickInfo.errorHidden);
    check('输入框显示字数', /\d+ \/ 5000/.test(quickInfo.count), quickInfo.count);
    // hidden 属性必须真的把元素收起来（作者样式的 display 会盖掉 UA 的 [hidden]）
    const alertInfo = await popupPage.evaluate(() => ({
      hidden: document.getElementById('alert').hidden,
      alertHeight: document.getElementById('alert').getBoundingClientRect().height,
      errorHeight: document.getElementById('quickError').getBoundingClientRect().height
    }));
    check(
      '隐藏的提示条与行内错误不占位',
      alertInfo.hidden && alertInfo.alertHeight === 0 && alertInfo.errorHeight === 0,
      `alert=${alertInfo.alertHeight}px error=${alertInfo.errorHeight}px`
    );
    await popupPage.screenshot({ path: path.join(SHOT_DIR, '9-popup-quick.png') });

    // 中文输入在「自动」模式下应译成英文而不是原样返回
    await popupPage.evaluate(() => {
      document.getElementById('quickInput').value = '';
      document.getElementById('quickInput').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await popupPage.type('#quickInput', '今天天气很好。');
    await popupPage.click('#quickBtn');
    await waitFor(popupPage, () => document.getElementById('quickResultLang').textContent.includes('English'));
    const autoLang = await popupPage.evaluate(() => ({
      lang: document.getElementById('quickResultLang').textContent,
      options: Array.from(document.querySelectorAll('#quickTarget option')).map((o) => o.textContent)
    }));
    check('快速翻译中文输入自动译成英文', autoLang.lang.includes('English'), autoLang.lang);
    check(
      '目标语言可选自动中英互译或跟随设置',
      autoLang.options[0].includes('中 ⇄ 英') && /跟随设置（.+）/.test(autoLang.options[1]),
      autoLang.options.slice(0, 2).join(' / ')
    );

    // 没有密钥时给出行内错误 + 去设置入口
    await applySettings(worker, {}, '');
    await popupPage.reload({ waitUntil: 'networkidle2' });
    await sleep(400);
    await popupPage.evaluate(() => {
      const input = document.getElementById('quickInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await popupPage.click('#quickInput');
    await popupPage.type('#quickInput', 'hello');
    await popupPage.click('#quickBtn');
    await sleep(600);
    const quickErr = await popupPage.evaluate(() => ({
      hidden: document.getElementById('quickError').hidden,
      text: document.getElementById('quickErrorText').textContent,
      action: !document.getElementById('quickErrorAction').hidden
    }));
    check('未配置密钥时快速翻译给出行内错误', !quickErr.hidden && quickErr.action, quickErr.text);
    await popupPage.screenshot({ path: path.join(SHOT_DIR, '10-popup-quick-error.png') });

    /* --- 10. 多接口：新增、互斥启用、密钥各自独立 --- */
    await applySettings(worker, {}, 'sk-mock-key-123456');
    await optionsPage.bringToFront();
    await optionsPage.reload({ waitUntil: 'networkidle2' });
    await sleep(500);

    // 用「自定义」预设加一个接口 B，地址指向一个没人监听的端口，方便验证它是否真的被使用
    await optionsPage.select('#presetSelect', 'custom');
    // 用 DOM 触发点击：底部固定保存栏可能盖住按钮，鼠标点击会落到保存栏上
    await optionsPage.evaluate(() => document.getElementById('addProvider').click());
    await sleep(200);
    const added = await optionsPage.evaluate(() => ({
      count: document.querySelectorAll('.provider').length,
      // 新加的那个要自动展开，其余保持折叠
      bodies: Array.from(document.querySelectorAll('.provider-body')).map((b) => !b.hidden)
    }));
    check('可添加第二个接口并自动展开', added.count === 2 && added.bodies[1] === true, `展开状态 ${added.bodies}`);
    await optionsPage.evaluate(() => {
      const li = document.querySelectorAll('.provider')[1];
      const set = (sel, value) => {
        const input = li.querySelector(sel);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('.p-name', '备用接口');
      set('.p-baseUrl', 'http://127.0.0.1:9');
      set('.p-model', 'backup-model');
      set('.p-key', 'sk-backup-key-000');
      li.querySelector('.p-active').click(); // 启用 B
    });
    const exclusive = await optionsPage.evaluate(() => ({
      checked: Array.from(document.querySelectorAll('.p-active')).map((r) => r.checked),
      badges: Array.from(document.querySelectorAll('.p-badge')).map((b) => !b.hidden),
      names: Array.from(document.querySelectorAll('.p-name-text')).map((n) => n.textContent)
    }));
    check(
      '启用状态互斥（同时只有一个被选中）',
      exclusive.checked.filter(Boolean).length === 1 && exclusive.checked[1] === true,
      `checked=${exclusive.checked} 徽标=${exclusive.badges} 名称=${exclusive.names.join(' / ')}`
    );
    // 候选模型必须跟着 API 地址走：选了 A 家不该冒出 B 家的模型（填了也是 404）
    const modelOptions = await optionsPage.evaluate(async () => {
      const li = document.querySelectorAll('.provider')[1];
      const baseUrl = li.querySelector('.p-baseUrl');
      const setUrl = (value) => {
        baseUrl.value = value;
        baseUrl.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const listOf = (el) => Array.from(el.querySelectorAll('option')).map((o) => o.value);
      const explainList = () => listOf(document.getElementById('explainModels'));
      const rowList = () => listOf(li.querySelector('.p-models'));

      const select = document.getElementById('explainProvider');
      select.value = li.dataset.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));

      setUrl('https://api.openai.com/v1');
      const openai = { row: rowList(), explain: explainList() };
      setUrl('https://api.deepseek.com');
      const deepseek = { row: rowList(), explain: explainList() };
      setUrl('https://dashscope.aliyuncs.com/compatible-mode/v1');
      const dashscope = { row: rowList(), explain: explainList() };
      setUrl('http://127.0.0.1:9'); // 认不出的自定义地址：不瞎猜，留空让用户自己填
      const unknown = { row: rowList(), explain: explainList() };

      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { openai, deepseek, dashscope, unknown };
    });
    check(
      '翻译模型候选跟随该接口的 API 地址',
      modelOptions.openai.row.includes('gpt-4o-mini') &&
        !modelOptions.openai.row.includes('deepseek-chat') &&
        modelOptions.deepseek.row.includes('deepseek-chat') &&
        !modelOptions.deepseek.row.includes('gpt-4o-mini'),
      `openai=${modelOptions.openai.row} deepseek=${modelOptions.deepseek.row}`
    );
    check(
      '详解模型候选跟随所选接口，且不列翻译专用模型',
      modelOptions.deepseek.explain.includes('deepseek-chat') &&
        !modelOptions.deepseek.explain.includes('gpt-4o-mini') &&
        modelOptions.dashscope.explain.includes('qwen-plus') &&
        !modelOptions.dashscope.explain.includes('qwen-mt-turbo') &&
        modelOptions.dashscope.row.includes('qwen-mt-turbo'), // 翻译那栏仍可选 MT
      `deepseek=${modelOptions.deepseek.explain} dashscope=${modelOptions.dashscope.explain}`
    );
    check(
      '地址认不出时不给候选模型',
      modelOptions.unknown.row.length === 0 && modelOptions.unknown.explain.length === 0,
      `row=${modelOptions.unknown.row} explain=${modelOptions.unknown.explain}`
    );

    await optionsPage.screenshot({ path: path.join(SHOT_DIR, '11-options-providers.png'), fullPage: true });

    await optionsPage.click('#saveBtn');
    await sleep(800);
    const stored = await worker.evaluate(async () => {
      const s = (await chrome.storage.sync.get('settings')).settings;
      const keys = (await chrome.storage.local.get('apiKeys')).apiKeys || {};
      return {
        count: s.providers.length,
        active: s.activeProviderId,
        urls: s.providers.map((p) => p.baseUrl),
        keyIds: Object.keys(keys).sort(),
        flatBaseUrl: s.baseUrl
      };
    });
    check('保存后存在两个接口且启用的是新接口', stored.count === 2 && stored.active !== 'deepseek', JSON.stringify(stored.urls));
    check('每个接口各自保存密钥', stored.keyIds.length === 2, stored.keyIds.join(', '));
    check('不再保留旧版平铺的接口字段', stored.flatBaseUrl === undefined, String(stored.flatBaseUrl));

    // 翻译必须走"启用中"的那个接口：B 指向死端口，应当报网络错误
    await page.bringToFront();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const usedBackup = await waitFor(page, () =>
      /网络请求失败|连接失败|fetch/i.test(document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent || '')
    );
    const backupErr = await page.evaluate(
      () => document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent?.replace(/\s+/g, ' ').trim() || ''
    );
    check('翻译走的是启用中的接口', usedBackup, backupErr.slice(0, 80));
    await toggle(worker);

    // 用弹窗的下拉切回接口 A，翻译应恢复正常
    await popupPage.bringToFront();
    await popupPage.reload({ waitUntil: 'networkidle2' });
    await sleep(500);
    const optionCount = await popupPage.evaluate(() => document.querySelectorAll('#providerSelect option').length);
    await popupPage.select('#providerSelect', 'deepseek');
    await sleep(600);
    const switched = await worker.evaluate(async () => (await chrome.storage.sync.get('settings')).settings.activeProviderId);
    check('弹窗可切换启用的接口', optionCount === 2 && switched === 'deepseek', `选项 ${optionCount} 个，当前 ${switched}`);
    await popupPage.screenshot({ path: path.join(SHOT_DIR, '12-popup-provider.png') });

    await page.bringToFront();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const backToA = await waitFor(page, () => document.querySelectorAll('dst-trans').length >= 5);
    check('切回原接口后翻译恢复正常', backToA);
    await toggle(worker);

    /* --- 11. 翻译专用模型（qwen-mt）走独立调用方式 --- */
    await optionsPage.evaluate(async () => chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' }));
    await applySettings(worker, { model: 'qwen-mt-turbo', targetLang: '简体中文' }, 'sk-mock-key-123456');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const mtOk = await waitFor(page, () => document.querySelectorAll('dst-trans').length >= 5);
    const mtInfo = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('dst-trans')).map((n) => n.textContent);
      return {
        sample: nodes[0] || '',
        allMt: nodes.every((t) => t.startsWith('【MT:')),
        withSystem: nodes.some((t) => t.includes('+SYS')),
        withSeg: nodes.some((t) => /<seg|&lt;seg/i.test(t)),
        hud: document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent || ''
      };
    });
    check('翻译专用模型可正常整页翻译', mtOk && mtInfo.allMt, mtInfo.sample.slice(0, 46));
    check('未把目标语言写成 system 提示词', !mtInfo.withSystem);
    check('未使用 <seg> 分段协议（逐条发送）', !mtInfo.withSeg);
    check('目标语言按 qwen-mt 语言名传递', mtInfo.sample.startsWith('【MT:Chinese】'), mtInfo.sample.slice(0, 20));
    await page.screenshot({ path: path.join(SHOT_DIR, '13-qwen-mt.png') });
    await toggle(worker);

    // 设置页对该模型给出提示，且测试请求也走同一套调用方式
    await optionsPage.bringToFront();
    await optionsPage.reload({ waitUntil: 'networkidle2' });
    await sleep(500);
    const mtNote = await optionsPage.evaluate(() => ({
      note: !document.querySelector('.p-mtnote').hidden,
      // temperature 对该类模型无效，不该继续显示
      temperature: document.querySelector('.p-temperature').closest('.field').getBoundingClientRect().height
    }));
    check('设置页对翻译专用模型给出说明并隐藏无效字段', mtNote.note && mtNote.temperature === 0, `温度字段高 ${mtNote.temperature}`);
    await optionsPage.evaluate(() => document.querySelector('.p-test').click());
    const mtTestOk = await waitFor(optionsPage, () =>
      /连接成功/.test(document.querySelector('.p-testresult')?.textContent || '')
    );
    const mtTestText = await optionsPage.evaluate(() => document.querySelector('.p-testresult').textContent);
    check('翻译专用模型的测试请求可通过', mtTestOk, mtTestText.slice(0, 70));

    /* --- 12. 旧版单接口配置能平滑迁移 --- */
    // 先清缓存，否则译文可能直接命中缓存，测不出接口地址有没有真的迁移过来
    // Service Worker 收不到自己发的消息，借设置页这个普通页面发
    await optionsPage.evaluate(async () => chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' }));
    await worker.evaluate(async () => {
      await chrome.storage.sync.set({
        settings: { baseUrl: 'http://127.0.0.1:8787', model: 'legacy-model', displayMode: 'inline', selectionEnabled: true }
      });
      await chrome.storage.local.remove('apiKeys');
      await chrome.storage.local.set({ apiKey: 'sk-legacy-key-999' });
    });
    const migrated = await worker.evaluate(async () => {
      const s = globalThis.DST.normalizeSettings((await chrome.storage.sync.get('settings')).settings);
      const key = await globalThis.DST.loadApiKey(s.activeProviderId);
      return { count: s.providers.length, model: s.providers[0].model, active: s.activeProviderId, hasKey: Boolean(key) };
    });
    check(
      '旧版单接口配置迁移为默认接口',
      migrated.count === 1 && migrated.model === 'legacy-model' && migrated.active === 'deepseek' && migrated.hasKey,
      JSON.stringify(migrated)
    );
    await page.bringToFront(); // toggle 走的是"当前活动标签页"，前面切到设置页了
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const legacyWorks = await waitFor(page, () => document.querySelectorAll('dst-trans').length >= 5);
    check('旧版配置无需重设即可继续翻译', legacyWorks);
    await toggle(worker);

    /* --- 13. 音标 / 朗读 / 生词本 --- */
    await useMockDictionary(worker, PORT);
    await applySettings(
      worker,
      {
        baseUrl: `http://127.0.0.1:${PORT}`,
        model: 'mock-model-uncached',
        selectionEnabled: true,
        selectionTrigger: 'instant',
        dictEnabled: true,
        speechAccent: 'us',
        vocabSaveContext: true
      },
      'sk-mock-key-123456'
    );
    await askBackground(optionsPage, { type: 'VOCAB_CLEAR' });
    await page.bringToFront();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(600);

    const selectNode = (id) =>
      page.evaluate((sel) => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector(sel));
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, id);

    await selectNode('#word');
    await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-result')?.textContent || '').includes('译文')
    );
    const phonOk = await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-phonetic')?.textContent || '').includes('-us')
    );
    const cardPron = await page.evaluate(() => {
      const root = document.querySelector('.dst-ui').shadowRoot;
      return {
        phonetic: root.querySelector('.card-phonetic')?.textContent || '',
        hasSpeak: Boolean(root.querySelector('[data-act="speak"]')),
        saveLabel: root.querySelector('.save-btn')?.textContent?.trim() || ''
      };
    });
    check('划词卡片按美式口音选音标', phonOk, cardPron.phonetic);
    check('划词卡片提供朗读按钮', cardPron.hasSpeak);
    check('划词卡片提供加入生词本按钮', cardPron.saveLabel.includes('加入生词本'), cardPron.saveLabel);

    /* --- 13b. 词典详解 --- */
    // 单词属于"短内容"，auto 模式下应该不用点按钮就自动出详解
    const explainShown = await waitFor(page, () =>
      Boolean(document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-explain .ex'))
    );
    const explainCard = await page.evaluate(() => {
      const root = document.querySelector('.dst-ui').shadowRoot;
      const q = (sel) => root.querySelector(sel)?.textContent?.trim() || '';
      return {
        summary: q('.ex-summary'),
        pos: q('.ex-senses li .ex-pos'),
        senses: root.querySelectorAll('.ex-senses li').length,
        exampleSrc: q('.ex-examples li .ex-src'),
        exampleTrans: q('.ex-examples li .ex-trans'),
        notes: q('.ex-notes'),
        related: root.querySelectorAll('.ex-tag').length,
        // 自动查过了就不该再显示手动按钮
        hasButton: Boolean(root.querySelector('.card-foot [data-act="explain"]'))
      };
    });
    check('划词单词自动给出词典详解', explainShown && explainCard.summary.includes('pronunciation'), explainCard.summary);
    check('详解按词性分条列出释义', explainCard.senses === 2 && explainCard.pos === 'n.', `${explainCard.senses} 条 / ${explainCard.pos}`);
    check(
      '详解给出双语例句',
      explainCard.exampleSrc.includes('pronunciation') && explainCard.exampleTrans.includes('例句'),
      `${explainCard.exampleSrc} | ${explainCard.exampleTrans}`
    );
    check('详解给出用法提示与相关词', Boolean(explainCard.notes) && explainCard.related > 0, `${explainCard.notes} / ${explainCard.related} 个`);
    check('自动详解后不再重复显示「详细解释」按钮', !explainCard.hasButton);
    await page.screenshot({ path: path.join(SHOT_DIR, '15-selection-phonetic.png') });

    // 整段话不自动详解（省额度），但要留一个手动入口，点了才查
    await selectNode('#p1');
    // 上一张卡片的译文里也有"译文"二字，只等这两个字会打在旧卡片上，
    // 必须等到内容真的换成 #p1 的译文为止
    await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-result')?.textContent || '').includes(
        'Large language models'
      )
    );
    const longSel = await page.evaluate(() => {
      const root = document.querySelector('.dst-ui').shadowRoot;
      return {
        auto: Boolean(root.querySelector('.card-explain .ex')),
        button: root.querySelector('.card-foot [data-act="explain"]')?.textContent?.trim() || ''
      };
    });
    check('长句不自动发起详解', !longSel.auto);
    check('长句提供「详细解释」按钮', longSel.button.includes('详细解释'), longSel.button);

    await page.evaluate(() => document.querySelector('.dst-ui').shadowRoot.querySelector('[data-act="explain"]').click());
    const manualExplain = await waitFor(page, () =>
      Boolean(document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-explain .ex'))
    );
    const afterManual = await page.evaluate(() =>
      Boolean(document.querySelector('.dst-ui').shadowRoot.querySelector('.card-foot [data-act="explain"]'))
    );
    check('点「详细解释」后出详解', manualExplain);
    check('详解出来后按钮收起', !afterManual);
    await page.screenshot({ path: path.join(SHOT_DIR, '19-selection-explain.png') });

    // 后台层面：同一个词第二次应命中缓存，不重复计费
    const explain1 = await askBackground(optionsPage, { type: 'EXPLAIN', text: 'threshold' });
    const explain2 = await askBackground(optionsPage, { type: 'EXPLAIN', text: 'threshold' });
    check('详解返回结构化结果', explain1?.ok && explain1.explain?.senses?.length > 0, JSON.stringify(explain1?.explain?.summary || ''));
    check('详解剥掉模型返回的 ``` 代码围栏', explain1?.ok === true && !JSON.stringify(explain1.explain).includes('```'));
    check('同一个词的详解命中本地缓存', explain2?.cached === true, `cached=${explain2?.cached}`);

    // 模型没按格式返回时，要给出能看懂的原因而不是空白
    const badExplain = await askBackground(optionsPage, { type: 'EXPLAIN', text: 'explainfail now' });
    check(
      '模型不按格式返回时给出明确错误',
      badExplain?.ok === false && badExplain.code === 'BAD_EXPLAIN',
      `${badExplain?.code} ${badExplain?.error || ''}`
    );

    // 超长内容不给详解（词典式解释对整篇文章没有意义）
    const tooLongExplain = await askBackground(optionsPage, { type: 'EXPLAIN', text: 'x'.repeat(500) });
    check(
      '超长内容拒绝详解并说明原因',
      tooLongExplain?.ok === false && tooLongExplain.code === 'NOT_EXPLAINABLE',
      tooLongExplain?.error || ''
    );

    // 翻译专用模型出不了详解，要明确告诉用户去指一个通用模型，而不是回一句翻译
    await applySettings(worker, { model: 'qwen-mt-turbo' });
    const mtExplain = await askBackground(optionsPage, { type: 'EXPLAIN', text: 'threshold-mt' });
    check(
      'qwen-mt 模型详解时提示改用通用模型',
      mtExplain?.ok === false && mtExplain.code === 'MT_UNSUPPORTED' && /详解使用的模型/.test(mtExplain.error || ''),
      mtExplain?.error || ''
    );

    // 翻译留在 qwen-mt，详解单独指到通用模型的接口上，两边应各走各的
    await worker.evaluate(async (port) => {
      const s = (await chrome.storage.sync.get('settings')).settings;
      s.providers = [
        { id: 'deepseek', name: '翻译接口', baseUrl: `http://127.0.0.1:${port}`, model: 'qwen-mt-turbo', temperature: 1.3, timeout: 60000 },
        { id: 'general', name: '通用接口', baseUrl: `http://127.0.0.1:${port}`, model: 'mock-model-uncached', temperature: 1.3, timeout: 60000 }
      ];
      s.activeProviderId = 'deepseek';
      s.explainProviderId = 'general';
      await chrome.storage.sync.set({ settings: s });
      const keys = (await chrome.storage.local.get('apiKeys')).apiKeys || {};
      await chrome.storage.local.set({ apiKeys: { ...keys, general: 'sk-mock-key-123456' } });
    }, PORT);
    const splitExplain = await askBackground(optionsPage, { type: 'EXPLAIN', text: 'split-provider' });
    const splitTranslate = await askBackground(optionsPage, { type: 'TRANSLATE', texts: ['Hello there'], targetLang: '简体中文' });
    check(
      '详解可单独指到通用模型接口（翻译仍走 qwen-mt）',
      splitExplain?.ok === true && Boolean(splitExplain.explain?.senses?.length),
      splitExplain?.error || splitExplain?.explain?.summary || ''
    );
    check(
      '分开配置后翻译仍走翻译专用模型',
      splitTranslate?.ok === true && /^【MT:/.test(splitTranslate.results?.[0] || ''),
      splitTranslate?.results?.[0] || splitTranslate?.error || ''
    );

    // 删掉被详解指着的接口后，应回落到「跟随翻译接口」而不是一直报错
    const fallback = await worker.evaluate(async () => {
      const s = (await chrome.storage.sync.get('settings')).settings;
      s.providers = s.providers.filter((p) => p.id !== 'general');
      await chrome.storage.sync.set({ settings: s });
      const normalized = globalThis.DST.normalizeSettings((await chrome.storage.sync.get('settings')).settings);
      return { explainProviderId: normalized.explainProviderId, resolved: globalThis.DST.explainProvider(normalized).id };
    });
    check(
      '详解接口被删后回落到翻译接口',
      fallback.explainProviderId === '' && fallback.resolved === 'deepseek',
      JSON.stringify(fallback)
    );

    // 最常见的搭配：只配一个接口（同地址同密钥），靠「详解使用的模型」把详解切到通用模型
    await worker.evaluate(async () => {
      const s = (await chrome.storage.sync.get('settings')).settings;
      s.explainProviderId = '';
      s.explainModel = 'mock-model-uncached'; // 接口本身仍是 qwen-mt-turbo
      await chrome.storage.sync.set({ settings: s });
    });
    const sameProvider = await askBackground(optionsPage, { type: 'EXPLAIN', text: 'model-override' });
    const sameProviderTranslate = await askBackground(optionsPage, {
      type: 'TRANSLATE',
      texts: ['Model override check'],
      targetLang: '简体中文'
    });
    check(
      '同一接口下用「详解模型」把详解切到通用模型',
      sameProvider?.ok === true && Boolean(sameProvider.explain?.senses?.length),
      sameProvider?.error || sameProvider?.explain?.summary || ''
    );
    check(
      '填了详解模型后翻译仍用接口自己的翻译模型',
      sameProviderTranslate?.ok === true && /^【MT:/.test(sameProviderTranslate.results?.[0] || ''),
      sameProviderTranslate?.results?.[0] || sameProviderTranslate?.error || ''
    );
    const resolvedModels = await worker.evaluate(async () => {
      const s = globalThis.DST.normalizeSettings((await chrome.storage.sync.get('settings')).settings);
      return { translate: globalThis.DST.activeProvider(s).model, explain: globalThis.DST.explainProvider(s).model };
    });
    check(
      '翻译与详解解析到两个不同模型',
      resolvedModels.translate === 'qwen-mt-turbo' && resolvedModels.explain === 'mock-model-uncached',
      JSON.stringify(resolvedModels)
    );
    await worker.evaluate(async () => {
      const s = (await chrome.storage.sync.get('settings')).settings;
      s.explainModel = '';
      await chrome.storage.sync.set({ settings: s });
    });

    await applySettings(worker, { model: 'mock-model-uncached', explainProviderId: '' }, 'sk-mock-key-123456');

    // 关掉详解后，卡片里既不该自动查，也不该出现入口
    await applySettings(worker, { explainMode: 'off' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(600);
    await selectNode('#word');
    await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-result')?.textContent || '').includes('译文')
    );
    await sleep(800); // 给"万一发起了详解"留出回来的时间，否则测不出真关掉了
    const offState = await page.evaluate(() => {
      const root = document.querySelector('.dst-ui').shadowRoot;
      return {
        explain: Boolean(root.querySelector('.card-explain .ex')),
        button: Boolean(root.querySelector('.card-foot [data-act="explain"]'))
      };
    });
    check('关闭详解后不自动查也不显示入口', !offState.explain && !offState.button, JSON.stringify(offState));

    // 恢复现场：后面的朗读 / 生词本用例接着用这张 #word 的卡片
    await applySettings(worker, { explainMode: 'auto' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(600);
    await selectNode('#word');
    await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-result')?.textContent || '').includes('译文')
    );
    await waitFor(page, () => Boolean(document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-explain .ex')));

    // 朗读：真人音频播不出来也要回落到语音合成，按钮不能报错
    const speakRes = await askBackground(optionsPage, {
      type: 'SPEAK',
      text: 'pronunciation',
      audioUrl: `http://127.0.0.1:${PORT}/audio/pronunciation-us.wav`
    });
    check('朗读请求成功返回', Boolean(speakRes?.ok), `via=${speakRes?.via || ''} ${speakRes?.error || ''}`);
    check('默认音源优先用有道', speakRes?.via === 'audio:有道', speakRes?.via);

    // dictionaryapi 的音频节点常年 502，必须能自动回落到有道，否则等于没有发音
    const fallbackRes = await askBackground(optionsPage, {
      type: 'SPEAK',
      text: 'pronunciation',
      audioUrl: `http://127.0.0.1:${PORT}/audio/pronunciation-502.wav`
    });
    check('dictionaryapi 音频 502 时仍能发音', fallbackRes?.ok === true, `via=${fallbackRes?.via} ${fallbackRes?.error || ''}`);

    // 只用 dictionaryapi 且它 502 → 没有真人发音，这台机器又没有语音包，应给出两头都说清楚的错误
    await applySettings(worker, { audioSource: 'dict' });
    const dictOnly = await askBackground(optionsPage, {
      type: 'SPEAK',
      text: 'pronunciation',
      audioUrl: `http://127.0.0.1:${PORT}/audio/pronunciation-502.wav`
    });
    check(
      '音源全挂时错误里同时说明在线与本地两头的原因',
      dictOnly?.ok === false && /在线发音失败/.test(dictOnly.error || '') && /语音/.test(dictOnly.error || ''),
      (dictOnly?.error || '').slice(0, 90)
    );

    // 关掉联网音源后不应再发起任何音频请求，只走系统语音
    await applySettings(worker, { audioSource: 'none' });
    const offline = await askBackground(optionsPage, { type: 'SPEAK', text: 'pronunciation' });
    check(
      '选择"不联网"时不再尝试在线音源',
      offline?.ok === false && !/在线发音失败/.test(offline.error || ''),
      (offline?.error || '').slice(0, 60)
    );

    // 整句 / 中文有道读不了（词典录音只认词条），要接力给百度那条合成
    await applySettings(worker, { audioSource: 'auto' });
    const sentence = 'Large language models are changing how people read the web.';
    const sentenceRes = await askBackground(optionsPage, { type: 'SPEAK', text: sentence });
    check('整句朗读走百度语音合成', sentenceRes?.ok === true && sentenceRes.via === 'audio:百度', `via=${sentenceRes?.via} ${sentenceRes?.error || ''}`);

    const zhRes = await askBackground(optionsPage, { type: 'SPEAK', text: '大语言模型正在改变人们浏览网页的方式。' });
    check('中文整句也能朗读', zhRes?.ok === true && zhRes.via === 'audio:百度', `via=${zhRes?.via} ${zhRes?.error || ''}`);

    const jaRes = await askBackground(optionsPage, { type: 'SPEAK', text: 'こんにちは世界' });
    check('日文按日语嗓音朗读而不是当成中文', jaRes?.ok === true, `via=${jaRes?.via} ${jaRes?.error || ''}`);
    const jaLang = await optionsPage.evaluate(() => globalThis.DST.detectSpeechLang('こんにちは世界', 'us'));
    check('日文语种识别正确', jaLang.bcp47 === 'ja-JP' && jaLang.baidu === 'jp', JSON.stringify(jaLang));

    // 单词仍然优先用有道的真人录音，别被百度合成抢走
    const wordRes = await askBackground(optionsPage, { type: 'SPEAK', text: 'threshold' });
    check('单词仍优先用有道真人录音', wordRes?.via === 'audio:有道', wordRes?.via);

    // 超过 1000 字不发在线请求，错误里要点明是长度问题
    const tooLong = 'word '.repeat(300);
    const longRes = await askBackground(optionsPage, { type: 'SPEAK', text: tooLong });
    check(
      '超长内容说明是长度超限而不是网络问题',
      longRes?.ok === false && /超过在线朗读的 1000 字上限/.test(longRes.error || ''),
      (longRes?.error || '').slice(0, 60)
    );

    const voicesRes = await askBackground(optionsPage, { type: 'TTS_VOICES' });
    check('可以查询系统语音包清单', voicesRes?.ok === true && Array.isArray(voicesRes.voices), `${voicesRes?.voices?.length} 个`);

    // 加入生词本：点按钮 → 后台真的存下来了
    await page.evaluate(() => document.querySelector('.dst-ui').shadowRoot.querySelector('.save-btn').click());
    const savedOk = await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.save-btn')?.textContent || '').includes('已加入')
    );
    const vocabStored = await askBackground(optionsPage, { type: 'VOCAB_LIST', query: {} });
    const entry = vocabStored?.items?.[0];
    check('点击后按钮变为已加入', savedOk);
    check(
      '生词本存下单词、音标与译文',
      vocabStored?.ok && vocabStored.total === 1 && entry.word === 'pronunciation' && entry.phonetic.includes('-us') && entry.translation.includes('译文'),
      entry ? `${entry.word} ${entry.phonetic} ${entry.translation.slice(0, 14)}` : '无'
    );
    check('生词本记录来源页面与原句', Boolean(entry?.sourceUrl) && Boolean(entry?.context), entry?.context?.slice(0, 30));
    check(
      '加入生词本时一并存下词典详解',
      Boolean(entry?.explain?.senses?.length) && Boolean(entry?.explain?.examples?.length),
      entry?.explain?.summary || '无详解'
    );
    check('新加入的词立即可复习', entry?.status === 'new' && entry.due <= Date.now() + 1000);

    // 再点一次应当从生词本移除，按钮状态跟着回退
    await page.evaluate(() => document.querySelector('.dst-ui').shadowRoot.querySelector('.save-btn').click());
    await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.save-btn')?.textContent || '').includes('加入生词本')
    );
    const afterRemove = await askBackground(optionsPage, { type: 'VOCAB_STATS' });
    check('再次点击可从生词本移除', afterRemove?.stats?.total === 0, `剩余 ${afterRemove?.stats?.total}`);

    // 查不到音标的词：不显示音标行内容，也不能报错
    await page.evaluate(() => document.querySelector('.dst-ui').shadowRoot.querySelector('[data-act="close"]').click());
    await selectNode('#noword');
    await waitFor(page, () =>
      (document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-result')?.textContent || '').includes('译文')
    );
    await sleep(600);
    const noPhon = await page.evaluate(
      () => document.querySelector('.dst-ui').shadowRoot.querySelector('.card-phonetic')?.textContent || ''
    );
    check('词典查不到时不显示音标且不报错', noPhon === '', `"${noPhon}"`);

    /* --- 13c. 快速翻译小窗的音标 / 朗读 / 加入生词本 --- */
    await askBackground(optionsPage, { type: 'VOCAB_CLEAR' });
    const quickPage = await browser.newPage();
    const quickErrors = [];
    quickPage.on('pageerror', (err) => quickErrors.push(String(err)));
    await quickPage.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'networkidle2' });
    await sleep(500);
    await quickPage.evaluate(() => {
      const input = document.getElementById('quickInput');
      input.value = 'threshold';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const quickPhonOk = await waitFor(quickPage, () =>
      !document.getElementById('quickPron').hidden &&
      (document.getElementById('quickPhonetic').textContent || '').includes('-us')
    );
    const quickPhon = await quickPage.evaluate(() => ({
      phonetic: document.getElementById('quickPhonetic').textContent,
      speakEnabled: !document.getElementById('quickSpeak').disabled,
      vocabMeta: document.getElementById('vocabMeta').textContent
    }));
    check('快速翻译显示输入单词的音标', quickPhonOk, quickPhon.phonetic);

    // 切成英式应当换成另一条音频和音标，口音设置不能只是个摆设
    await applySettings(worker, { speechAccent: 'uk' });
    const ukLookup = await askBackground(optionsPage, { type: 'DICT_LOOKUP', word: 'threshold' });
    check(
      '切换英式口音后取到英式音标与音频',
      ukLookup?.phonetic?.includes('-uk') && /-uk\.wav$/.test(ukLookup?.audioUrl || ''),
      `${ukLookup?.phonetic} ${ukLookup?.audioUrl}`
    );
    await applySettings(worker, { speechAccent: 'us' });
    check('快速翻译提供朗读按钮', quickPhon.speakEnabled);

    await quickPage.evaluate(() => document.getElementById('quickBtn').click());
    await waitFor(quickPage, () => !document.getElementById('quickResult').hidden);
    await sleep(400);
    await quickPage.evaluate(() => document.getElementById('quickSave').click());
    const quickSavedOk = await waitFor(quickPage, () =>
      (document.getElementById('quickSave').textContent || '').includes('已加入')
    );
    const quickStored = await askBackground(optionsPage, { type: 'VOCAB_LIST', query: {} });
    check('快速翻译可加入生词本', quickSavedOk && quickStored.total === 1, quickStored.items?.[0]?.word || '无');
    check(
      '快速翻译存下的词带音标与译文',
      (quickStored.items?.[0]?.phonetic || '').includes('-us') && (quickStored.items?.[0]?.translation || '').includes('译文'),
      `${quickStored.items?.[0]?.phonetic} ${quickStored.items?.[0]?.translation}`
    );
    // 快速翻译里输入的是单词，同样应该自动带出词典详解
    const quickExplainOk = await waitFor(quickPage, () =>
      Boolean(document.querySelector('#quickExplain .ex')) && document.getElementById('quickExplain').hidden === false
    );
    const quickExplain = await quickPage.evaluate(() => ({
      summary: document.querySelector('#quickExplain .ex-summary')?.textContent || '',
      senses: document.querySelectorAll('#quickExplain .ex-senses li').length,
      example: document.querySelector('#quickExplain .ex-examples .ex-trans')?.textContent || '',
      btnHidden: document.getElementById('quickExplainBtn').hidden
    }));
    check('快速翻译自动给出词典详解', quickExplainOk && quickExplain.senses === 2, `${quickExplain.summary} / ${quickExplain.senses} 条`);
    check('快速翻译详解带例句译文', quickExplain.example.includes('例句'), quickExplain.example);
    check('详解出来后隐藏「详细解释」按钮', quickExplain.btnHidden);
    await quickPage.screenshot({ path: path.join(SHOT_DIR, '18-popup-vocab.png') });
    check('弹窗页面无 JS 报错', quickErrors.length === 0, quickErrors.slice(0, 2).join(' | '));
    await quickPage.close();

    /* --- 13d. 检查更新与一键安装 --- */
    // 把更新接口指到本地假 GitHub，测试不出网
    await worker.evaluate(async (base) => chrome.storage.local.set({ updateApiBase: base }), `http://127.0.0.1:${PORT}`);
    const current = await optionsPage.evaluate(() => chrome.runtime.getManifest().version);

    const setRepoAndCheck = async (repo) => {
      await optionsPage.evaluate((value) => {
        document.getElementById('updateRepo').value = value;
        document.getElementById('checkUpdate').click();
      }, repo);
      await waitFor(optionsPage, () => !document.getElementById('checkUpdate').disabled, 20000);
      return optionsPage.evaluate(() => ({
        result: document.getElementById('updateResult').textContent.trim(),
        boxHidden: document.getElementById('updateBox').hidden,
        version: document.getElementById('updateVersion').textContent.trim(),
        notes: document.getElementById('updateNotes').textContent.trim(),
        link: document.getElementById('updateLink').getAttribute('href') || '',
        checkedAt: document.getElementById('updateCheckedAt').textContent.trim()
      }));
    };

    const newer = await setRepoAndCheck('mock/v99.0.0');
    check(
      '检查更新发现新版本并展示更新说明',
      !newer.boxHidden && newer.version.includes('v99.0.0') && newer.notes.includes('模拟的更新说明'),
      `${newer.version} | ${newer.notes.slice(0, 20)}`
    );
    check('新版本给出 GitHub 链接', /\/releases\/tag\/v99\.0\.0$/.test(newer.link), newer.link);
    check('记录并显示上次检查时间', newer.checkedAt.includes('上次检查'), newer.checkedAt);

    const older = await setRepoAndCheck('mock/v0.0.1');
    check(
      '线上版本不比本地新时提示已是最新',
      older.boxHidden && older.result.includes(`已是最新版本 v${current}`),
      older.result
    );

    const missing = await setRepoAndCheck('norelease/MikeLingo');
    check('仓库没有 Release 时说明原因', missing.result.includes('还没有发布过 Release'), missing.result);

    const noAsset = await setRepoAndCheck('noasset/v99.0.0');
    check('Release 里没有发布包时说明原因', noAsset.result.includes('没有找到 MikeLingo-v*.zip'), noAsset.result);

    const badRepo = await setRepoAndCheck('这不是仓库名');
    check('更新源填错时给出格式提示', badRepo.result.includes('用户名/仓库名'), badRepo.result);

    // 下载 + 解包 + 校验：文件选择器没法自动化，但这几步是风险最高的，单独直接调
    const pkg = await optionsPage.evaluate(async (port) => {
      const updater = await import('./updater.js');
      const release = await updater.fetchLatestRelease('mock/v99.0.0');
      const files = await updater.downloadPackage(release, () => {});
      const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
      return {
        count: files.size,
        hasManifest: files.has('manifest.json'),
        hasSharedJs: files.has('src/common/shared.js'),
        hasIcon: files.has('icons/icon128.png'),
        version: manifest.version,
        // 解出来的内容要能真的当代码用，抽一个文件看看开头
        sharedHead: new TextDecoder().decode(files.get('src/common/shared.js')).slice(0, 2),
        iconMagic: [...files.get('icons/icon128.png').slice(1, 4)].map((c) => String.fromCharCode(c)).join('')
      };
    }, PORT);
    // 期望的文件数直接数主程序目录，别写死数字——加了新文件测试不该跟着改
    const expectedFiles = (function countFiles(dir) {
      return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
        const p = path.join(dir, e.name);
        return n + (e.isDirectory() ? countFiles(p) : 1);
      }, 0);
    })(EXT_PATH);
    check(
      '下载并解出完整发布包',
      pkg.count === expectedFiles && pkg.hasManifest && pkg.hasSharedJs && pkg.hasIcon,
      `${pkg.count} / 应有 ${expectedFiles} 个文件`
    );
    check('解包内容正确（deflate 与 store 两种都解得开）', pkg.sharedHead === '/*' && pkg.iconMagic === 'PNG', `${pkg.sharedHead} / ${pkg.iconMagic}`);
    check('发布包版本与 Release 标注一致', pkg.version === '99.0.0', pkg.version);

    // 安全校验：这些分支一旦失守就是"从网上下东西覆盖本机文件"，必须逐条测
    const guards = await optionsPage.evaluate(async (port) => {
      const updater = await import('./updater.js');
      const origin = `http://127.0.0.1:${port}`;
      // 下载地址都带 ?e2e=1，理由见 mock-server.cjs 里 browser_download_url 的注释
      const grab = async (release) => {
        try {
          await updater.downloadPackage(release, () => {});
          return 'no-error';
        } catch (err) {
          return err.message;
        }
      };
      return {
        evilHost: await grab({ version: '99.0.0', assetUrl: 'https://evil.example.com/x.zip' }),
        older: await grab({ version: '0.0.1', assetUrl: `${origin}/pkg/MikeLingo-v0.0.1.zip?e2e=1` }),
        mismatch: await grab({ version: '98.0.0', assetUrl: `${origin}/pkg/MikeLingo-v99.0.0.zip?e2e=1` })
      };
    }, PORT);
    check('拒绝从非 GitHub 域名下载', guards.evilHost.includes('拒绝从非 GitHub 域名下载'), guards.evilHost);
    check('拒绝安装比当前更旧的版本', guards.older.includes('不比当前的'), guards.older);
    check('包内版本与 Release 标注不符时中止', guards.mismatch.includes('对不上'), guards.mismatch);

    await optionsPage.screenshot({ path: path.join(SHOT_DIR, '20-options-update.png'), fullPage: true });
    await worker.evaluate(async () => chrome.storage.local.remove('updateApiBase'));

    /* --- 14. 生词本页面与复习 --- */
    // 造两条数据：一条新词、一条已复习过的
    await askBackground(optionsPage, { type: 'VOCAB_CLEAR' });
    for (const w of ['pronunciation', 'threshold']) {
      await askBackground(optionsPage, {
        type: 'VOCAB_ADD',
        entry: {
          word: w,
          lang: 'en',
          translation: `【译文】${w}`,
          phonetic: `/${w}-ipa/`,
          context: `A sentence with ${w} inside.`,
          explain: {
            title: w,
            kind: 'word',
            summary: `${w} 的模拟释义`,
            senses: [{ pos: 'n.', meaning: `${w} 词义`, detail: '补充说明' }],
            examples: [{ src: `A ${w} example.`, trans: `${w} 的例句翻译。` }],
            notes: '用法提示',
            related: ['related-word']
          }
        }
      });
    }

    const vocabPage = await browser.newPage();
    const vocabErrors = [];
    vocabPage.on('pageerror', (err) => vocabErrors.push(String(err)));
    vocabPage.on('console', (msg) => {
      if (msg.type() === 'error') vocabErrors.push(msg.text());
    });
    await vocabPage.goto(`chrome-extension://${extId}/src/vocab/vocab.html`, { waitUntil: 'domcontentloaded' });
    await sleep(700);

    const listInfo = await vocabPage.evaluate(() => ({
      total: document.getElementById('statTotal').textContent,
      due: document.getElementById('statDue').textContent,
      rows: document.querySelectorAll('.word').length,
      firstWord: document.querySelector('.w-text')?.textContent || '',
      firstPhonetic: document.querySelector('.w-phonetic')?.textContent || '',
      hasContext: Boolean(document.querySelector('.w-context')?.textContent),
      explainCollapsed: (() => {
        const d = document.querySelector('.w-explain');
        return Boolean(d) && !d.hidden && !d.open && Boolean(d.querySelector('.ex-senses li'));
      })()
    }));
    check('生词本页面列出全部词条', listInfo.rows === 2 && listInfo.total === '2', JSON.stringify(listInfo));
    check('词表显示音标与原句', listInfo.firstPhonetic.includes('ipa') && listInfo.hasContext, listInfo.firstPhonetic);
    check('词表里的详解默认折叠', listInfo.explainCollapsed);
    check('统计里两条都待复习', listInfo.due === '2');
    await vocabPage.screenshot({ path: path.join(SHOT_DIR, '16-vocab-list.png'), fullPage: true });

    // 搜索
    await vocabPage.type('#searchInput', 'threshold');
    await sleep(400);
    const searched = await vocabPage.evaluate(() => document.querySelectorAll('.word').length);
    check('生词本支持搜索过滤', searched === 1, `命中 ${searched} 条`);
    await vocabPage.evaluate(() => {
      const input = document.getElementById('searchInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);

    // 复习流程
    await vocabPage.evaluate(() => document.getElementById('tabReview').click());
    await sleep(600);
    const reviewStart = await vocabPage.evaluate(() => ({
      progress: document.getElementById('reviewProgress').textContent,
      word: document.getElementById('reviewWord').textContent,
      phonetic: document.getElementById('reviewPhonetic').textContent,
      answerHidden: document.getElementById('reviewAnswer').hidden
    }));
    check('复习页展示待复习队列', reviewStart.progress === '1 / 2' && Boolean(reviewStart.word), JSON.stringify(reviewStart));
    check('答案默认隐藏', reviewStart.answerHidden);

    await vocabPage.evaluate(() => document.getElementById('revealBtn').click());
    await sleep(200);
    const revealed = await vocabPage.evaluate(() => ({
      shown: !document.getElementById('reviewAnswer').hidden,
      translation: document.getElementById('reviewTranslation').textContent,
      explain: document.querySelector('#reviewExplain .ex-examples .ex-src')?.textContent || '',
      explainShown: !document.getElementById('reviewExplain').hidden,
      good: document.getElementById('gradeGoodHint').textContent,
      easy: document.getElementById('gradeEasyHint').textContent,
      hard: document.getElementById('gradeHardHint').textContent,
      again: document.getElementById('gradeAgainHint').textContent
    }));
    check('显示答案后给出译文', revealed.shown && revealed.translation.includes('译文'), revealed.translation);
    check('复习答案里带出词典详解与例句', revealed.explainShown && revealed.explain.includes('example'), revealed.explain);
    check(
      '四档评分预告下次复习时间',
      revealed.again.includes('分钟') &&
        revealed.hard.includes('小时') &&
        revealed.good.includes('天') &&
        revealed.easy.includes('天') &&
        new Set([revealed.again, revealed.hard, revealed.good, revealed.easy]).size === 4,
      `忘记 ${revealed.again} / 模糊 ${revealed.hard} / 记得 ${revealed.good} / 简单 ${revealed.easy}`
    );
    await vocabPage.screenshot({ path: path.join(SHOT_DIR, '17-vocab-review.png') });

    const reviewedWord = reviewStart.word;
    await vocabPage.evaluate(() => document.querySelector('.grade-good').click());
    await sleep(500);
    const afterGrade = await vocabPage.evaluate(() => ({
      progress: document.getElementById('reviewProgress').textContent,
      word: document.getElementById('reviewWord').textContent
    }));
    check('评分后进入下一条', afterGrade.progress === '2 / 2' && afterGrade.word !== reviewedWord, JSON.stringify(afterGrade));

    const graded = await askBackground(optionsPage, { type: 'VOCAB_LIST', query: { sort: 'alpha' } });
    const gradedEntry = graded.items.find((it) => it.word === reviewedWord);
    check(
      '评「记得」后排到一天后并计入复习次数',
      gradedEntry.reps === 1 && gradedEntry.interval === 1 && gradedEntry.due > Date.now() + 20 * 3600 * 1000,
      `interval=${gradedEntry.interval} reps=${gradedEntry.reps}`
    );

    // 「忘记」的词要留在本轮队列里，10 分钟后再问
    await vocabPage.evaluate(() => document.getElementById('revealBtn').click());
    await sleep(150);
    await vocabPage.evaluate(() => document.querySelector('.grade-again').click());
    await sleep(500);
    const afterAgain = await vocabPage.evaluate(() => ({
      progress: document.getElementById('reviewProgress').textContent,
      done: !document.getElementById('reviewDone').hidden
    }));
    check('评「忘记」的词排回本轮队尾', afterAgain.progress === '3 / 3' && !afterAgain.done, JSON.stringify(afterAgain));

    // 键盘：空格看答案、数字键评分
    await vocabPage.keyboard.press('Space');
    await sleep(150);
    const kbdRevealed = await vocabPage.evaluate(() => !document.getElementById('reviewAnswer').hidden);
    await vocabPage.keyboard.press('4');
    await sleep(500);
    const kbdDone = await vocabPage.evaluate(() => !document.getElementById('reviewDone').hidden);
    check('空格显示答案、数字键评分', kbdRevealed && kbdDone);
    const doneText = await vocabPage.evaluate(() => document.getElementById('reviewDoneTitle').textContent);
    check('复习完成后给出结果', /复习完成/.test(doneText), doneText);

    // 导出
    const exported = await askBackground(optionsPage, { type: 'VOCAB_EXPORT' });
    check(
      '导出包含全部词条与复习进度',
      exported.ok && exported.data.count === 2 && exported.data.words.every((w) => w.word && 'interval' in w),
      `${exported.data.count} 条`
    );

    // 导入：合并同词、新增新词
    const importRes = await askBackground(optionsPage, {
      type: 'VOCAB_IMPORT',
      payload: { version: 1, words: [{ word: 'threshold', translation: '门槛' }, { word: 'latency', translation: '延迟' }] }
    });
    const afterImport = await askBackground(optionsPage, { type: 'VOCAB_STATS' });
    check(
      '导入合并同词并新增新词',
      importRes.ok && importRes.result.added === 1 && importRes.result.merged === 1 && afterImport.stats.total === 3,
      JSON.stringify(importRes.result)
    );

    check('生词本页面无 JS 报错', vocabErrors.length === 0, vocabErrors.slice(0, 2).join(' | '));

    check('页面无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } catch (err) {
    check('测试流程异常', false, String(err && err.stack ? err.stack.split('\n')[0] : err));
  } finally {
    await browser.close();
    mock.kill();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
    process.exit(failed.length ? 1 : 0);
  }
})();
