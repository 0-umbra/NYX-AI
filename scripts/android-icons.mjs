#!/usr/bin/env node
/**
 * NYX AI — Android launcher icon generator and verifier.
 *
 * The Android launcher icon is NOT the in-app logo: it is the set of density buckets
 * under `android/app/src/main/res/` that Gradle packages into the APK and that the
 * launcher renders. `npx cap add android` scaffolds a project with its own placeholder
 * icon, so the official NYX AI logo has to be placed there explicitly. This script:
 *
 *   1. reads the official logo, `src/assets/logo/nyx-mark.png` (the single supplied asset);
 *   2. derives every required Android launcher icon from it by rescaling and centring only
 *      — it never crops, recolours or redraws the mark;
 *   3. writes them into the Android resource tree (or any directory given with `--out`);
 *   4. verifies the result and exits non-zero if anything is missing, malformed or wrong,
 *      so a workflow step that runs it fails the build instead of shipping a stale icon.
 *
 * It uses only Node built-ins (no `sharp`, no `@capacitor/assets`), so it runs from a clean
 * checkout. `scripts/generate-icons.mjs` regenerates the PNG inputs; this script is what the
 * Android build depends on.
 *
 * Usage:
 *   node scripts/android-icons.mjs                      # generate + verify (default target)
 *   node scripts/android-icons.mjs --check              # verify an existing tree only
 *   node scripts/android-icons.mjs --out <dir>          # target directory
 *   node scripts/android-icons.mjs --check-apk <path>   # verify the icons inside a built APK
 *
 * Exit code 0 = every check passed, 1 = one or more checks failed.
 */
import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOGO = path.join(ROOT, 'src/assets/logo/nyx-mark.png');
const DEFAULT_OUT = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

// The app's launcher background (matches capacitor.config.json / resources/icon-background.png).
const BACKGROUND = [0x07, 0x06, 0x0f, 0xff];

// Android's adaptive-icon canvas is 108 dp; the documented visual safe zone is the inner
// 66 dp, so the mark is scaled to 66/108 of the canvas and centred.
const ADAPTED_DP = 108;
const SAFE_ZONE = 66 / 108;

const DENSITIES = [
  { name: 'mdpi', scale: 1 },
  { name: 'hdpi', scale: 1.5 },
  { name: 'xhdpi', scale: 2 },
  { name: 'xxhdpi', scale: 3 },
  { name: 'xxxhdpi', scale: 4 },
];

// Legacy (pre-API 26) launcher icons, one per density bucket.
const MIPMAP_SIZE = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

const ADAPTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

/** Every file the Android launcher icon needs, with its expected pixel size (0 = XML). */
export function expectedSizes() {
  const out = new Map();
  for (const d of DENSITIES) {
    out.set(`mipmap-${d.name}/ic_launcher.png`, MIPMAP_SIZE[d.name]);
    out.set(`mipmap-${d.name}/ic_launcher_round.png`, MIPMAP_SIZE[d.name]);
    const adapted = Math.round(ADAPTED_DP * d.scale);
    out.set(`drawable-${d.name}/ic_launcher_foreground.png`, adapted);
    out.set(`drawable-${d.name}/ic_launcher_background.png`, adapted);
  }
  out.set('mipmap-anydpi-v26/ic_launcher.xml', 0);
  out.set('mipmap-anydpi-v26/ic_launcher_round.xml', 0);
  return out;
}

export const REQUIRED_FILES = [...expectedSizes().keys()].sort();

// ---------------------------------------------------------------------------
// Minimal PNG codec (8-bit, non-interlaced; colour types 0, 2, 3, 4 and 6).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes an RGBA8 buffer as a PNG. Deterministic: the same input always yields the same bytes. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) for every scanline
    rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
              : raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour with alpha
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function unfilter(filter, line, prev, bpp) {
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v = line[i];
    if (filter === 1) v += a;
    else if (filter === 2) v += b;
    else if (filter === 3) v += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
    } else if (filter !== 0) {
      throw new Error(`unsupported PNG filter ${filter}`);
    }
    line[i] = v & 0xff;
  }
}

