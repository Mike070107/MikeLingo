/**
 * 同步后端适配器：把「读一个文件 / 写一个文件」这件事，对 WebDAV 和 GitHub Gist 各实现一遍。
 *
 * 上层（sync.js）只认这个接口，不关心是哪家：
 *   read()            → { exists, text, rev }
 *   write(text, rev)  → { rev, extra }        rev 用来做乐观锁
 *
 * 为什么不自己开服务器：这样不需要备案域名、不需要账号体系、不需要替用户保管任何东西，
 * 数据落在用户自己的网盘 / GitHub 账号里，扩展只是个搬运工。
 *
 * 报错一律带上服务端返回的原文（截断到 300 字），"同步失败"这种话解决不了任何问题。
 */

export const REMOTE_FILENAME = 'mikelingo-sync.json';

const GITHUB_API = 'https://api.github.com';

/** 测试时把 GitHub 指到本地假接口，正常使用时为空 */
async function gistApiBase() {
  try {
    const stored = await chrome.storage.local.get('syncApiBase');
    const base = String(stored.syncApiBase || '').trim().replace(/\/+$/, '');
    return base || GITHUB_API;
  } catch {
    return GITHUB_API;
  }
}

/** 服务端的错误正文才是有用的信息（401 密码错、403 配额、507 空间满……） */
async function describeHttpError(res, prefix) {
  let body = '';
  try {
    body = (await res.text()).trim().slice(0, 300);
  } catch {
    /* 正文读不出来就只报状态码 */
  }
  // GitHub 返回 JSON，把 message 抽出来比整段 JSON 好读
  try {
    const parsed = JSON.parse(body);
    if (parsed?.message) body = parsed.message;
  } catch {
    /* 不是 JSON 就按原文 */
  }
  return new Error(`${prefix}：HTTP ${res.status}${body ? ` — ${body}` : ''}`);
}

/* --------------------------------- WebDAV --------------------------------- */

/**
 * 用户填的可能是目录（`https://dav.jianguoyun.com/dav/`）也可能是完整文件路径。
 * 统一补成文件路径，省得他还要理解我们把文件放哪。
 */
export function webdavFileUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) throw new Error('没有填写 WebDAV 服务器地址');
  if (!/^https?:\/\//i.test(url)) throw new Error('WebDAV 地址要以 http:// 或 https:// 开头');
  if (/\.json$/i.test(url)) return url;
  return `${url.replace(/\/+$/, '')}/${REMOTE_FILENAME}`;
}

/** Basic 认证头。用户名/密码可能有中文，直接 btoa 会抛 InvalidCharacterError */
function basicAuth(user, pass) {
  const raw = `${user || ''}:${pass || ''}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

function webdavAdapter(config, creds) {
  const url = webdavFileUrl(config?.webdav?.url);
  const headers = { Authorization: basicAuth(config?.webdav?.user, creds?.webdavPass) };

  return {
    label: 'WebDAV',
    location: url,

    async read() {
      const res = await fetch(url, { method: 'GET', headers, cache: 'no-store' });
      if (res.status === 404) return { exists: false, text: '', rev: '' };
      if (res.status === 401) throw new Error('WebDAV 认证失败（401），检查用户名和应用密码');
      if (!res.ok) throw await describeHttpError(res, 'WebDAV 读取失败');
      return { exists: true, text: await res.text(), rev: res.headers.get('ETag') || '' };
    },

    async write(text, rev) {
      const putHeaders = { ...headers, 'Content-Type': 'application/json; charset=utf-8' };
      // 乐观锁：有 rev 就要求远端还是那一版，没有就要求"这个文件还不存在"
      if (rev) putHeaders['If-Match'] = rev;
      else putHeaders['If-None-Match'] = '*';

      let res = await fetch(url, { method: 'PUT', headers: putHeaders, body: text });

      // 412 = 远端在我们读完之后被别的设备改了，交给上层重新合并
      if (res.status === 412 || res.status === 409) {
        const err = new Error('远端在本次同步期间被另一台设备改过');
        err.code = 'CONFLICT';
        throw err;
      }
      if (res.status === 401) throw new Error('WebDAV 认证失败（401），检查用户名和应用密码');
      if (res.status === 507) throw new Error('WebDAV 空间不足（507）');
      if (!res.ok) throw await describeHttpError(res, 'WebDAV 写入失败');

      // 不是所有服务端都在 PUT 响应里回 ETag，缺了就再读一次头，免得下次同步锁不住
      let nextRev = res.headers.get('ETag') || '';
      if (!nextRev) {
        try {
          const head = await fetch(url, { method: 'HEAD', headers });
          nextRev = head.headers.get('ETag') || '';
        } catch {
          /* 拿不到 ETag 只是少一层保护，不该让同步失败 */
        }
      }
      return { rev: nextRev, extra: null };
    }
  };
}

/* ------------------------------- GitHub Gist ------------------------------ */

function gistAdapter(config, creds) {
  const token = String(creds?.gistToken || '').trim();
  if (!token) throw new Error('没有填写 GitHub Token');
  const id = String(config?.gist?.id || '').trim();

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  return {
    label: 'GitHub Gist',
    location: id ? `gist ${id}` : '（首次同步时自动创建一个私密 Gist）',

    async read() {
      if (!id) return { exists: false, text: '', rev: '' };
      const base = await gistApiBase();
      const res = await fetch(`${base}/gists/${encodeURIComponent(id)}`, { headers, cache: 'no-store' });
      if (res.status === 404) return { exists: false, text: '', rev: '' };
      if (res.status === 401) throw new Error('GitHub Token 无效或已过期（401）');
      if (res.status === 403) throw await describeHttpError(res, 'GitHub 拒绝访问');
      if (!res.ok) throw await describeHttpError(res, 'Gist 读取失败');

      const data = await res.json();
      const file = data?.files?.[REMOTE_FILENAME];
      if (!file) return { exists: false, text: '', rev: data?.updated_at || '' };
      // 超过 1MB 的文件 GitHub 只给 raw_url，content 会被截断
      let text = file.content || '';
      if (file.truncated && file.raw_url) {
        const raw = await fetch(file.raw_url, { headers, cache: 'no-store' });
        if (!raw.ok) throw await describeHttpError(raw, 'Gist 大文件读取失败');
        text = await raw.text();
      }
      return { exists: true, text, rev: data?.updated_at || '' };
    },

    async write(text) {
      const base = await gistApiBase();
      const body = {
        description: 'MikeLingo 同步数据（生词本 / 设置 / 已加密的 API Key）',
        files: { [REMOTE_FILENAME]: { content: text } }
      };
      const res = id
        ? await fetch(`${base}/gists/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          })
        : await fetch(`${base}/gists`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, public: false })
          });

      if (res.status === 401) throw new Error('GitHub Token 无效或已过期（401）');
      if (res.status === 404 && id) throw new Error(`找不到 Gist ${id}，可能已被删除或 Token 没有 gist 权限`);
      if (!res.ok) throw await describeHttpError(res, 'Gist 写入失败');

      const data = await res.json();
      // 首次是新建：把生成的 id 交回上层存下来，用户不用自己去复制
      return { rev: data?.updated_at || '', extra: id ? null : { gistId: data?.id || '' } };
    }
  };
}

/* --------------------------------- 出口 --------------------------------- */

export function createRemote(config, creds) {
  const backend = config?.backend === 'gist' ? 'gist' : 'webdav';
  return backend === 'gist' ? gistAdapter(config, creds) : webdavAdapter(config, creds);
}
