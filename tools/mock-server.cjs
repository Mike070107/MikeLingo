/**
 * 本地联调用的假 DeepSeek 接口 + 测试页面，仅用于自动化验证，不属于扩展本体。
 * 用法：node tools/mock-server.cjs [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildZip } = require('./zip-writer.cjs');

const PORT = Number(process.argv[2] || 8787);

const TEST_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Translation Test Page</title>
<style>
  body { font-family: Georgia, serif; max-width: 720px; margin: 40px auto; line-height: 1.7; color: #1f2937; }
  code, pre { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
  .card { border: 1px solid #e5e7eb; padding: 16px; border-radius: 8px; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 8px; }
</style></head>
<body>
  <h1>The quiet rise of on-device machine learning</h1>
  <p id="p1">Large language models are changing how people read the web. Instead of switching tabs, readers now expect translation to appear right next to the original text.</p>
  <p id="p2">This paragraph contains <b>bold text</b> and an <a href="#">inline link</a> so that the extractor has to merge several text nodes into one segment.</p>
  <h2>Why latency matters</h2>
  <ul>
    <li>Requests should be batched to reduce round trips.</li>
    <li>Only visible paragraphs are translated first.</li>
  </ul>
  <div class="card">
    <p>Nested block inside a card element, which should still be translated correctly.</p>
  </div>
  <p id="cn">这一段本来就是中文，不应该被重复翻译。</p>
  <p id="word">pronunciation</p>
  <p id="noword">zzznotaword</p>
  <pre id="code">const answer = translate("hello world");</pre>
  <table><tr><th>Region</th><td>Latency budget</td></tr></table>
  <p id="tail">A final sentence to verify that scrolling content is picked up as well.</p>
</body></html>`;

function translateSegment(text) {
  return `【译文】${text}`;
}

/** 0.15 秒静音 WAV，用来验证"真人发音音频"这条链路能真的播出来 */
function silentWav() {
  const sampleRate = 8000;
  const samples = Math.round(sampleRate * 0.15);
  const data = Buffer.alloc(samples * 2); // 16bit 静音
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 仿 dictionaryapi.dev 的返回结构：phonetics 是混杂数组，音频按 -uk / -us 区分口音 */
function dictEntry(word, origin) {
  return [
    {
      word,
      phonetic: `/${word}-ipa/`,
      phonetics: [
        { text: `/${word}-ipa/`, audio: '' },
        { text: `/${word}-uk/`, audio: `${origin}/audio/${word}-uk.wav` },
        { text: `/${word}-us/`, audio: `${origin}/audio/${word}-us.wav` }
      ],
      meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: `mock definition of ${word}` }] }]
    }
  ];
}

/* --------------------------- 假 WebDAV / 假 Gist --------------------------- */

/** 假 WebDAV：内存里的一张 路径 → { text, etag } 表，支持 If-Match / If-None-Match 乐观锁 */
const davFiles = new Map();
const DAV_USER = 'mikeuser';
const DAV_PASS = 'mikepass';
let davRevSeq = 0;
/** 路径里带 conflict-once 的文件，第一次 PUT 固定回 412，用来验证冲突重试真的会重来一遍 */
const davConflictArmed = new Set();

/** 假 Gist：id → { files, updated_at }，Token 必须像个 GitHub token */
const gists = new Map();
let gistSeq = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function sendJson(res, code, obj, headers = {}) {
  const text = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

async function handleDav(req, res, url) {
  const auth = req.headers.authorization || '';
  const expect = 'Basic ' + Buffer.from(`${DAV_USER}:${DAV_PASS}`).toString('base64');
  if (auth !== expect) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Unauthorized');
  }

  const key = url.pathname;
  const existing = davFiles.get(key);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!existing) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: existing.etag });
    return res.end(req.method === 'HEAD' ? undefined : existing.text);
  }

  if (req.method === 'PUT') {
    const body = await readBody(req);
    if (key.includes('conflict-once') && davConflictArmed.has(key)) {
      davConflictArmed.delete(key); // 只挡一次，重试就该成功
      res.writeHead(412, { 'Content-Type': 'text/plain' });
      return res.end('Precondition Failed');
    }
    const ifMatch = req.headers['if-match'];
    const ifNone = req.headers['if-none-match'];
    if (ifMatch && (!existing || existing.etag !== ifMatch)) {
      res.writeHead(412, { 'Content-Type': 'text/plain' });
      return res.end('Precondition Failed');
    }
    if (ifNone === '*' && existing) {
      res.writeHead(412, { 'Content-Type': 'text/plain' });
      return res.end('Precondition Failed');
    }
    const etag = `"w${++davRevSeq}"`;
    davFiles.set(key, { text: body, etag });
    res.writeHead(existing ? 204 : 201, { ETag: etag });
    return res.end();
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  return res.end('Method Not Allowed');
}