/** Decodes a PNG into `{ width, height, rgba }` (RGBA8). Throws on anything it cannot handle. */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');

  let ihdr;
  let plte = null;
  let trns = null;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || ihdr.length < 13) throw new Error('missing IHDR chunk');
  if (ihdr[12] !== 0) throw new Error('interlaced PNGs are not supported');
  if (ihdr[8] !== 8) throw new Error(`only 8-bit PNGs are supported (got ${ihdr[8]})`);

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const colorType = ihdr[9];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !plte) throw new Error('paletted PNG has no PLTE chunk');
  if (!width || !height) throw new Error('invalid PNG dimensions');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG image data');

  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    unfilter(filter, line, prev, channels);
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      if (colorType === 0) {
        const v = line[si];
        rgba[di] = v; rgba[di + 1] = v; rgba[di + 2] = v; rgba[di + 3] = 255;
      } else if (colorType === 2) {
        rgba[di] = line[si]; rgba[di + 1] = line[si + 1]; rgba[di + 2] = line[si + 2]; rgba[di + 3] = 255;
      } else if (colorType === 3) {
        const index = line[si];
        const hasPalette = plte && index * 3 + 2 < plte.length;
        rgba[di] = hasPalette ? plte[index * 3] : 0;
        rgba[di + 1] = hasPalette ? plte[index * 3 + 1] : 0;
        rgba[di + 2] = hasPalette ? plte[index * 3 + 2] : 0;
        rgba[di + 3] = (trns && index < trns.length) ? trns[index] : 255;
      } else if (colorType === 4) {
        const g = line[si];
        rgba[di] = g; rgba[di + 1] = g; rgba[di + 2] = g; rgba[di + 3] = line[si + 1];
      } else {
        rgba[di] = line[si]; rgba[di + 1] = line[si + 1]; rgba[di + 2] = line[si + 2]; rgba[di + 3] = line[si + 3];
      }
    }
    line.copy(prev);
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image operations
// ---------------------------------------------------------------------------

/** Area-weighted RGBA resample. Correct for both up- and down-scaling, premultiplied safe. */
export function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let oy = 0; oy < dh; oy++) {
    const sy0 = oy * sh / dh;
    const sy1 = (oy + 1) * sh / dh;
    const y0 = Math.floor(sy0);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil(sy1)));
    for (let ox = 0; ox < dw; ox++) {
      const sx0 = ox * sw / dw;
      const sx1 = (ox + 1) * sw / dw;
      const x0 = Math.floor(sx0);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil(sx1)));
      let r = 0; let g = 0; let b = 0; let a = 0; let wsum = 0;
      for (let y = y0; y < y1; y++) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        if (wy <= 0) continue;
        for (let x = x0; x < x1; x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
          const w = wx * wy;
          if (w <= 0) continue;
          const i = (y * sw + x) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha * w;
          g += src[i + 1] * alpha * w;
          b += src[i + 2] * alpha * w;
          a += src[i + 3] * w;
          wsum += w;
        }
      }
      const o = (oy * dw + ox) * 4;
      if (wsum > 0) {
        const alpha = (a / wsum) / 255;
        if (alpha > 0) {
          out[o] = Math.max(0, Math.min(255, (r / wsum) / alpha));
          out[o + 1] = Math.max(0, Math.min(255, (g / wsum) / alpha));
          out[o + 2] = Math.max(0, Math.min(255, (b / wsum) / alpha));
        } else {
          out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
        }
        out[o + 3] = Math.round(a / wsum);
      }
    }
  }
  return out;
}

/** Clips an image to a filled circle (transparent outside), with a one-pixel anti-aliased edge. */
export function applyRoundMask(rgba, size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      const i = (y * size + x) * 4 + 3;
      rgba[i] = Math.round(rgba[i] * coverage);
    }
  }
  return rgba;
}

export function solidColor(size, [r, g, b, a]) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = a;
  }
  return buf;
}

/** Composites `img` centred onto the transparent `canvas`. */
export function placeCentered(canvas, cw, ch, img, iw, ih) {
  const ox = Math.floor((cw - iw) / 2);
  const oy = Math.floor((ch - ih) / 2);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const si = (y * iw + x) * 4;
      const sa = img[si + 3] / 255;
      if (sa <= 0) continue;
      const di = ((oy + y) * cw + (ox + x)) * 4;
      const da = canvas[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      canvas[di] = (img[si] * sa + canvas[di] * da * (1 - sa)) / outA;
      canvas[di + 1] = (img[si + 1] * sa + canvas[di + 1] * da * (1 - sa)) / outA;
      canvas[di + 2] = (img[si + 2] * sa + canvas[di + 2] * da * (1 - sa)) / outA;
      canvas[di + 3] = Math.round(outA * 255);
    }
  }
  return canvas;
}

