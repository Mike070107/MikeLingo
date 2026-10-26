const { spawn } = require('node:child_process');
const path = require('node:path');

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('usage: node tools/invoke-native-updater.cjs <version>');
const exe = path.join(process.env.LOCALAPPDATA, 'MikeLingoUpdater', 'MikeLingoUpdater.exe');
const request = Buffer.from(JSON.stringify({
  action: 'install',
  version,
  assetName: `MikeLingo-v${version}.zip`,
  assetUrl: `https://github.com/Mike070107/MikeLingo/releases/download/v${version}/MikeLingo-v${version}.zip`
}));
const header = Buffer.alloc(4);
header.writeUInt32LE(request.length);
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const chunks = [];
child.stdout.on('data', chunk => chunks.push(chunk));
child.on('exit', code => {
  const output = Buffer.concat(chunks);
  if (code !== 0 || output.length < 4) throw new Error(`native updater exited ${code}`);
  const length = output.readUInt32LE(0);
  const reply = JSON.parse(output.subarray(4, 4 + length).toString('utf8'));
  console.log(JSON.stringify(reply));
  if (!reply.ok) process.exitCode = 1;
});
child.stdin.end(Buffer.concat([header, request]));
