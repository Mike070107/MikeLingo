/**
 * 端到端验证：加载未打包扩展 + 本地假接口，真实跑一遍段落对照 / 左右并列 / 划词翻译。
 * 用法：node tools/e2e-test.cjs [--headful] [--edge]
 *   --edge  换成本机安装的 Microsoft Edge 跑同一套断言（同一份 Chromium 内核，验证兼容性）
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const EXT_PATH = path.join(__dirname, '..', 'MikeLingo');
const PORT = Number(process.env.MIKELINGO_TEST_PORT) || 8787;
const PAGE_URL = `http://127.0.0.1:${PORT}/test.html`;

const USE_EDGE = process.argv.includes('--edge');
// Edge 的截图单放一层，免得和 Chrome 的互相覆盖、看不出是哪家浏览器出的问题
const SHOT_DIR = path.join(__dirname, 'screenshots', ...(USE_EDGE ? ['edge'] : []));

/** Edge 的安装位置：64 位机器上稳定版在 Program Files (x86)，尊重环境变量覆盖 */
function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`没找到 Edge，可用 EDGE_PATH 指定：${candidates.join(' / ')}`);
  return hit;
}

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
/**
 * 截图只是排查用的产物，不是断言。机器一忙 captureScreenshot 就可能超时，
 * 让它把 150 条断言一起带走完全不值——截不出来就记一行警告继续跑。
 */
async function shot(target, name, options = {}) {
  try {
    await target.screenshot({ path: path.join(SHOT_DIR, name), ...options });
  } catch (err) {
    console.log(`WARN  截图 ${name} 失败（不影响断言）— ${err?.message || err}`);
  }
}

function askBackground(somePage, message) {
  return somePage.evaluate(async (msg) => chrome.runtime.sendMessage(msg), message);
}

/* ------------------------- 同步测试用的小工具（Node 侧） ------------------------ */

const { webcrypto } = require('crypto');

/**
 * 在 Node 里按扩展的格式加密一段 JSON，用来伪造"另一台机器写上去的"远端文件。
 * 参数必须和 src/common/crypto.js 完全一致，否则测的就不是同一套格式了。
 */