export function averageColor(rgba, width, height) {
  const n = width * height;
  let r = 0; let g = 0; let b = 0; let a = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3];
  }
  return { r: r / n, g: g / n, b: b / n, a: a / n };
}

/** Counts distinct colours over a stride sample (cheap "is this more than one colour?"). */
export function distinctColours(rgba, width, height, stride = 7) {
  const seen = new Set();
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      seen.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3]}`);
    }
  }
  return seen.size;
}

export function isUniform(rgba) {
  for (let i = 4; i < rgba.length; i += 4) {
    if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2] || rgba[i + 3] !== rgba[3]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function writePng(outDir, relative, rgba, width, height) {
  const abs = path.join(outDir, relative);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, encodePng(width, height, rgba));
  return relative;
}

/** Generates every Android launcher icon variant from the official logo into `outDir`. */
export async function generateIcons(outDir, { logoPath = DEFAULT_LOGO } = {}) {
  if (!existsSync(logoPath)) throw new Error(`logo not found: ${logoPath}`);
  const logo = decodePng(await readFile(logoPath));
  if (logo.width !== logo.height) throw new Error('the NYX AI logo must be square');

  const written = [];
  for (const density of DENSITIES) {
    const size = MIPMAP_SIZE[density.name];

    const square = resample(logo.rgba, logo.width, logo.height, size, size);
    written.push(await writePng(outDir, `mipmap-${density.name}/ic_launcher.png`, square, size, size));
    written.push(await writePng(outDir, `mipmap-${density.name}/ic_launcher_round.png`,
      applyRoundMask(Buffer.from(square), size), size, size));

    const adapted = Math.round(ADAPTED_DP * density.scale);
    const markSize = Math.round(adapted * SAFE_ZONE);
    const mark = resample(logo.rgba, logo.width, logo.height, markSize, markSize);
    const foreground = placeCentered(Buffer.alloc(adapted * adapted * 4), adapted, adapted, mark, markSize, markSize);
    written.push(await writePng(outDir, `drawable-${density.name}/ic_launcher_foreground.png`, foreground, adapted, adapted));
    written.push(await writePng(outDir, `drawable-${density.name}/ic_launcher_background.png`,
      solidColor(adapted, BACKGROUND), adapted, adapted));
  }

  const anydpi = path.join(outDir, 'mipmap-anydpi-v26');
  await mkdir(anydpi, { recursive: true });
  await writeFile(path.join(anydpi, 'ic_launcher.xml'), ADAPTIVE_XML, 'utf8');
  await writeFile(path.join(anydpi, 'ic_launcher_round.xml'), ADAPTIVE_XML, 'utf8');
  written.push('mipmap-anydpi-v26/ic_launcher.xml');
  written.push('mipmap-anydpi-v26/ic_launcher_round.xml');

  return written;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function pixel(rgba, width, x, y) {
  const i = (y * width + x) * 4;
  return { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], a: rgba[i + 3] };
}

function colourDistance(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/**
 * Verifies a generated Android icon tree. Returns a list of human-readable problems;
 * an empty list means every check passed.
 */
export async function verifyIcons(outDir, { logoPath = DEFAULT_LOGO, tolerance = 10 } = {}) {
  const problems = [];
  const expected = expectedSizes();

  if (!existsSync(logoPath)) {
    problems.push(`logo not found: ${logoPath}`);
    return problems;
  }
  const logo = decodePng(await readFile(logoPath));
  const logoAverage = averageColor(logo.rgba, logo.width, logo.height);

  for (const relative of REQUIRED_FILES) {
    const abs = path.join(outDir, relative);
    if (!existsSync(abs)) {
      problems.push(`missing ${relative}`);
      continue;
    }
    const buffer = await readFile(abs);
    const size = expected.get(relative);

    if (size === 0) {
      const text = buffer.toString('utf8');
      if (!/<adaptive-icon/.test(text)) problems.push(`${relative}: not an <adaptive-icon>`);
      if (!/ic_launcher_background/.test(text)) problems.push(`${relative}: does not reference ic_launcher_background`);
      if (!/ic_launcher_foreground/.test(text)) problems.push(`${relative}: does not reference ic_launcher_foreground`);
      continue;
    }

    let image;
    try {
      image = decodePng(buffer);
    } catch (error) {
      problems.push(`${relative}: ${error.message}`);
      continue;
    }
    if (image.width !== size || image.height !== size) {
      problems.push(`${relative}: expected ${size}x${size}, found ${image.width}x${image.height}`);
      continue;
    }

    const { rgba } = image;
    const corners = [pixel(rgba, size, 0, 0), pixel(rgba, size, size - 1, 0),
                     pixel(rgba, size, 0, size - 1), pixel(rgba, size, size - 1, size - 1)];
    const centre = pixel(rgba, size, Math.floor(size / 2), Math.floor(size / 2));

    if (relative.endsWith('ic_launcher_background.png')) {
      if (!isUniform(rgba)) problems.push(`${relative}: the adaptive background must be a single colour`);
      continue;
    }

    if (relative.endsWith('ic_launcher_foreground.png')) {
      if (corners.some((p) => p.a > 8)) problems.push(`${relative}: corners should be transparent`);
      if (centre.a < 200) problems.push(`${relative}: the logo is missing from the centre`);
      continue;
    }

    if (relative.endsWith('ic_launcher_round.png')) {
      if (corners.some((p) => p.a > 8)) problems.push(`${relative}: round icon has opaque corners`);
      if (centre.a < 200) problems.push(`${relative}: the logo is missing from the centre`);
      continue;
    }

    // Square launcher icons.
    if (centre.a < 200) problems.push(`${relative}: the logo is missing from the centre`);
    if (distinctColours(rgba, size, size) < 4) problems.push(`${relative}: does not contain the logo`);
    if (colourDistance(averageColor(rgba, size, size), logoAverage) > tolerance) {
      problems.push(`${relative}: average colour differs from the logo`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// APK inspection (the icons actually packaged into the built APK)
// ---------------------------------------------------------------------------

/** Minimal ZIP reader for APK inspection (stored + deflate entries). */
export function readZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP/APK file (no end-of-central-directory record)');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let k = 0; k < count; k++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const read = (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    const { method, compressedSize, localOffset } = entry;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
    const nameLength = buffer.readUInt16LE(localOffset + 26);
    const extraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + nameLength + extraLength;
    const payload = buffer.subarray(start, start + compressedSize);
    return method === 0 ? Buffer.from(payload) : inflateRawSync(payload);
  };

  return { entries, read };
}

/**
 * Verifies that a built APK really contains the NYX AI launcher icon.
 * Returns `{ problems, matches }` where `matches` lists entries whose bytes are identical
 * to freshly generated icons (aapt may recompress, so a mismatch is not automatically a failure).
 */
export async function verifyApkIcons(apkPath, { logoPath = DEFAULT_LOGO, tolerance = 10 } = {}) {
  const problems = [];
  const matches = [];
  const expected = expectedSizes();

  if (!existsSync(apkPath)) return { problems: [`APK not found: ${apkPath}`], matches };
  const buffer = await readFile(apkPath);
  let zip;
  try {
    zip = readZipEntries(buffer);
  } catch (error) {
    return { problems: [`${apkPath}: ${error.message}`], matches };
  }

  // The expected rasters are regenerated in memory, so the packaged bytes can be compared
  // byte-for-byte with what the launcher icon should contain. Nothing is written to disk here.
  const generated = new Map();
  const logo = decodePng(await readFile(logoPath));
  const logoAverage = averageColor(logo.rgba, logo.width, logo.height);
  for (const density of DENSITIES) {
    const size = MIPMAP_SIZE[density.name];
    const square = resample(logo.rgba, logo.width, logo.height, size, size);
    generated.set(`mipmap-${density.name}/ic_launcher.png`, encodePng(size, size, square));
    generated.set(`mipmap-${density.name}/ic_launcher_round.png`,
      encodePng(size, size, applyRoundMask(Buffer.from(square), size)));
    const adapted = Math.round(ADAPTED_DP * density.scale);
    const markSize = Math.round(adapted * SAFE_ZONE);
    const mark = resample(logo.rgba, logo.width, logo.height, markSize, markSize);
    generated.set(`drawable-${density.name}/ic_launcher_foreground.png`,
      encodePng(adapted, adapted, placeCentered(Buffer.alloc(adapted * adapted * 4), adapted, adapted, mark, markSize, markSize)));
    generated.set(`drawable-${density.name}/ic_launcher_background.png`,
      encodePng(adapted, adapted, solidColor(adapted, BACKGROUND)));
  }

  const findEntry = (relative) => {
    const suffix = `res/${relative}`;
    for (const name of zip.entries.keys()) {
      if (name === suffix || name.endsWith(`/${suffix}`)) return name;
    }
    return null;
  };

  for (const relative of REQUIRED_FILES) {
    const name = findEntry(relative);
    if (!name) {
      problems.push(`APK is missing res/${relative}`);
      continue;
    }
    const data = zip.read(name);
    if (data === null) {
      problems.push(`APK entry res/${relative} could not be read`);
      continue;
    }
    const size = expected.get(relative);
    if (size === 0) {
      const text = data.toString('utf8');
      if (!/<adaptive-icon/.test(text) || !/ic_launcher_foreground/.test(text)) {
        problems.push(`APK res/${relative} is not a valid adaptive icon`);
      }
      continue;
    }
    let image;
    try {
      image = decodePng(data);
    } catch (error) {
      problems.push(`APK res/${relative} is not a readable PNG (${error.message})`);
      continue;
    }
    if (image.width !== size || image.height !== size) {
      problems.push(`APK res/${relative}: expected ${size}x${size}, found ${image.width}x${image.height}`);
      continue;
    }
    if (relative.endsWith('ic_launcher.png') &&
        colourDistance(averageColor(image.rgba, size, size), logoAverage) > tolerance) {
      problems.push(`APK res/${relative} does not contain the NYX AI logo`);
    }
    if (relative.endsWith('ic_launcher_round.png')) {
      const corner = (image.rgba[3] ?? 0);
      if (corner > 8) problems.push(`APK res/${relative} has opaque corners (not round)`);
    }
    if (generated.has(relative) && Buffer.compare(data, generated.get(relative)) === 0) matches.push(relative);
  }

  return { problems, matches };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { action: 'generate', out: DEFAULT_OUT, apk: null, logo: DEFAULT_LOGO };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') options.action = 'check';
    else if (arg === '--check-apk') { options.action = 'apk'; options.apk = argv[++i]; }
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--logo') options.logo = argv[++i];
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.action === 'apk' && !options.apk) throw new Error('--check-apk needs a path');
  return options;
}

function printHelp() {
  console.log(`NYX AI — Android launcher icon generator and verifier

  node scripts/android-icons.mjs                      generate + verify (default target)
  node scripts/android-icons.mjs --check              verify an existing resource tree only
  node scripts/android-icons.mjs --out <dir>          write to a specific directory
  node scripts/android-icons.mjs --check-apk <apk>    verify the icons inside a built APK
  node scripts/android-icons.mjs --logo <png>         use a different source logo
`);
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { printHelp(); return 0; }

  if (options.action === 'apk') {
    const { problems, matches } = await verifyApkIcons(options.apk, { logoPath: options.logo });
    console.log(`APK icon check: ${options.apk}`);
    for (const relative of matches) console.log(`  identical  res/${relative}`);
    if (problems.length) {
      for (const problem of problems) console.error(`  FAIL ${problem}`);
      console.error(`APK icon check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}).`);
      return 1;
    }
    console.log(`  OK         ${matches.length}/${REQUIRED_FILES.length} packaged icons match the generated set byte-for-byte`);
    console.log('APK icon check passed.');
    return 0;
  }

  if (options.action === 'generate') {
    const written = await generateIcons(options.out, { logoPath: options.logo });
    console.log(`Generated ${written.length} Android launcher icon files in ${options.out}`);
  }

  const problems = await verifyIcons(options.out, { logoPath: options.logo });
  if (problems.length) {
    for (const problem of problems) console.error(`  FAIL ${problem}`);
    console.error(`Android launcher icon check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}).`);
    return 1;
  }
  console.log(`Android launcher icon check passed (${REQUIRED_FILES.length} files verified in ${options.out}).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`android-icons: ${error.message}`);
    process.exitCode = 1;
  }
}