async function handleGist(req, res, url) {
  const auth = req.headers.authorization || '';
  if (!/^Bearer (ghp_|github_pat_)/.test(auth)) {
    return sendJson(res, 401, { message: 'Bad credentials' });
  }

  const idMatch = url.pathname.match(/^\/gists\/([^/]+)$/);

  if (req.method === 'GET' && idMatch) {
    const gist = gists.get(idMatch[1]);
    if (!gist) return sendJson(res, 404, { message: 'Not Found' });
    return sendJson(res, 200, { id: idMatch[1], files: gist.files, updated_at: gist.updated_at });
  }

  if (req.method === 'POST' && url.pathname === '/gists') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const id = `mockgist${++gistSeq}`;
    gists.set(id, { files: payload.files || {}, updated_at: new Date().toISOString() });
    return sendJson(res, 201, { id, files: payload.files, updated_at: gists.get(id).updated_at });
  }

  if (req.method === 'PATCH' && idMatch) {
    const gist = gists.get(idMatch[1]);
    if (!gist) return sendJson(res, 404, { message: 'Not Found' });
    const payload = JSON.parse((await readBody(req)) || '{}');
    gist.files = { ...gist.files, ...(payload.files || {}) };
    gist.updated_at = new Date().toISOString();
    return sendJson(res, 200, { id: idMatch[1], files: gist.files, updated_at: gist.updated_at });
  }

  return sendJson(res, 405, { message: 'Method Not Allowed' });
}

/**
 * 限流模拟：把并发和速率卡死，验证扩展的请求闸门能不能自己退避到成功。
 * maxConcurrent：同时超过这么多个在飞的 /chat/completions 就回 429（阿里云百炼那种）
 * minGapMs：两次请求间隔小于这个值也回 429
 */
const rateLimit = { maxConcurrent: 0, minGapMs: 0, active: 0, lastAt: 0, rejected: 0, served: 0 };
let deepl429Seen = false;

