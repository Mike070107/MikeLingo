const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
(async () => {
  const source = fs.readFileSync('MikeLingo/src/common/zip.js','utf8');
  const { readZip } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const manifest = JSON.parse(fs.readFileSync('MikeLingo/manifest.json'));
  const zip = fs.readFileSync(`Release/v${manifest.version}/MikeLingo-v${manifest.version}.zip`);
  const files = await readZip(zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.byteLength));
  const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry => entry.isDirectory() ? walk(path.join(dir,entry.name)) : [path.join(dir,entry.name)]);
  const expected = ['MikeLingo/manifest.json',...walk('MikeLingo/src'),...walk('MikeLingo/icons')];
  assert.equal(files.size,expected.length);
  for(const file of expected) {
    const relative = path.relative('MikeLingo',file).split(path.sep).join('/');
    assert.deepEqual(Buffer.from(files.get(relative)),fs.readFileSync(file),relative);
  }
  assert.equal(JSON.parse(fs.readFileSync('package.json')).version,manifest.version);
  console.log(`PASS v${manifest.version} ZIP 的 ${files.size} 个文件与当前源码逐字节一致`);
  console.log(`SHA256 ${crypto.createHash('sha256').update(zip).digest('hex')}`);
})().catch(e => { console.error(e.message); process.exitCode=1; });
