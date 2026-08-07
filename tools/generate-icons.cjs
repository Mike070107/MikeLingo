/**
 * 生成 MikeLingo 扩展图标。
 *
 * 设计：圆角方块 + 对角渐变（靛蓝 → 青），白色「A」与「文」沿对角错位摆放，
 * 表达「两种语言互译」；「文」带一圈底色描边，与「A」交叠处仍能分开。
 * 16px 下双字形会糊成一团，退回到单个「文」（省略点画）保证可辨识。
 *
 * 逐尺寸按矢量（有向距离场）渲染并做抗锯齿，不做缩放，避免小尺寸糊化。
 * 用法：node tools/generate-icons.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.join(__dirname, '..', 'MikeLingo', 'icons');

const COLOR_A = [79, 70, 229]; // #4f46e5 靛蓝
const COLOR_B = [6, 182, 212]; // #06b6d4 青

// 字形笔画：坐标为各自字面框内的归一化位置，w 为笔画粗细（同样归一化）
const GLYPH_A = [
  { a: [0.5, 0.04], b: [0.06, 0.96], w: 0.15 }, // 左撇
  { a: [0.5, 0.04], b: [0.94, 0.96], w: 0.15 }, // 右捺
  { a: [0.22, 0.64], b: [0.78, 0.64], w: 0.13 } // 横
];

const GLYPH_WEN = [
  { a: [0.47, 0.06], b: [0.36, 0.2], w: 0.14 }, // 点
  { a: [0.1, 0.31], b: [0.9, 0.31], w: 0.14 }, // 横
  { a: [0.74, 0.44], b: [0.14, 0.96], w: 0.14 }, // 撇
  { a: [0.26, 0.44], b: [0.88, 0.96], w: 0.14 } // 捺
];

// 16px 专用的「文」：省掉点画，横与撇捺之间留出足够间距，否则会粘成一团
const GLYPH_WEN_SMALL = [
  { a: [0.08, 0.24], b: [0.92, 0.24], w: 0.13 }, // 横
  { a: [0.78, 0.45], b: [0.08, 1.0], w: 0.13 }, // 撇
  { a: [0.22, 0.45], b: [0.92, 1.0], w: 0.13 } // 捺
];

// 双字形版面：字面框在图标内的位置（归一化，含 x/y/size）
const LAYOUT_A = { x: 0.13, y: 0.09, size: 0.4 };
const LAYOUT_WEN = { x: 0.45, y: 0.47, size: 0.44 };
// 单字形版面（16px 用）
const LAYOUT_SOLO = { x: 0.17, y: 0.17, size: 0.66 };

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function roundedRectDistance(x, y, size, radius) {
  const cx = Math.abs(x - size / 2) - (size / 2 - radius);
  const cy = Math.abs(y - size / 2) - (size / 2 - radius);
  const dx = Math.max(cx, 0);
  const dy = Math.max(cy, 0);
  return Math.min(Math.max(cx, cy), 0) + Math.hypot(dx, dy) - radius;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp((wx * vx + wy * vy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** 字形在图标坐标系下的覆盖率；grow 为向外扩张的笔画余量（用于描边） */
function glyphCoverage(px, py, size, strokes, layout, grow) {
  const box = layout.size * size;
  const gx = (px - layout.x * size) / box;
  const gy = (py - layout.y * size) / box;
  const edge = 0.7 / box; // 抗锯齿过渡带（约 0.7px）
  let alpha = 0;
  for (const stroke of strokes) {
    const dist = segmentDistance(gx, gy, stroke.a[0], stroke.a[1], stroke.b[0], stroke.b[1]);
    alpha = Math.max(alpha, clamp((stroke.w / 2 + grow - dist) / edge + 0.5, 0, 1));
  }
  return alpha;
}

function blend(dst, offset, rgb, alpha) {
  if (alpha <= 0) return;
  const a = clamp(alpha, 0, 1);
  const dstA = dst[offset + 3] / 255;
  const outA = a + dstA * (1 - a);
  for (let i = 0; i < 3; i++) {
    const src = rgb[i];
    const cur = dst[offset + i];
    dst[offset + i] = Math.round((src * a + cur * dstA * (1 - a)) / (outA || 1));
  }
  dst[offset + 3] = Math.round(outA * 255);
}

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const radius = size * 0.23;
  const dual = size >= 32;
  const soloStrokes = GLYPH_WEN_SMALL;
  const ring = 0.055; // 「文」外描边宽度（字面框归一化）

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      const bgAlpha = clamp(0.5 - roundedRectDistance(px, py, size, radius), 0, 1);
      if (bgAlpha <= 0) continue;

      const t = clamp((px + py) / (2 * size), 0, 1);
      const bgRgb = COLOR_A.map((c, i) => Math.round(c + (COLOR_B[i] - c) * t));
      blend(buf, offset, bgRgb, bgAlpha);

      if (!dual) {
        const solo = glyphCoverage(px, py, size, soloStrokes, LAYOUT_SOLO, 0);
        if (solo > 0) blend(buf, offset, [255, 255, 255], solo * bgAlpha);
        continue;
      }

      const letter = glyphCoverage(px, py, size, GLYPH_A, LAYOUT_A, 0);
      if (letter > 0) blend(buf, offset, [255, 255, 255], letter * bgAlpha);

      // 先用底色描边把「文」从「A」里切出来，再压白色笔画
      const halo = glyphCoverage(px, py, size, GLYPH_WEN, LAYOUT_WEN, ring);
      if (halo > 0) blend(buf, offset, bgRgb, halo * bgAlpha);
      const wen = glyphCoverage(px, py, size, GLYPH_WEN, LAYOUT_WEN, 0);
      if (wen > 0) blend(buf, offset, [255, 255, 255], wen * bgAlpha);
    }
  }
  return buf;
}

/* --------------------------------- PNG 编码 -------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(renderIcon(size), size));
  console.log(`generated ${file}`);
}
