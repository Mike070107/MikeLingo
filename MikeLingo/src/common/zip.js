/**
 * 极简 ZIP 解包，只为读自己 tools/pack.cjs 打出来的发布包。
 *
 * 不引第三方库：解压直接用浏览器原生的 DecompressionStream('deflate-raw')，
 * 扩展里塞一个 zip 库既增加体积，也让"这段代码到底干了什么"变得不好审。
 *
 * 支持存储（method 0）和 deflate（method 8）两种，够用了——发布包只会有这两种。
 * 不支持 zip64、加密、分卷：遇到就明确报错，而不是解出半截数据。
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 从尾部往前找 EOCD（末尾可能有注释，所以不能只看最后 22 字节） */
function findEocd(view, size) {
  const maxComment = 0xffff;
  const start = Math.max(0, size - 22 - maxComment);
  for (let i = size - 22; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 解出 { 路径: Uint8Array }。路径统一用正斜杠，与打包时写入的一致。
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const size = bytes.length;
  if (size < 22) throw new Error('压缩包内容不完整');

  const eocd = findEocd(view, size);
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录）');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('不支持 zip64 格式的压缩包');

  const decoder = new TextDecoder('utf-8');
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) throw new Error('压缩包中央目录已损坏');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const originalSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

    if (flags & 0x1) throw new Error(`压缩包已加密，无法读取：${name}`);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // 目录项没有内容

    // 数据的真实位置要从本地头再算一次：本地头的 extra 长度可能与中央目录里的不同
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) throw new Error(`条目头损坏：${name}`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let content;
    if (method === 0) content = raw.slice();
    else if (method === 8) content = await inflateRaw(raw);
    else throw new Error(`不支持的压缩方式 ${method}：${name}`);

    if (content.length !== originalSize) throw new Error(`解压后大小不符：${name}`);
    files.set(name, content);
  }

  if (!files.size) throw new Error('压缩包里没有任何文件');
  return files;
}
