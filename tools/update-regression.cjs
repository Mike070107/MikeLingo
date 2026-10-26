const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  let sent = null;
  global.chrome = { runtime: {
    getManifest: () => ({ name: 'MikeLingo', key: 'current-key' }),
    sendNativeMessage: async (host, message) => { sent = { host, message }; return { ok: true, version: message.version }; }
  } };
  global.DST = { extensionsPageUrl: () => 'chrome://extensions', compareVersions: (a, b) => a.localeCompare(b, undefined, { numeric: true }) };
  const source = fs.readFileSync('MikeLingo/src/options/updater.js', 'utf8').replace("import { readZip } from '../common/zip.js';", 'const readZip = () => {};');
  const updater = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const dir = { name: 'MikeLingo', getFileHandle: async () => ({ getFile: async () => ({ text: async () => JSON.stringify({ name: 'MikeLingo', key: 'other-key' }) }) }), async *entries() {} };
  await assert.rejects(updater.resolveInstallDir(dir), /manifest|签名/);
  console.log('PASS 同名但不同身份的扩展目录必须拒绝');
  await updater.installWithNativeHost({ version: '1.13.0', assetUrl: 'https://github.com/Mike070107/MikeLingo/releases/download/v1.13.0/MikeLingo-v1.13.0.zip', assetName: 'MikeLingo-v1.13.0.zip' });
  assert.equal(sent.host, 'com.mikelingo.updater');
  assert.equal(sent.message.version, '1.13.0');
  console.log('PASS 直接更新交给固定的本机助手');
  const html = fs.readFileSync('MikeLingo/src/options/options.html', 'utf8');
  assert.match(html, /id="downloadUpdate"/);
  assert.match(html, /id="updateFallback"/);
  console.log('PASS 下载更新包和手动更新说明独立于目录授权');
  assert.match(html, /id="installUpdate"[^>]*>\s*立即更新\s*</);
  assert.match(html, /<details[^>]+id="updateFallback"/);
  const mainActions = html.match(/<div class="actions-row update-primary-actions">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(mainActions, /id="installUpdate"/);
  assert.doesNotMatch(mainActions, /id="downloadUpdate"|id="pickDir"/);
  console.log('PASS 正常更新只暴露一个「立即更新」主操作');
  assert.match(html, /检查更新[^]*立即更新[^]*等待页面自动刷新/);
  assert.match(html, /不用下载、解压或选择安装目录/);
  console.log('PASS 用户点击前就能看到完整三步操作与免手工说明');
})().catch(err => { console.error(err.message); process.exitCode = 1; });
