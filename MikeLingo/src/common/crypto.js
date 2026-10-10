/**
 * 端到端加密：API Key 上云之前先在本机加密，云端只拿得到密文。
 *
 * 为什么必须加密：扩展对用户的承诺是「密钥不出本机」。要把密钥同步到网盘就破坏了这条，
 * 唯一等价的补偿是**云端永远看不到明文**——主口令只留在本机，网盘方、GitHub、
 * 以及任何拿到那个文件的人，没有口令都解不开。
 *
 * PBKDF2-SHA256 + AES-256-GCM，参数写进密文头，将来换算法也能解开老文件。
 * 迭代次数取 OWASP 2023 对 PBKDF2-SHA256 的建议值 310000。
 */

export const KDF_ITERATIONS = 310000;
export const CIPHER_ALG = 'AES-GCM-256';
export const KDF_ALG = 'PBKDF2-SHA256';

/* ------------------------------ base64 编解码 ------------------------------ */

function toBase64(bytes) {
  let bin = '';
  // 一次 apply 传几十万个参数会爆栈，分块拼
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(text) {
  const bin = atob(String(text || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* -------------------------------- 密钥派生 -------------------------------- */

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* --------------------------------- 加解密 --------------------------------- */

/** 把任意可 JSON 化的对象加密成一个自描述的信封（可直接放进备份文件） */
export async function encryptJson(value, passphrase) {
  const pass = String(passphrase || '');
  if (!pass) throw new Error('没有设置主口令，无法加密');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, KDF_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));

  return {
    alg: CIPHER_ALG,
    kdf: KDF_ALG,
    iter: KDF_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(cipher)
  };
}

/**
 * 解开 encryptJson 的信封。口令不对时 AES-GCM 的校验会失败（抛 OperationError），
 * 这里换成用户看得懂的话——这也是唯一能区分"口令错"和"文件坏"的地方。
 */
export async function decryptJson(envelope, passphrase) {
  const pass = String(passphrase || '');
  if (!pass) throw new Error('没有设置主口令，无法解密');
  if (!envelope || typeof envelope !== 'object' || !envelope.data) {
    throw new Error('密文格式不对，缺少 data 字段');
  }
  if (envelope.alg && envelope.alg !== CIPHER_ALG) {
    throw new Error(`不认识的加密算法 ${envelope.alg}，可能是更新版本写出的文件`);
  }

  const iter = Number(envelope.iter) || KDF_ITERATIONS;
  let key;
  try {
    key = await deriveKey(pass, fromBase64(envelope.salt), iter);
  } catch {
    throw new Error('密文的盐值损坏，无法解密');
  }

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
      key,
      fromBase64(envelope.data)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('解出来的内容不是合法 JSON，文件可能已损坏');
    throw new Error('主口令不对，或这份密文已损坏');
  }
}

/** 认出一个字段是不是加密信封（备份文件里的 secrets 可能是明文缺省的 null） */
export function isEnvelope(value) {
  return Boolean(value && typeof value === 'object' && value.data && value.iv && value.salt);
}
