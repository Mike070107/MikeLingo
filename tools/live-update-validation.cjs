const puppeteer = require('puppeteer');
const path = require('node:path');
const readline = require('node:readline');

(async () => {
  const from = process.argv[2];
  const to = process.argv[3];
  if (!from || !to) throw new Error('usage: node tools/live-update-validation.cjs <from> <to>');
  const extensionPath = path.resolve('MikeLingo');
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    const workerTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('hkoknpdlmemnbllkdijbcdbkkcmpljmf'), { timeout: 15000 });
    const extensionId = new URL(workerTarget.url()).host;
    const optionsUrl = `chrome-extension://${extensionId}/src/options/options.html#settings-7`;
    const page = await browser.newPage();
    await page.goto(optionsUrl);
    const loaded = await page.evaluate(() => chrome.runtime.getManifest().version);
    if (loaded !== from) throw new Error(`expected starting v${from}, got v${loaded}`);
    console.log(`READY v${loaded} ${optionsUrl}`);
    await new Promise(resolve => readline.createInterface({ input: process.stdin, output: process.stdout }).question('', resolve));

    await page.click('.settings-nav a[href="#settings-7"]');
    await page.click('#checkUpdate');
    await page.waitForFunction(expected => !document.querySelector('#updateBox').hidden && document.querySelector('#updateVersion').textContent.includes(expected), { timeout: 30000 }, to);
    console.log('DISCOVERED ' + await page.$eval('#updateVersion', el => el.textContent.trim()));
    await page.click('#installUpdate');
    await page.waitForFunction(expected => document.querySelector('#updateResult').textContent.includes(`v${expected}`), { timeout: 120000 }, to);
    console.log('INSTALLED ' + await page.$eval('#updateResult', el => el.textContent.trim()));
    await new Promise(resolve => setTimeout(resolve, 3500));

    const verify = await browser.newPage();
    await verify.goto(optionsUrl);
    const result = await verify.evaluate(() => ({
      version: chrome.runtime.getManifest().version,
      title: document.querySelector('h1')?.textContent.trim() || '',
      updateAction: document.querySelector('#installUpdate')?.textContent.trim() || ''
    }));
    if (result.version !== to) throw new Error(`expected installed v${to}, got v${result.version}`);
    if (!result.updateAction.includes('立即更新')) throw new Error('更新页主操作缺失');
    console.log('VERIFIED ' + JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
