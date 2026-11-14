import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function createPng(width, height, renderPixel) {
  const stride = width * 4 + 1;
  const rawData = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride;
    rawData[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = renderPixel(x, y, width, height);
      const pxOffset = rowOffset + 1 + x * 4;
      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);

    const crcBuf = Buffer.alloc(4);
    let crc = crc32(Buffer.concat([typeBuf, data]));
    crcBuf.writeUInt32BE(crc >>> 0, 0);

    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = makeChunk('IHDR', ihdrData);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function renderBrandPixel(x, y, w, h) {
  const nx = (x + 0.5) / w * 2 - 1;
  const ny = (y + 0.5) / h * 2 - 1;

  const p = 3.2;
  const dist = Math.pow(Math.pow(Math.abs(nx), p) + Math.pow(Math.abs(ny), p), 1 / p);

  const bgRadius = 0.90;
  const edgeWidth = 2.0 / w;
  const bgAlpha = Math.max(0, Math.min(1, (bgRadius - dist) / edgeWidth));

  if (bgAlpha <= 0) return [0, 0, 0, 0];

  const gradT = (ny + 1) / 2;
  let bgR = Math.round(18 + 20 * gradT);
  let bgG = Math.round(22 + 10 * (1 - gradT));
  let bgB = Math.round(45 + 30 * gradT);

  const borderDist = Math.abs(dist - (bgRadius - edgeWidth));
  if (borderDist < edgeWidth * 1.5) {
    const borderGlow = (1 - borderDist / (edgeWidth * 1.5)) * 0.45;
    bgR = Math.min(255, bgR + Math.round(90 * borderGlow));
    bgG = Math.min(255, bgG + Math.round(110 * borderGlow));
    bgB = Math.min(255, bgB + Math.round(220 * borderGlow));
  }

  const sx = nx / 0.54;
  const sy = ny / 0.54;
  const starDist = Math.pow(Math.abs(sx), 0.6) + Math.pow(Math.abs(sy), 0.6);
  const starEdge = 2.5 / w;
  const starMask = Math.max(0, Math.min(1, (1.0 - starDist) / starEdge));

  const centerDist = Math.sqrt(nx * nx + ny * ny);
  const coreAlpha = Math.max(0, Math.min(1, (0.16 - centerDist) / edgeWidth));

  if (starMask > 0) {
    const starT = (nx + ny + 1) / 2;
    const sR = Math.round(56 + (168 - 56) * starT);
    const sG = Math.round(189 + (85 - 189) * starT);
    const sB = Math.round(248 + (247 - 248) * starT);

    const coreR = Math.round(sR + (255 - sR) * coreAlpha);
    const coreG = Math.round(sG + (255 - sG) * coreAlpha);
    const coreB = Math.round(sB + (255 - sB) * coreAlpha);

    const outR = Math.round(bgR * (1 - starMask) + coreR * starMask);
    const outG = Math.round(bgG * (1 - starMask) + coreG * starMask);
    const outB = Math.round(bgB * (1 - starMask) + coreB * starMask);
    return [outR, outG, outB, Math.round(bgAlpha * 255)];
  }

  return [bgR, bgG, bgB, Math.round(bgAlpha * 255)];
}

function createIco(pngBuffers) {
  // pngBuffers: array of { width, height, buffer }
  const count = pngBuffers.length;
  const headerLen = 6;
  const dirEntryLen = 16;
  let offset = headerLen + count * dirEntryLen;

  const header = Buffer.alloc(headerLen);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const item of pngBuffers) {
    const entry = Buffer.alloc(dirEntryLen);
    entry.writeUInt8(item.width >= 256 ? 0 : item.width, 0);
    entry.writeUInt8(item.height >= 256 ? 0 : item.height, 1);
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(item.buffer.length, 8); // bytes in resource
    entry.writeUInt32LE(offset, 12); // image offset
    dirEntries.push(entry);
    offset += item.buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map(p => p.buffer)]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const extIconDir = path.resolve('extension/icons');
const publicDir = path.resolve('public');
const buildDir = path.resolve('build');

fs.mkdirSync(extIconDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

const pngImages = [];
for (const size of sizes) {
  const png = createPng(size, size, renderBrandPixel);
  if ([16, 32, 48, 128].includes(size)) {
    fs.writeFileSync(path.join(extIconDir, `icon${size}.png`), png);
  }
  fs.writeFileSync(path.join(publicDir, `icon${size}.png`), png);
  pngImages.push({ width: size, height: size, buffer: png });
}
fs.copyFileSync(path.join(publicDir, 'icon48.png'), path.join(publicDir, 'favicon.png'));

const icoBuffer = createIco(pngImages);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuffer);
fs.writeFileSync(path.join(publicDir, 'icon.ico'), icoBuffer);

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14192b"/>
      <stop offset="50%" stop-color="#1e1e3b"/>
      <stop offset="100%" stop-color="#2a1f4a"/>
    </linearGradient>
    <linearGradient id="starGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="55%" stop-color="#818cf8"/>
      <stop offset="100%" stop-color="#c084fc"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3.5" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>
  <rect x="8" y="8" width="112" height="112" rx="30" fill="url(#bgGrad)" stroke="#474f74" stroke-width="2" stroke-opacity="0.5"/>
  <path d="M 64 26 C 64 45 45 64 26 64 C 45 64 64 83 64 102 C 64 83 83 64 102 64 C 83 64 64 45 64 26 Z" fill="url(#starGrad)" filter="url(#glow)"/>
  <circle cx="64" cy="64" r="5" fill="#ffffff" opacity="0.95"/>
</svg>`;

fs.writeFileSync(path.join(extIconDir, 'icon.svg'), svgContent, 'utf8');
fs.writeFileSync(path.join(publicDir, 'favicon.svg'), svgContent, 'utf8');

console.log('Icons and icon.ico generated successfully!');
