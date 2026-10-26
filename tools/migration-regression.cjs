// 用隔离浏览器资料验证：同一固定 ID 换目录加载，设置与本地数据仍可读取。
const puppeteer = require('puppeteer');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve('tools/screenshots');
  fs.mkdirSync(root, { recursive:true });
  const temp = fs.mkdtempSync(path.join(root, 'migration-'));
  let browser;
  try {
    for (const folder of ['old','new']) fs.cpSync(path.resolve('MikeLingo'), path.join(temp,folder), { recursive:true });
    const launch = async folder => {
      const ext = path.join(temp,folder);
      browser = await puppeteer.launch({ headless:true, userDataDir:path.join(temp,'profile'), args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`] });
      const target = await browser.waitForTarget(t => t.type()==='service_worker' && t.url().includes('/src/background/service-worker.js'));
      const id = new URL(target.url()).host;
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${id}/src/options/options.html`);
      await page.waitForSelector('.p-models');
      return { worker: page, id };
    };
    const first = await launch('old');
    await first.worker.evaluate(async () => {
      await chrome.storage.local.set({ migrationProbe:'saved-data', apiKeys:{ deepseek:'test-only-key' } });
      await chrome.storage.sync.set({ migrationPreference:'English' });
    });
    await browser.close();
    const second = await launch('new');
    assert.equal(first.id,second.id);
    const data = await second.worker.evaluate(async () => ({ local:await chrome.storage.local.get(['migrationProbe','apiKeys']), sync:await chrome.storage.sync.get('migrationPreference') }));
    assert.equal(data.local.migrationProbe,'saved-data');
    assert.equal(data.local.apiKeys.deepseek,'test-only-key');
    assert.equal(data.sync.migrationPreference,'English');
    console.log('PASS 同一扩展 ID 在普通新目录重新加载后，本地密钥与同步设置仍在');
  } finally {
    if(browser) await browser.close();
    if(path.dirname(temp) !== root) throw new Error('临时目录越界');
    fs.rmSync(temp,{ recursive:true,force:true });
  }
})().catch(e => { console.error(e); process.exitCode=1; });
