const puppeteer = require('puppeteer');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
(async () => {
  const port = Number(process.env.MIKELINGO_UI_TEST_PORT) || 18788;
  const server = spawn(process.execPath, ['tools/mock-server.cjs', String(port)], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试服务启动超时')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}`)); });
  });
  const ext = path.resolve('MikeLingo');
  const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  try {
    const target = await browser.waitForTarget(t => t.type() === 'service_worker');
    const origin = `chrome-extension://${new URL(target.url()).host}`;
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/src/options/options.html`);
    await page.waitForSelector('.p-models');
    fs.mkdirSync('tools/screenshots/redesign', { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewport({ width, height: 900 });
      for (let i=0;i<8;i++) {
        await page.click(`.settings-nav a[href="#settings-${i}"]`);
        await page.waitForFunction(id => !document.getElementById(id).hidden, {}, `settings-${i}`);
        const state = await page.evaluate(() => ({ visible: document.querySelectorAll('main > .card:not([hidden])').length, overflow: document.documentElement.scrollWidth > innerWidth }));
        assert.equal(state.visible, 1);
        assert.equal(state.overflow, false, `分类 ${i} 在 ${width}px 溢出`);
      }
      await page.click('.settings-nav a[href="#settings-0"]');
      await page.waitForFunction(() => !document.getElementById('settings-0').hidden);
      if (width === 390) {
        await page.$eval('#addProvider', el => el.scrollIntoView({ block:'center' }));
        await page.screenshot({ path: 'tools/screenshots/redesign/narrow-bottom.png' });
        const reachable = await page.$eval('#addProvider', el => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
        });
        assert.equal(reachable,true,'窄屏底部添加按钮被遮挡');
        await page.evaluate(() => scrollTo(0,0));
      }
      await page.screenshot({ path: `tools/screenshots/redesign/settings-${width}.png`, fullPage: true });
    }
    await page.type('.p-key', 'temporary-unsaved');
    await page.click('.settings-nav a[href="#settings-2"]');
    await page.click('.settings-nav a[href="#settings-0"]');
    assert.equal(await page.$eval('.p-key', el => el.value), 'temporary-unsaved');
    await page.$eval('.p-key', el => el.value = '');
    await page.select('#presetSelect','qwen-mt');
    await page.click('#addProvider');
    await page.waitForFunction(() => document.querySelectorAll('.provider').length === 2);
    assert.equal(await page.$eval('.provider:last-child .p-models',el => el.value),'qwen-mt-flash');
    await page.type('.provider:last-child .p-key','test-only-key');
    await page.click('.provider:last-child .p-save');
    await page.waitForFunction(() => document.getElementById('saveStatus').textContent.includes('设置已保存'));
    await page.reload();
    await page.waitForSelector('.provider:last-child .p-models');
    assert.equal(await page.$eval('.provider:last-child .p-models',el => el.value),'qwen-mt-flash');
    const worker = await target.worker();
    await worker.evaluate(port => chrome.storage.local.set({ updateApiBase: `http://127.0.0.1:${port}` }), port);
    await page.click('.settings-nav a[href="#settings-7"]');
    await page.evaluate(() => { document.getElementById('updateRepo').value = 'mock/v99.0.0'; document.getElementById('checkUpdate').click(); });
    await page.waitForFunction(() => !document.getElementById('updateBox').hidden);
    await page.click('#installUpdate');
    await page.waitForFunction(() => document.getElementById('updateResult').textContent.includes('直接更新失败'));
    assert.equal(await page.$eval('#updateFallback', el => el.open), true);
    await page.click('#downloadUpdate');
    await page.waitForFunction(() => document.getElementById('updateProgress').textContent.includes('尚未完成安装'));
    await page.screenshot({ path: 'tools/screenshots/redesign/update-recovery.png', fullPage: true });
    await page.goto(`${origin}/src/popup/popup.html`);
    await page.setViewport({ width:380, height:800 });
    await page.waitForSelector('#providerSelect option');
    await page.screenshot({ path: 'tools/screenshots/redesign/popup.png', fullPage:true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('PASS 8 分类 × 桌面/390px，输入保留，本机助手失败后可下载，弹窗无溢出，无页面异常');
  } finally { await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exitCode=1; });
