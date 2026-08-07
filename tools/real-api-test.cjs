/**
 * 用真实 DeepSeek 接口验证翻译效果。
 * 密钥通过环境变量传入，不写入任何文件：
 *   $env:DEEPSEEK_API_KEY="sk-..."; node tools/real-api-test.cjs
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const EXT_PATH = path.join(__dirname, '..', 'MikeLingo');
const SHOT_DIR = path.join(__dirname, 'screenshots');
const PORT = 8790;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!API_KEY) {
  console.error('缺少环境变量 DEEPSEEK_API_KEY');
  process.exit(1);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-server.cjs'), String(PORT)], { stdio: 'ignore' });
  await sleep(700);

  const browser = await puppeteer.launch({
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 860 }
  });

  const target = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const worker = await target.worker();
  await sleep(1000);

  await worker.evaluate(async (key) => {
    await chrome.storage.sync.set({
      settings: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        displayMode: 'inline',
        temperature: 1.3,
        concurrency: 3,
        batchSize: 10,
        cacheEnabled: true,
        selectionEnabled: true,
        selectionTrigger: 'instant'
      }
    });
    await chrome.storage.local.set({ apiKey: key });
  }, API_KEY);

  // 1. 直连接口自检
  const test = await worker.evaluate(async () => {
    const started = Date.now();
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${(await chrome.storage.local.get('apiKey')).apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'Translate to Chinese: hello world' }],
          stream: false
        })
      });
      const text = await res.text();
      return { status: res.status, ms: Date.now() - started, body: text.slice(0, 300) };
    } catch (err) {
      return { error: String(err), ms: Date.now() - started };
    }
  });
  console.log('接口自检:', JSON.stringify(test, null, 2));

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/test.html`, { waitUntil: 'domcontentloaded' });
  await sleep(600);

  const started = Date.now();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
  });

  let translations = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    translations = await page.evaluate(() =>
      Array.from(document.querySelectorAll('dst-trans')).map((n) => n.textContent)
    );
    const state = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATE' });
    });
    if (state?.state?.error) {
      console.log('翻译报错:', state.state.error);
      break;
    }
    if (state?.state?.total > 0 && state.state.done >= state.state.total && state.state.running === 0) break;
  }

  console.log(`\n用时 ${((Date.now() - started) / 1000).toFixed(1)}s，共 ${translations.length} 段译文：`);
  translations.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  const hud = await page.evaluate(
    () => document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.hud')?.textContent?.replace(/\s+/g, ' ').trim()
  );
  console.log('HUD:', hud);
  await page.screenshot({ path: path.join(SHOT_DIR, 'real-1-inline.png'), fullPage: true });

  // 2. 划词翻译
  await page.evaluate(() => {
    const node = document.querySelector('#tail');
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await sleep(6000);
  const card = await page.evaluate(
    () => document.querySelector('.dst-ui')?.shadowRoot?.querySelector('.card-body')?.textContent?.replace(/\s+/g, ' ').trim()
  );
  console.log('划词卡片:', card);
  await page.screenshot({ path: path.join(SHOT_DIR, 'real-2-selection.png') });

  // 3. 左右并列
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    const s = (await chrome.storage.sync.get('settings')).settings;
    await chrome.storage.sync.set({ settings: Object.assign({}, s, { displayMode: 'columns' }) });
    await new Promise((r) => setTimeout(r, 300));
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
  });
  await sleep(8000);
  await page.screenshot({ path: path.join(SHOT_DIR, 'real-3-columns.png'), fullPage: true });
  console.log('页面 JS 错误:', errors.length ? errors : '无');

  await browser.close();
  mock.kill();
})();