const server = http.createServer((req, res) => {
  // MOCK_VERBOSE=1 时打印每个请求，排查"请求到底有没有到服务端"用
  if (process.env.MOCK_VERBOSE) {
    res.on('finish', () => console.log(`[mock] ${req.method} ${req.url} -> ${res.statusCode}`));
  }

  // 同步相关的路由要在最前面拦掉：下面的兜底会把任何非 GET 当成 /chat/completions
  const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (reqUrl.pathname.startsWith('/dav/')) {
    // 测试用的复位入口：每个用例开始前把远端清空，用例之间不互相污染
    if (reqUrl.pathname === '/dav/__reset') {
      davFiles.clear();
      davConflictArmed.clear();
      gists.clear();
      return sendJson(res, 200, { ok: true });
    }
    if (reqUrl.pathname === '/dav/__arm-conflict') {
      davConflictArmed.add(reqUrl.searchParams.get('path') || '');
      return sendJson(res, 200, { ok: true });
    }
    return handleDav(req, res, reqUrl);
  }
  if (reqUrl.pathname === '/__ratelimit') {
    rateLimit.maxConcurrent = Number(reqUrl.searchParams.get('maxConcurrent') || 0);
    rateLimit.minGapMs = Number(reqUrl.searchParams.get('minGapMs') || 0);
    rateLimit.active = 0;
    rateLimit.lastAt = 0;
    rateLimit.rejected = 0;
    rateLimit.served = 0;
    return sendJson(res, 200, { ok: true, ...rateLimit });
  }
  if (reqUrl.pathname === '/__ratelimit/stats') {
    return sendJson(res, 200, { rejected: rateLimit.rejected, served: rateLimit.served });
  }
  if (reqUrl.pathname === '/gists' || reqUrl.pathname.startsWith('/gists/')) {
    return handleGist(req, res, reqUrl);
  }

  if (req.method === 'GET') {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const origin = `http://127.0.0.1:${PORT}`;

    // 假词典接口：/dict/en/<word>，"zzznotaword" 固定 404，用来测查不到的分支
    const dictMatch = url.pathname.match(/^\/dict\/en\/(.+)$/);
    if (dictMatch) {
      const word = decodeURIComponent(dictMatch[1]).toLowerCase();
      if (word === 'zzznotaword') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ title: 'No Definitions Found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(dictEntry(word, origin)));
    }

    // 假有道发音：/dictvoice?audio=<word>&type=1|2
    // 它本质是词典录音，词库里没有的词条和整句都 500——真接口就是这个行为
    if (url.pathname === '/dictvoice') {
      const word = (url.searchParams.get('audio') || '').toLowerCase();
      if (!word || word === 'zzznotaword' || word.split(/\s+/).length > 3) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ msg: 'no audio' }));
      }
      const wav = silentWav();
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': wav.length });
      return res.end(wav);
    }

    // 假百度语音合成：/gettts?lan=<en|zh|jp>&text=...，整句也能读
    if (url.pathname === '/gettts') {
      const text = url.searchParams.get('text') || '';
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ msg: 'empty text' }));
      }
      const wav = silentWav();
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': wav.length });
      return res.end(wav);
    }

    // 假 GitHub Releases 接口：/repos/<owner>/<repo>/releases/latest
    // 版本号从仓库名里取（mock/v99.0.0），这样同一个进程能测多个版本场景；
    // owner 为 norelease 时返回 404，用来测"仓库没发过 Release"的分支。
    const relMatch = url.pathname.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/releases\/latest$/);
    if (relMatch) {
      if (relMatch[1] === 'norelease') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      const version = (relMatch[2].match(/^v?([\d.]+)$/) || [])[1] || '99.0.0';
      const noAsset = relMatch[1] === 'noasset';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          tag_name: `v${version}`,
          html_url: `${origin}/releases/tag/v${version}`,
          body: '- 模拟的更新说明第一条\n- 模拟的更新说明第二条',
          assets: noAsset
            ? [{ name: '说明.txt', browser_download_url: `${origin}/pkg/other.txt`, size: 4 }]
            : [
                {
                  name: `MikeLingo-v${version}.zip`,
                  // 下载地址故意带个查询串：本机安全软件会拦截"路径以 .zip 结尾"的明文 HTTP 请求
                  // （请求根本到不了服务端，Chrome 侧直接变成一个空的 204），加上查询串即可绕开。
                  // 文件名仍是 .zip，资源筛选那段逻辑照样被测到；真实下载走 HTTPS，不受影响。
                  browser_download_url: `${origin}/pkg/MikeLingo-v${version}.zip?e2e=1`,
                  size: 1234
                },
                { name: '别的附件.txt', browser_download_url: `${origin}/pkg/other.txt`, size: 4 }
              ]
        })
      );
    }

    // 假发布包：现场用真实的 MikeLingo/ 目录打一个包，只把 manifest 的版本号换成请求的那个。
    // 这样解包、路径白名单、manifest 校验测的都是真结构，不是手捏的假数据。
    const pkgMatch = url.pathname.match(/^\/pkg\/MikeLingo-v([\d.]+)\.zip$/);
    if (pkgMatch) {
      const extDir = path.join(__dirname, '..', 'MikeLingo');
      const collect = (rel, acc = []) => {
        const abs = path.join(extDir, rel);
        if (fs.statSync(abs).isDirectory()) {
          for (const name of fs.readdirSync(abs).sort()) collect(`${rel}/${name}`, acc);
        } else {
          acc.push({ name: rel.split(path.sep).join('/'), data: fs.readFileSync(abs) });
        }
        return acc;
      };
      const entries = ['manifest.json', 'src', 'icons'].flatMap((e) => collect(e));
      const manifestEntry = entries.find((e) => e.name === 'manifest.json');
      const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
      manifest.version = pkgMatch[1];
      manifestEntry.data = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
      const buf = buildZip(entries);
      // Content-Type 故意用 application/json 而不是 application/zip：
      // 某些安全软件/代理会拦截明文 HTTP 上的二进制响应（application/zip、octet-stream、
      // text/plain 都会被改写成一个空的 204），本地测试就永远下不到包。
      // 更新器不看 Content-Type，只按字节解包，所以这样替换不影响测试的真实性。
      // 真实下载走 GitHub 的 HTTPS，不受这类明文拦截影响。
      // ?ct= 可覆盖，用来复查这台机器的拦截行为。
      res.writeHead(200, {
        'Content-Type': url.searchParams.get('ct') || 'application/json',
        'Content-Length': buf.length
      });
      return res.end(buf);
    }

    // /audio/... 是假 dictionaryapi 的音频；带 -502 的固定失败，用来测音源回落
    if (url.pathname.startsWith('/audio/')) {
      if (url.pathname.includes('-502')) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        return res.end('<html>Bad Gateway</html>');
      }
      const wav = silentWav();
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      return res.end(wav);
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(TEST_PAGE);
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    if (reqUrl.pathname === '/v2/translate') {
      if (auth !== 'DeepL-Auth-Key deepl-mock-key:fx') {
        return sendJson(res, 403, { message: 'Authorization failure, check auth_key' });
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { message: 'Invalid JSON' });
      }
      if (!Array.isArray(payload.text) || !payload.text.length || payload.source_lang) {
        return sendJson(res, 400, { message: 'text[] is required and source_lang must be omitted for auto detection' });
      }
      if (payload.text.includes('__deepl_quota__')) return sendJson(res, 456, { message: 'Quota exceeded' });
      if (payload.text.includes('__deepl_rate_limit__') && !deepl429Seen) {
        deepl429Seen = true;
        return sendJson(res, 429, { message: 'Too many requests' }, { 'Retry-After': '0' });
      }
      return sendJson(res, 200, {
        translations: payload.text.map((text) => ({ detected_source_language: 'EN', text: `【DeepL:${payload.target_lang}】${text}` }))
      });
    }
    if (!/^Bearer sk-/.test(auth)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid' } }));
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid json' } }));
    }

    // 限流模拟要放在业务分支之前：真实服务商也是先按速率拒，再看你请求里写了什么
    if (rateLimit.maxConcurrent || rateLimit.minGapMs) {
      const now = Date.now();
      const tooFast = rateLimit.minGapMs && rateLimit.lastAt && now - rateLimit.lastAt < rateLimit.minGapMs;
      const tooMany = rateLimit.maxConcurrent && rateLimit.active >= rateLimit.maxConcurrent;
      if (tooFast || tooMany) {
        rateLimit.rejected++;
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        return res.end(
          JSON.stringify({
            error: {
              code: 'Throttling.RateQuota',
              message:
                'You have exceeded your current request limit. For details, see: ' +
                'https://help.aliyun.com/zh/model-studio/error-code#rate-limit'
            }
          })
        );
      }
      rateLimit.lastAt = now;
      rateLimit.served++;
      rateLimit.active++;
      res.on('finish', () => {
        rateLimit.active = Math.max(0, rateLimit.active - 1);
      });
    }

    const userContent = payload.messages?.find((m) => m.role === 'user')?.content || '';

    // 模拟通义 qwen-mt：必须带 translation_options，且只按 target_lang 直译
    const isMt = /qwen-mt/i.test(payload.model || '');
    if (isMt && !payload.translation_options) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ error: { code: 'InvalidParameter', message: 'translation_options is required for translation models' } })
      );
    }
    if (payload.translation_options) {
      const hasSystem = (payload.messages || []).some((m) => m.role === 'system');
      const target = payload.translation_options.target_lang;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: 'mock-mt',
          model: payload.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `【MT:${target}${hasSystem ? '+SYS' : ''}】${userContent}` },
              finish_reason: 'stop'
            }
          ],
          usage: { total_tokens: 50 }
        })
      );
    }

    // 词典详解：靠 system 提示词认出来，返回和真实模型一样的 JSON（外面裹一层 ```，
    // 真实模型经常这么干，正好一起验证解析能剥掉代码围栏）
    const systemContent = payload.messages?.find((m) => m.role === 'system')?.content || '';
    if (/bilingual dictionary/i.test(systemContent)) {
      if (/^explainfail\b/i.test(userContent.trim())) {
        // 用来测"模型没按格式返回"的分支
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'mock-explain-bad',
            model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: '抱歉，我无法解释这个词。' }, finish_reason: 'stop' }],
            usage: { total_tokens: 20 }
          })
        );
      }
      const term = userContent.trim();
      const explain = {
        title: term,
        kind: /\s/.test(term) ? 'proper' : 'word',
        summary: `${term} 的模拟释义`,
        senses: [
          { pos: 'n.', meaning: `${term}（模拟词义一）`, detail: `关于 ${term} 的补充说明` },
          { pos: 'v.', meaning: `${term}（模拟词义二）`, detail: '' }
        ],
        examples: [{ src: `This is ${term} in a sentence.`, trans: `这是 ${term} 的例句翻译。` }],
        notes: `${term} 的用法提示`,
        related: [`${term}-related`]
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: 'mock-explain',
          model: payload.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '```json\n' + JSON.stringify(explain) + '\n```' },
              finish_reason: 'stop'
            }
          ],
          usage: { total_tokens: 120 }
        })
      );
    }

    const re = /<seg\s+id="(\d+)">([\s\S]*?)<\/seg>/g;
    const out = [];
    let m;
    while ((m = re.exec(userContent)) !== null) {
      out.push(`<seg id="${m[1]}">${translateSegment(m[2])}</seg>`);
    }
    const content = out.length ? out.join('\n') : translateSegment(userContent);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        model: payload.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { total_tokens: 100 }
      })
    );
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock server on http://127.0.0.1:${PORT}`));
