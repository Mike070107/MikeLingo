const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  global.chrome = { runtime: { getManifest: () => ({ name: 'MikeLingo', key: 'current-key' }) } };
  global.DST = { extensionsPageUrl: () => 'chrome://extensions' };
  const source = fs.readFileSync('MikeLingo/src/options/updater.js', 'utf8').replace("import { readZip } from '../common/zip.js';", 'const readZip = () => {};');
  const updater = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const dir = { name: 'MikeLingo', getFileHandle: async () => ({ getFile: async () => ({ text: async () => JSON.stringify({ name: 'MikeLingo', key: 'other-key' }) }) }), async *entries() {} };
  await assert.rejects(updater.resolveInstallDir(dir), /manifest|签名/);
  console.log('PASS 同名但不同身份的扩展目录必须拒绝');
  const html = fs.readFileSync('MikeLingo/src/options/options.html', 'utf8');
  assert.match(html, /id="downloadUpdate"/);
  assert.match(html, /id="manualUpdateHelp"/);
  console.log('PASS 下载更新包和手动更新说明独立于目录授权');
})().catch(err => { console.error(err.message); process.exitCode = 1; });