async function encryptLikeExtension(value, passphrase) {
  const enc = new TextEncoder();
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  return { alg: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iter: 310000, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

const DAV_AUTH = 'Basic ' + Buffer.from('mikeuser:mikepass').toString('base64');

async function davGet(port, name) {
  const res = await fetch(`http://127.0.0.1:${port}/dav/${name}`, { headers: { Authorization: DAV_AUTH } });
  if (res.status === 404) return null;
  return JSON.parse(await res.text());
}

async function davPut(port, name, obj) {
  const res = await fetch(`http://127.0.0.1:${port}/dav/${name}`, {
    method: 'PUT',
    headers: { Authorization: DAV_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  });
  if (!res.ok) throw new Error(`假 WebDAV 写入失败：${res.status}`);
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

  if (USE_EDGE) console.log(`浏览器：Microsoft Edge（${findEdge()}）`);

  const browser = await puppeteer.launch({
    headless: false,
    ...(USE_EDGE ? { executablePath: findEdge() } : {}),
    // 整页截图在机器忙的时候很慢，默认 30s 远不够；截图另有 shot() 兜底，超时也不会打断整轮
    protocolTimeout: 180000,
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
    await shot(page, '1-no-key.png');
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
    await shot(page, '2-inline.png', { fullPage: true });

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
    await shot(page, '3-columns.png', { fullPage: true });
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
    await shot(page, '4-replace.png');
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
    await shot(page, '5-selection.png');

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
    await shot(page, '5b-selection-button.png');

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
    await shot(page, '5c-selection-lang.png');

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
    await shot(page, '6-error.png');

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
    await shot(optionsPage, '7-options.png', { fullPage: true });

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
    await shot(popupPage, '9-popup-quick.png');

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
    await shot(popupPage, '10-popup-quick-error.png');

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
      // 下拉里固定有「自定义…」（和详解那边的「跟随该接口的模型」空项），不算候选模型
      const listOf = (el) =>
        Array.from(el.querySelectorAll('option'))
          .map((o) => o.value)
          .filter((v) => v && v !== '__custom__');
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
      setUrl('https://llm-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'); // 百炼专属部署
      const maas = { row: rowList(), explain: explainList() };
      setUrl('http://127.0.0.1:9'); // 认不出的自定义地址：不瞎猜，留空让用户自己填
      const unknown = { row: rowList(), explain: explainList() };

      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { openai, deepseek, dashscope, maas, unknown };
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
        !modelOptions.dashscope.explain.includes('qwen-mt-flash') &&
        modelOptions.dashscope.row.includes('qwen-mt-flash'), // 翻译那栏仍可选 MT
      `deepseek=${modelOptions.deepseek.explain} dashscope=${modelOptions.dashscope.explain}`
    );
    check(
      '百炼专属部署地址也能认出通义的候选模型',
      modelOptions.maas.row.includes('qwen-plus') && modelOptions.maas.row.includes('qwen-mt-flash'),
      `maas=${modelOptions.maas.row}`
    );
    check(
      '地址认不出时不给候选模型',
      modelOptions.unknown.row.length === 0 && modelOptions.unknown.explain.length === 0,
      `row=${modelOptions.unknown.row} explain=${modelOptions.unknown.explain}`
    );
    const deeplSupport = await optionsPage.evaluate(() => {
      const normalized = globalThis.DST.normalizeProvider(
        { id: 'deepl', name: 'DeepL', type: 'deepl', baseUrl: 'https://api-free.deepl.com', model: '' },
        0,
        new Set()
      );
      return {
        type: normalized.type,
        model: normalized.model,
        zh: globalThis.DST.deeplTargetLang('简体中文'),
        en: globalThis.DST.deeplTargetLang('English'),
        preset: Array.from(document.querySelectorAll('#presetSelect option')).some((option) => option.value === 'deepl-free')
      };
    });
    check(
      'DeepL 服务商类型和语言映射可用',
      deeplSupport.type === 'deepl' && deeplSupport.model === '' && deeplSupport.zh === 'ZH-HANS' && deeplSupport.en === 'EN-US',
      JSON.stringify(deeplSupport)
    );
    check('DeepL Free 出现在现有服务商预设中', deeplSupport.preset);
    const beforeDeepL = await optionsPage.evaluate(async () => ({
      sync: await chrome.storage.sync.get('settings'),
      local: await chrome.storage.local.get(['apiKeys', 'apiKey'])
    }));
    await optionsPage.evaluate(async (port) => {
      const current = await globalThis.DST.loadSettings();
      const provider = globalThis.DST.normalizeProvider(
        {
          id: 'deepl-e2e',
          name: 'DeepL 协议回归',
          type: 'deepl',
          deeplPlan: 'free',
          baseUrl: `http://127.0.0.1:${port}`,
          model: '',
          timeout: 10000
        },
        0,
        new Set()
      );
      await globalThis.DST.saveSettings({ providers: [provider], activeProviderId: provider.id, targetLang: '简体中文', cacheEnabled: false });
      await chrome.storage.local.set({ apiKeys: { [provider.id]: 'deepl-mock-key:fx' }, apiKey: '' });
    }, PORT);
    const deeplBatch = await askBackground(optionsPage, { type: 'TRANSLATE', texts: ['first paragraph', 'second paragraph'] });
    check(
      'DeepL 使用专用鉴权批量翻译并保持顺序',
      deeplBatch?.ok === true &&
        deeplBatch.results?.[0] === '【DeepL:ZH-HANS】first paragraph' &&
        deeplBatch.results?.[1] === '【DeepL:ZH-HANS】second paragraph',
      JSON.stringify(deeplBatch)
    );
    const deeplExplain = await askBackground(optionsPage, { type: 'EXPLAIN', text: 'translation' });
    check(
      'DeepL 不承担词典详解并给出通用模型引导',
      deeplExplain?.ok === false && /DeepL Translate/.test(deeplExplain.error || '') && /通用模型/.test(deeplExplain.error || ''),
      deeplExplain?.error || ''
    );
    const deeplRateLimit = await askBackground(optionsPage, { type: 'TRANSLATE', texts: ['__deepl_rate_limit__'] });
    check(
      'DeepL 429 会有限重试后恢复',
      deeplRateLimit?.ok === true && deeplRateLimit.results?.[0] === '【DeepL:ZH-HANS】__deepl_rate_limit__',
      JSON.stringify(deeplRateLimit)
    );
    const deeplQuota = await askBackground(optionsPage, { type: 'TRANSLATE', texts: ['__deepl_quota__'] });
    check(
      'DeepL 456 配额耗尽给出明确错误',
      deeplQuota?.ok === false && /字符配额已用尽/.test(deeplQuota.error || '') && /HTTP 456/.test(deeplQuota.error || ''),
      deeplQuota?.error || ''
    );
    await optionsPage.evaluate(async () => chrome.storage.local.set({ apiKeys: { 'deepl-e2e': 'wrong-key' } }));
    const deeplAuth = await askBackground(optionsPage, { type: 'TRANSLATE', texts: ['auth check'] });
    check(
      'DeepL 401/403 鉴权失败指向 API Key 或权限',
      deeplAuth?.ok === false && /API Key|无权访问/.test(deeplAuth.error || '') && /HTTP 403/.test(deeplAuth.error || ''),
      deeplAuth?.error || ''
    );
    await optionsPage.evaluate(async (snapshot) => {
      await chrome.storage.sync.set(snapshot.sync);
      await chrome.storage.local.set(snapshot.local);
    }, beforeDeepL);
    // 回归：框里存着一个已下线的旧模型名时，候选照样要能选中
    // （以前是 input+datalist，datalist 会按框里的文字过滤，一条都不剩 = 用户眼里的「下拉点不开」）
    const staleModel = await optionsPage.evaluate(async () => {
      const li = document.querySelectorAll('.provider')[1];
      const baseUrl = li.querySelector('.p-baseUrl');
      const select = li.querySelector('.p-models');
      const input = li.querySelector('.p-model');

      // 这一行的地址/模型后面还有用例依赖（B 接口必须留在死端口），用完必须原样还原
      const origUrl = baseUrl.value;
      const origModel = input.value;

      baseUrl.value = 'https://llm-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
      baseUrl.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = 'qwen-mt-turbo'; // 已下线，不在候选里
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const stale = {
        picked: select.value,
        inputShown: !input.hidden,
        selectShown: !select.hidden,
        count: select.querySelectorAll('option').length
      };

      // 从下拉里挑一个候选，应当写回输入框并收起手填框
      select.value = 'qwen-plus';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      const after = { model: input.value, inputShown: !input.hidden, picked: select.value };

      window.__restoreModelRow = () => {
        baseUrl.value = origUrl;
        baseUrl.dispatchEvent(new Event('input', { bubbles: true }));
        input.value = origModel;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { url: baseUrl.value, model: input.value };
      };
      return { stale, after };
    });
    // 下拉可见时长什么样，得真看一眼（上面那张整页图是"地址认不出、只剩手填框"的状态）
    await shot(optionsPage, '11b-model-picker.png');
    staleModel.restored = await optionsPage.evaluate(() => window.__restoreModelRow());
    check(
      '框里是已下线的旧模型名时，候选下拉仍可选',
      staleModel.stale.picked === '__custom__' &&
        staleModel.stale.inputShown &&
        staleModel.stale.selectShown &&
        staleModel.stale.count > 2,
      `选中=${staleModel.stale.picked} 手填框可见=${staleModel.stale.inputShown} 候选项=${staleModel.stale.count}`
    );
    check(
      '下拉选了候选模型会写回并收起手填框',
      staleModel.after.model === 'qwen-plus' && !staleModel.after.inputShown,
      `model=${staleModel.after.model} 手填框可见=${staleModel.after.inputShown}`
    );
    check(
      '这组用例已还原该接口的地址与模型（后面的用例依赖它）',
      staleModel.restored.url === 'http://127.0.0.1:9',
      JSON.stringify(staleModel.restored)
    );

    await shot(optionsPage, '11-options-providers.png', { fullPage: true });

    /* 接口卡片的精简布局：常用的两样留在外面，其余收进「更多设置」 */
    const layout = await optionsPage.evaluate(() => {
      const li = document.querySelector('.provider .provider-body:not([hidden])')?.closest('.provider');
      if (!li) return null;
      const body = li.querySelector('.provider-body');
      const adv = li.querySelector('.p-adv');
      // 只看直接摆在外面的字段（不含折叠区里的）
      const topLevel = [...body.children]
        .filter((el) => el.classList.contains('field') && !el.hidden)
        .map((el) => el.querySelector('label')?.textContent.trim());
      const keyRow = li.querySelector('.p-key').closest('.input-row');
      return {
        topLevel,
        advOpen: adv.open,
        advFields: [...adv.querySelectorAll('.field label')].map((l) => l.textContent.trim()),
        saveInKeyRow: Boolean(keyRow.querySelector('.p-save')),
        saveAfterInput: [...keyRow.children].indexOf(keyRow.querySelector('.p-save')) >
          [...keyRow.children].indexOf(li.querySelector('.p-key'))
      };
    });
    check('接口卡片外层只留「模型」和「API Key」', JSON.stringify(layout?.topLevel) === '["模型","API Key"]', JSON.stringify(layout?.topLevel));
    check('名称 / 地址 / 温度 / 超时收进「更多设置」且默认折叠', layout?.advOpen === false && layout.advFields.length === 4, `${layout?.advFields?.join('、')}`);
    check('保存按钮就在 API Key 输入框后面', layout?.saveInKeyRow === true && layout?.saveAfterInput === true, JSON.stringify(layout));

    // 折叠区里的字段要能正常展开使用，不能只是藏起来
    const advUsable = await optionsPage.evaluate(() => {
      const li = document.querySelector('.provider .provider-body:not([hidden])').closest('.provider');
      const adv = li.querySelector('.p-adv');
      adv.open = true;
      const url = li.querySelector('.p-baseUrl');
      return { visible: url.offsetParent !== null, value: url.value };
    });
    check('展开「更多设置」后地址字段可见可编辑', advUsable.visible === true && advUsable.value.startsWith('http'), advUsable.value);

    // 贴着 Key 的那个保存按钮要真的存下东西，而不是个摆设
    await optionsPage.evaluate(() => {
      const li = document.querySelector('.provider .provider-body:not([hidden])').closest('.provider');
      const key = li.querySelector('.p-key');
      key.value = 'sk-inline-save-check';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      li.querySelector('.p-save').click();
    });
    await sleep(1200);
    const inlineSaved = await optionsPage.evaluate(() => {
      // 提示写在"当前展开的那个接口"里，不能拿第一个 .p-saveresult 顶包
      const li = document.querySelector('.provider .provider-body:not([hidden])')?.closest('.provider');
      const el = li?.querySelector('.p-saveresult');
      return { text: el?.textContent.trim() || '', ok: Boolean(el?.classList.contains('ok')) };
    });
    const inlineStored = await worker.evaluate(async () => (await chrome.storage.local.get('apiKeys')).apiKeys || {});
    check('Key 旁边的「保存」真的把密钥存下来了', Object.values(inlineStored).includes('sk-inline-save-check'), Object.keys(inlineStored).join(','));
    check('保存后在原地给出反馈', inlineSaved.ok === true && inlineSaved.text.includes('已保存'), inlineSaved.text);

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
    await shot(popupPage, '12-popup-provider.png');

    await page.bringToFront();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const backToA = await waitFor(page, () => document.querySelectorAll('dst-trans').length >= 5);
    check('切回原接口后翻译恢复正常', backToA);
    await toggle(worker);

    /* --- 11. 翻译专用模型（qwen-mt）走独立调用方式 --- */
    await optionsPage.evaluate(async () => chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' }));
    await applySettings(worker, { model: 'qwen-mt-flash', targetLang: '简体中文' }, 'sk-mock-key-123456');
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
    await shot(page, '13-qwen-mt.png');
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
    await worker.evaluate(async (port) => {
      await chrome.storage.sync.set({
        settings: { baseUrl: `http://127.0.0.1:${port}`, model: 'legacy-model', displayMode: 'inline', selectionEnabled: true }
      });
      await chrome.storage.local.remove('apiKeys');
      await chrome.storage.local.set({ apiKey: 'sk-legacy-key-999' });
    }, PORT);
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

    /* --- 12.5 服务商限流（HTTP 429）能自己退避到成功 --- */
    // 真实事故：阿里云百炼按 RPM 卡，整页翻译一开就把额度打满，页面直接红字报 429。
    // 这里把假服务端设成"两次请求间隔小于 400ms 就回 429"，扩展必须自己放慢并把整页译完。
    await optionsPage.evaluate(async () => chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' }));
    await fetch(`http://127.0.0.1:${PORT}/__ratelimit?minGapMs=400`);
    await applySettings(
      worker,
      {
        baseUrl: `http://127.0.0.1:${PORT}`,
        model: 'mock-model-ratelimit',
        // 故意配成最容易打爆的组合：高并发 + 每批一段
        concurrency: 5,
        batchSize: 1,
        batchChars: 6000,
        rpm: 0,
        maxRetries: 2
      },
      'sk-mock-key-123456'
    );
    await page.bringToFront();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(500);
    await toggle(worker);
    const rateOk = await waitFor(page, () => document.querySelectorAll('dst-trans').length >= 5, 60000);
    const rateInfo = await page.evaluate(() => ({
      count: document.querySelectorAll('dst-trans').length,
      hud: document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent?.replace(/\s+/g, ' ').trim() || ''
    }));
    const rateStats = await (await fetch(`http://127.0.0.1:${PORT}/__ratelimit/stats`)).json();
    check(
      '触发 429 后自动放慢并把整页译完',
      rateOk && !/限流|翻译出错/.test(rateInfo.hud),
      `译出 ${rateInfo.count} 段，被拒 ${rateStats.rejected} 次，HUD：${rateInfo.hud.slice(0, 50)}`
    );
    check('假服务端确实拒绝过请求（用例有效）', rateStats.rejected > 0, `429 ${rateStats.rejected} 次`);
    await toggle(worker);
    await fetch(`http://127.0.0.1:${PORT}/__ratelimit?minGapMs=0`); // 关掉限流，别影响后面的用例
    await applySettings(worker, { concurrency: 3, batchSize: 10, batchChars: 1800 });

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
    await shot(page, '15-selection-phonetic.png');

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
    await shot(page, '19-selection-explain.png');

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
    await shot(quickPage, '18-popup-vocab.png');
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

    // 选目录：源码仓库是「项目根\MikeLingo\」两层同名结构，用户几乎必然选中外面那层。
    // 真·文件选择器没法自动化，但出问题的是选完之后那段判断，拿假句柄直接喂它。
    const resolveDir = await optionsPage.evaluate(async () => {
      const updater = await import('./updater.js');
      const name = chrome.runtime.getManifest().name;
      // 用 OPFS 拿**浏览器原生的** FileSystemDirectoryHandle：和用户选目录拿到的是同一种对象，
      // 不是自己拼的假货。原生文件选择器没法自动化，但选完之后的每一步都能这样真跑。
      const root = await navigator.storage.getDirectory();
      await root.remove?.({ recursive: true }).catch(() => {});
      let seq = 0;
      const mkDir = async (dirName, { manifest = null, children = [] } = {}) => {
        // OPFS 里同名目录会复用，加个序号前缀隔开各用例；对外仍要露出原来的名字
        const dir = await (await root.getDirectoryHandle(`case${seq++}`, { create: true }))
          .getDirectoryHandle(dirName, { create: true });
        if (manifest) {
          const w = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable();
          await w.write(manifest);
          await w.close();
        }
        for (const [childName, childManifest] of children) {
          const child = await dir.getDirectoryHandle(childName, { create: true });
          if (childManifest) {
            const w = await (await child.getFileHandle('manifest.json', { create: true })).createWritable();
            await w.write(childManifest);
            await w.close();
          }
        }
        return dir;
      };
      const extManifest = JSON.stringify({ ...chrome.runtime.getManifest(), name, version: '1.0.0' });
      const tryResolve = async (dir) => {
        try {
          return { ok: true, name: (await updater.resolveInstallDir(dir)).name };
        } catch (err) {
          return { ok: false, msg: String(err.message) };
        }
      };

      // 真跑一遍安装：下载 → 解包 → 写进这个真目录 → 再从目录里读回来核对
      const realInstall = await (async () => {
        try {
          const dir = await mkDir(name, { manifest: extManifest });
          const release = await updater.fetchLatestRelease('mock/v99.0.0');
          const files = await updater.downloadPackage(release, () => {});
          // 装之前先塞一个上一版留下的垃圾文件，看看会不会被清掉
          const stale = await dir.getDirectoryHandle('src', { create: true });
          await (await (await stale.getFileHandle('removed-in-new-version.js', { create: true })).createWritable()).close();

          await updater.installFiles(dir, files, () => {});

          const readText = async (p) => {
            const parts = p.split('/');
            let d = dir;
            for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
            return (await (await d.getFileHandle(parts.at(-1))).getFile()).text();
          };
          const staleGone = await (async () => {
            try {
              await stale.getFileHandle('removed-in-new-version.js');
              return false;
            } catch {
              return true;
            }
          })();
          return {
            ok: true,
            version: JSON.parse(await readText('manifest.json')).version,
            sharedHead: (await readText('src/common/shared.js')).slice(0, 2),
            staleGone
          };
        } catch (err) {
          return { ok: false, msg: String(err.message) };
        }
      })();

      return {
        realInstall,
        // 直接选中扩展本体
        direct: await tryResolve(await mkDir(name, { manifest: extManifest })),
        // 选中项目根（同名！里面是 README/tools/Release + 一个 MikeLingo 子目录）
        repoRoot: await tryResolve(
          await mkDir(name, { children: [['tools', null], ['Release', null], [name, extManifest]] })
        ),
        // 完全不相干的目录
        unrelated: await tryResolve(await mkDir('Downloads', { children: [['foo', null]] })),
        // 下面有多个候选时不瞎猜
        ambiguous: await tryResolve(
          await mkDir('backup', { children: [['MikeLingo', extManifest], ['MikeLingo-old', extManifest]] })
        )
      };
    });
    check(
      '真的往原生目录句柄里装一遍（OPFS，非伪造）：文件写对、版本更新、旧文件清掉',
      resolveDir.realInstall.ok &&
        resolveDir.realInstall.version === '99.0.0' &&
        resolveDir.realInstall.sharedHead === '/*' &&
        resolveDir.realInstall.staleGone,
      JSON.stringify(resolveDir.realInstall)
    );
    check('直接选中扩展目录时原样采用', resolveDir.direct.ok && resolveDir.direct.name === 'MikeLingo', JSON.stringify(resolveDir.direct));
    check(
      '选中同名的项目根目录时自动往下找一层',
      resolveDir.repoRoot.ok && resolveDir.repoRoot.name === 'MikeLingo',
      JSON.stringify(resolveDir.repoRoot)
    );
    check(
      '选错不相干目录时报错并指明去哪儿看路径',
      !resolveDir.unrelated.ok && resolveDir.unrelated.msg.includes('extensions') && resolveDir.unrelated.msg.includes('manifest.json'),
      resolveDir.unrelated.msg
    );
    check(
      '下面有多个候选时不瞎猜',
      !resolveDir.ambiguous.ok && resolveDir.ambiguous.msg.includes('不止一个'),
      resolveDir.ambiguous.msg
    );

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

    await shot(optionsPage, '20-options-update.png', { fullPage: true });
    await worker.evaluate(async () => chrome.storage.local.remove('updateApiBase'));

    /* --- 13e. 云同步（WebDAV / Gist）与备份文件 --- */
    const PASSPHRASE = 'correct horse battery staple';
    const SYNC_KEY = 'sk-secret-to-sync-987654';
    const DAV_BASE = `http://127.0.0.1:${PORT}/dav`;

    const resetSync = async (file = 'mikelingo-sync.json') => {
      await fetch(`http://127.0.0.1:${PORT}/dav/__reset`);
      await askBackground(optionsPage, {
        type: 'SYNC_SAVE_CONFIG',
        config: {
          enabled: true,
          backend: 'webdav',
          auto: false, // 自动同步会在断言中途插一脚，测试里只手动触发
          includeSecrets: true,
          webdav: { url: `${DAV_BASE}/${file}`, user: 'mikeuser' }
        },
        creds: { webdavPass: 'mikepass', passphrase: PASSPHRASE }
      });
    };

    await resetSync();
    // 造本地数据：两个生词 + 一个 API Key
    await askBackground(optionsPage, { type: 'VOCAB_CLEAR' });
    for (const w of ['syncalpha', 'syncbeta']) {
      await askBackground(optionsPage, { type: 'VOCAB_ADD', entry: { word: w, lang: 'en', translation: `【译文】${w}` } });
    }
    await worker.evaluate(async (key) => {
      await chrome.storage.local.set({ apiKeys: { deepseek: key }, apiKeysUpdatedAt: Date.now() });
    }, SYNC_KEY);

    const firstPush = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    check('首次同步把本地数据推上远端', firstPush.ok === true, firstPush.result?.summary || firstPush.error);

    const remoteAfterPush = await davGet(PORT, 'mikelingo-sync.json');
    check(
      '远端文件包含生词与设置',
      remoteAfterPush?.vocab?.words?.length === 2 && Boolean(remoteAfterPush.settings?.providers),
      `${remoteAfterPush?.vocab?.words?.length} 个词`
    );
    // 这条是整个方案的安全底线：云端只能拿到密文
    const remoteText = JSON.stringify(remoteAfterPush);
    check(
      'API Key 在云端是密文，搜不到明文',
      !remoteText.includes(SYNC_KEY) && Boolean(remoteAfterPush.secrets?.data),
      `secrets.alg=${remoteAfterPush.secrets?.alg}`
    );
    check('远端记录了写入设备', typeof remoteAfterPush.device === 'string' && remoteAfterPush.device.length > 0, remoteAfterPush.device);

    /* 模拟另一台机器：直接往远端写一份含新词、新接口、加密密钥的文件 */
    const otherKey = 'sk-from-the-other-machine-42';
    const otherBackup = {
      format: 'mikelingo-backup',
      version: 2,
      exportedAt: Date.now(),
      device: 'Edge / Windows',
      settings: {
        ...remoteAfterPush.settings,
        providers: [
          ...remoteAfterPush.settings.providers,
          { id: 'otherbox', name: '另一台机器加的接口', baseUrl: 'https://api.example.com', model: 'demo-model', temperature: 1, timeout: 60000 }
        ]
      },
      settingsUpdatedAt: Date.now() + 60000, // 比本机新，设置该以它为准
      vocab: { words: [...remoteAfterPush.vocab.words, { word: 'syncgamma', lang: 'en', translation: '【译文】syncgamma', createdAt: Date.now(), updatedAt: Date.now() }], deleted: [] },
      secrets: await encryptLikeExtension({ apiKeys: { deepseek: SYNC_KEY, otherbox: otherKey } }, PASSPHRASE),
      secretsUpdatedAt: Date.now() + 60000
    };
    await davPut(PORT, 'mikelingo-sync.json', otherBackup);

    const pulled = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    check('从远端合并回新增的生词', pulled.result?.vocab?.added === 1, JSON.stringify(pulled.result?.vocab));
    check('从远端合并回新增的接口配置', pulled.result?.settingsChanged === true, pulled.result?.summary);
    check('自动带回另一台机器的 API Key', pulled.result?.keysAdded === 1, `keysAdded=${pulled.result?.keysAdded}`);

    const afterMerge = await worker.evaluate(async () => {
      const s = (await chrome.storage.sync.get('settings')).settings || {};
      const keys = (await chrome.storage.local.get('apiKeys')).apiKeys || {};
      return { providerIds: (s.providers || []).map((p) => p.id), keyIds: Object.keys(keys), otherKey: keys.otherbox || '' };
    });
    check('合并后两台机器的接口都在', afterMerge.providerIds.includes('otherbox') && afterMerge.providerIds.includes('deepseek'), afterMerge.providerIds.join(','));
    check('解密出来的密钥内容正确', afterMerge.otherKey === otherKey, afterMerge.otherKey.slice(0, 12));

    const vocabAfterMerge = await askBackground(optionsPage, { type: 'VOCAB_LIST', query: { limit: 100 } });
    check('三个生词都在本机', vocabAfterMerge.total === 3, `共 ${vocabAfterMerge.total} 条`);

    /* 删除要能传播出去，否则在这台删掉的词会被另一台还回来 */
    await askBackground(optionsPage, { type: 'VOCAB_REMOVE', key: 'en|syncgamma' });
    await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    const remoteAfterDelete = await davGet(PORT, 'mikelingo-sync.json');
    check(
      '删除生成墓碑并写上远端',
      (remoteAfterDelete.vocab.deleted || []).some((d) => d.key === 'en|syncgamma') &&
        !remoteAfterDelete.vocab.words.some((w) => w.word === 'syncgamma'),
      `远端剩 ${remoteAfterDelete.vocab.words.length} 个词`
    );

    // 对面拿着旧数据（还带着这个词）再同步一次，不该把它复活
    await davPut(PORT, 'mikelingo-sync.json', {
      ...remoteAfterDelete,
      vocab: { words: [...remoteAfterDelete.vocab.words, otherBackup.vocab.words.find((w) => w.word === 'syncgamma')], deleted: remoteAfterDelete.vocab.deleted }
    });
    await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    const afterResurrect = await askBackground(optionsPage, { type: 'VOCAB_LIST', query: { limit: 100 } });
    check('已删除的词不会被旧数据复活', afterResurrect.total === 2, `共 ${afterResurrect.total} 条`);

    /* 乐观锁：远端在写回前被改过，重试一次仍要成功 */
    await fetch(`http://127.0.0.1:${PORT}/dav/__arm-conflict?path=${encodeURIComponent('/dav/conflict-once.json')}`);
    await resetSync('conflict-once.json');
    await fetch(`http://127.0.0.1:${PORT}/dav/__arm-conflict?path=${encodeURIComponent('/dav/conflict-once.json')}`);
    const conflictRun = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    check('远端被并发改动时自动重试并写成功', conflictRun.ok === true, conflictRun.result?.summary || conflictRun.error);

    /* 口令不对：生词本照常同步，密钥这块如实报错 */
    await resetSync();
    await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    await askBackground(optionsPage, { type: 'SYNC_SAVE_CONFIG', config: {}, creds: { passphrase: 'wrong-passphrase' } });
    const wrongPass = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'pull' });
    check(
      '主口令不对时明确说是口令问题，其余照常同步',
      wrongPass.ok === true && /主口令不对/.test(wrongPass.result?.secretsError || ''),
      wrongPass.result?.secretsError
    );
    await askBackground(optionsPage, { type: 'SYNC_SAVE_CONFIG', config: {}, creds: { passphrase: PASSPHRASE } });

    /* 配置不全时提前说清楚缺什么，而不是等服务端回一个 401 */
    await askBackground(optionsPage, { type: 'SYNC_SAVE_CONFIG', config: { includeSecrets: true }, creds: { passphrase: '' } });
    const noPass = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    check('勾了同步密钥却没设主口令时中止并说明', noPass.ok === false && /主口令/.test(noPass.error || ''), noPass.error);
    await askBackground(optionsPage, { type: 'SYNC_SAVE_CONFIG', config: {}, creds: { passphrase: PASSPHRASE } });

    const badUrl = await askBackground(optionsPage, {
      type: 'SYNC_SAVE_CONFIG',
      config: { webdav: { url: 'dav.example.com/x' } },
      creds: {}
    });
    const badUrlRun = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    check('WebDAV 地址格式不对时给出可操作的提示', badUrlRun.ok === false && /http/.test(badUrlRun.error || ''), badUrlRun.error);
    check('保存配置时密码只回显"已设置"', badUrl.config?.hasWebdavPass === true && badUrl.config?.webdavPass === undefined, JSON.stringify(Object.keys(badUrl.config || {})));

    const wrongPassword = await askBackground(optionsPage, {
      type: 'SYNC_SAVE_CONFIG',
      config: { webdav: { url: `${DAV_BASE}/mikelingo-sync.json` } },
      creds: { webdavPass: 'not-the-password' }
    });
    const authFail = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    check('WebDAV 密码错时报 401 并指明是认证问题', authFail.ok === false && /401/.test(authFail.error || ''), authFail.error);
    check('凭据保存后不回显原文', wrongPassword.config?.hasWebdavPass === true, '');
    await askBackground(optionsPage, { type: 'SYNC_SAVE_CONFIG', config: {}, creds: { webdavPass: 'mikepass' } });

    /* 测试连接：远端已有内容时要报出有多少词、谁写的 */
    const testInfo = await askBackground(optionsPage, { type: 'SYNC_TEST' });
    check('测试连接报出远端内容概况', testInfo.ok === true && /个生词/.test(testInfo.info?.message || ''), testInfo.info?.message);

    /* 换 GitHub Gist 后端：Gist ID 留空时自动创建并存下来 */
    await worker.evaluate(async (base) => chrome.storage.local.set({ syncApiBase: base }), `http://127.0.0.1:${PORT}`);
    await askBackground(optionsPage, {
      type: 'SYNC_SAVE_CONFIG',
      config: { backend: 'gist', gist: { id: '' } },
      creds: { gistToken: 'ghp_mocktoken123456' }
    });
    const gistRun = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    const gistCfg = await askBackground(optionsPage, { type: 'SYNC_GET_CONFIG' });
    check('Gist 后端同步成功', gistRun.ok === true, gistRun.result?.summary || gistRun.error);
    check('首次同步自动创建 Gist 并记下 id', /^mockgist/.test(gistCfg.config?.gist?.id || ''), gistCfg.config?.gist?.id);

    const badToken = await askBackground(optionsPage, { type: 'SYNC_SAVE_CONFIG', config: {}, creds: { gistToken: 'not-a-token' } });
    const gistAuth = await askBackground(optionsPage, { type: 'SYNC_NOW', direction: 'both' });
    check('Gist Token 无效时说明是 Token 问题', gistAuth.ok === false && /Token/.test(gistAuth.error || ''), gistAuth.error);
    check('Gist Token 同样只回显"已设置"', badToken.config?.hasGistToken === true, '');

    await worker.evaluate(async () => chrome.storage.local.remove('syncApiBase'));
    await askBackground(optionsPage, {
      type: 'SYNC_SAVE_CONFIG',
      config: { backend: 'webdav', enabled: false },
      creds: { gistToken: '' }
    });

    /* 备份文件：导出 → 清空 → 导入还原 */
    const backupFile = await askBackground(optionsPage, { type: 'BACKUP_EXPORT', includeSecrets: true, passphrase: PASSPHRASE });
    check(
      '导出备份包含生词、设置与加密后的密钥',
      backupFile.ok === true && backupFile.data.vocab.words.length === 2 && Boolean(backupFile.data.secrets?.data) && !JSON.stringify(backupFile.data).includes(SYNC_KEY),
      `${backupFile.data?.vocab?.words?.length} 个词`
    );
    await askBackground(optionsPage, { type: 'VOCAB_CLEAR' });
    await worker.evaluate(async () => chrome.storage.local.set({ apiKeys: {} }));
    const backupRestore = await askBackground(optionsPage, { type: 'BACKUP_IMPORT', payload: backupFile.data, passphrase: PASSPHRASE });
    const restoredKeys = await worker.evaluate(async () => (await chrome.storage.local.get('apiKeys')).apiKeys || {});
    check('导入备份还原生词', backupRestore.ok === true && backupRestore.result.vocab.added === 2, JSON.stringify(backupRestore.result?.vocab));
    check('导入备份还原 API Key', restoredKeys.deepseek === SYNC_KEY, String(restoredKeys.deepseek).slice(0, 10));

    const wrongImport = await askBackground(optionsPage, { type: 'BACKUP_IMPORT', payload: backupFile.data, passphrase: 'nope' });
    check('导入时口令不对只影响密钥，并说明原因', wrongImport.ok === true && /主口令不对/.test(wrongImport.result?.secretsError || ''), wrongImport.result?.secretsError);

    const notOurs = await askBackground(optionsPage, { type: 'BACKUP_IMPORT', payload: { format: 'someone-else', words: [] } });
    check('不是 MikeLingo 的备份文件会被拒绝', notOurs.ok === false && /不是 MikeLingo/.test(notOurs.error || ''), notOurs.error);

    // 老版本只有生词本的导出（{version:1, words:[…]}）也要能导进来
    const legacyImport = await askBackground(optionsPage, {
      type: 'BACKUP_IMPORT',
      payload: { version: 1, backupFileAt: Date.now(), count: 1, words: [{ word: 'legacyword', lang: 'en', translation: '老格式' }] }
    });
    check('兼容旧版只含生词本的导出文件', legacyImport.ok === true && legacyImport.result.vocab.added === 1, JSON.stringify(legacyImport.result?.vocab));

    /* 设置页上的同步卡片 */
    await optionsPage.reload({ waitUntil: 'networkidle2' });
    await sleep(800);
    const syncUi = await optionsPage.evaluate(() => {
      const el = (id) => document.getElementById(id);
      return {
        hasCard: Boolean(el('syncEnabled')),
        bodyHidden: el('syncBody').hidden,
        backend: el('syncBackend').value,
        url: el('syncWebdavUrl').value,
        passPlaceholder: el('syncWebdavPass').type,
        passState: el('syncWebdavPassState').textContent.trim(),
        stateText: el('syncStateDetail').textContent.trim()
      };
    });
    check('设置页有同步卡片，未启用时折叠', syncUi.hasCard && syncUi.bodyHidden === true, `backend=${syncUi.backend}`);
    check('回显 WebDAV 地址但不回显密码', syncUi.url.includes('/dav/') && syncUi.passPlaceholder === 'password', syncUi.url);
    check('已存的密码显示为"已设置"', syncUi.passState.includes('已设置'), syncUi.passState);
    check('显示上次同步时间', syncUi.stateText.includes('上次同步'), syncUi.stateText);

    await optionsPage.evaluate(() => {
      document.getElementById('syncEnabled').checked = true;
      document.getElementById('syncEnabled').dispatchEvent(new Event('change'));
    });
    await sleep(500);
    const expanded = await optionsPage.evaluate(() => ({
      bodyHidden: document.getElementById('syncBody').hidden,
      gistHidden: document.getElementById('syncGist').hidden
    }));
    check('启用后展开配置区，且只显示当前后端的字段', expanded.bodyHidden === false && expanded.gistHidden === true, JSON.stringify(expanded));
    // 设置页整页已经很长，整页截图在忙的机器上会超时；滚到同步卡片拍一张视口截图，又快又是要看的那块
    await optionsPage.evaluate(() => document.getElementById('syncEnabled').closest('section').scrollIntoView());
    await sleep(300);
    await shot(optionsPage, '21-options-sync.png');

    await askBackground(optionsPage, { type: 'SYNC_SAVE_CONFIG', config: { enabled: false }, creds: {} });
    await askBackground(optionsPage, { type: 'VOCAB_CLEAR' });

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
    await shot(vocabPage, '16-vocab-list.png', { fullPage: true });

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
    await shot(vocabPage, '17-vocab-review.png');

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
