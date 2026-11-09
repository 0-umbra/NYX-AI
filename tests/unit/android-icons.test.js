/**
 * Android launcher icon tests.
 *
 * The Android launcher icon is the density buckets under `android/app/src/main/res/` that
 * Gradle packages into the APK. These tests run `scripts/android-icons.mjs` for real, then
 * inspect the bytes it produced, so "the icon was generated" is never claimed from the mere
 * presence of the script:
 *
 *   - every required variant exists, is a valid PNG, and has the right pixel dimensions;
 *   - the mark really comes from the official logo (average colour, non-uniform content);
 *   - round icons are masked, adaptive foregrounds have transparent margins, backgrounds are flat;
 *   - the adaptive-icon XML references resolve to files that exist;
 *   - generation is deterministic, so the packaged bytes can be compared with the APK;
 *   - corrupting or deleting a file makes verification fail (and the CLI exit non-zero);
 *   - a synthetic APK is inspected so the "the APK contains the new icon" claim is testable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';

import {
  REQUIRED_FILES, expectedSizes, decodePng, encodePng, generateIcons, verifyIcons,
  verifyApkIcons, readZipEntries, resample, applyRoundMask, solidColor, averageColor, isUniform,
} from '../../scripts/android-icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'android-icons.mjs');
const LOGO = path.join(ROOT, 'src', 'assets', 'logo', 'nyx-mark-512.png');

const tempDir = async () => mkdtemp(path.join(tmpdir(), 'nyx-icons-'));

// --- tiny ZIP writer, so the APK path can be tested without an Android build ------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method = 0 } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const payload = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lh, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += lh.length + nameBuf.length + payload.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// Small compiled Android XML/resource-table fixtures. Resource IDs are deliberately
// numeric: a string search in the XML cannot prove which drawable they reference.
function chunk(type, header, body) {
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(header.length, 2);
  header.writeUInt32LE(header.length + body.length, 4);
  return Buffer.concat([header, body]);
}
function strings(items) {
  let offset = 0;
  const offsets = Buffer.alloc(items.length * 4);
  const data = items.map((item, i) => {
    const bytes = Buffer.from(item);
    const length = (n) => n < 128 ? [n] : [0x80 | (n >> 8), n & 0xff];
    offsets.writeUInt32LE(offset, i * 4);
    const value = Buffer.concat([Buffer.from([...length(item.length), ...length(bytes.length)]), bytes, Buffer.from([0])]);
    offset += value.length;
    return value;
  });
  const raw = Buffer.concat(data);
  const padded = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4)]);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(items.length, 8);
  header.writeUInt32LE(0x100, 16);
  header.writeUInt32LE(28 + offsets.length, 20);
  return chunk(1, header, Buffer.concat([offsets, padded]));
}
const BG_ID = 0x7f010000;
const FG_ID = 0x7f010001;
function binaryXml({ background = BG_ID, foreground = FG_ID, root = 'adaptive-icon', omitForeground = false, attributeId = 0x01010199, foregroundType = 1, monochrome = null } = {}) {
  const words = [root, 'background', 'foreground', 'drawable', 'http://schemas.android.com/apk/res/android', 'monochrome'];
  const start = (name, reference) => {
    const header = Buffer.alloc(16);
    const ext = Buffer.alloc(20);
    ext.writeUInt32LE(0xffffffff, 0);
    ext.writeUInt32LE(words.indexOf(name), 4);
    ext.writeUInt16LE(20, 8);
    ext.writeUInt16LE(20, 10);
    ext.writeUInt16LE(reference === undefined ? 0 : 1, 12);
    const attr = reference === undefined ? Buffer.alloc(0) : Buffer.alloc(20);
    if (attr.length) {
      attr.writeUInt32LE(4, 0); attr.writeUInt32LE(3, 4); attr.writeUInt32LE(0xffffffff, 8);
      attr.writeUInt16LE(8, 12); attr[15] = name === 'foreground' ? foregroundType : 1; attr.writeUInt32LE(reference, 16);
    }
    return chunk(0x102, header, Buffer.concat([ext, attr]));
  };
  const end = (name) => {
    const ext = Buffer.alloc(8);
    ext.writeUInt32LE(0xffffffff, 0); ext.writeUInt32LE(words.indexOf(name), 4);
    return chunk(0x103, Buffer.alloc(16), ext);
  };
  const map = Buffer.alloc(16); map.writeUInt32LE(attributeId, 12);
  const nodes = [strings(words), chunk(0x180, Buffer.alloc(8), map), start(root), start('background', background), end('background')];
  if (!omitForeground) nodes.push(start('foreground', foreground), end('foreground'));
  if (monochrome !== null) nodes.push(start('monochrome', monochrome), end('monochrome'));
  nodes.push(end(root));
  return chunk(3, Buffer.alloc(8), Buffer.concat(nodes));
}
const ICON_ID = 0x7f020000;
const ROUND_ID = 0x7f020001;
function binaryManifest({ icon = ICON_ID, roundIcon = ROUND_ID, activityIcon } = {}) {
  const words = ['icon', 'roundIcon', 'name', 'http://schemas.android.com/apk/res/android',
    'manifest', 'application', 'activity', 'intent-filter', 'action', 'category',
    'android.intent.action.MAIN', 'android.intent.category.LAUNCHER'];
  const start = (name, attrs = []) => {
    const ext = Buffer.alloc(20);
    ext.writeUInt32LE(0xffffffff, 0); ext.writeUInt32LE(words.indexOf(name), 4);
    ext.writeUInt16LE(20, 8); ext.writeUInt16LE(20, 10); ext.writeUInt16LE(attrs.length, 12);
    const attributes = attrs.map(([index, type, value]) => {
      const a = Buffer.alloc(20); a.writeUInt32LE(3, 0); a.writeUInt32LE(index, 4);
      a.writeUInt32LE(0xffffffff, 8); a.writeUInt16LE(8, 12); a[15] = type; a.writeUInt32LE(value, 16);
      return a;
    });
    return chunk(0x102, Buffer.alloc(16), Buffer.concat([ext, ...attributes]));
  };
  const end = (name) => {
    const ext = Buffer.alloc(8); ext.writeUInt32LE(0xffffffff, 0); ext.writeUInt32LE(words.indexOf(name), 4);
    return chunk(0x103, Buffer.alloc(16), ext);
  };
  const map = Buffer.alloc(12); map.writeUInt32LE(0x01010002, 0); map.writeUInt32LE(0x0101052c, 4); map.writeUInt32LE(0x01010003, 8);
  return chunk(3, Buffer.alloc(8), Buffer.concat([
    strings(words), chunk(0x180, Buffer.alloc(8), map), start('manifest'),
    start('application', [[0, 1, icon], [1, 1, roundIcon]]),
    start('activity', activityIcon ? [[0, 1, activityIcon]] : []), start('intent-filter'),
    start('action', [[2, 3, 10]]), end('action'), start('category', [[2, 3, 11]]), end('category'),
    end('intent-filter'), end('activity'), end('application'), end('manifest'),
  ]));
}
function resourceTable({ qualifier = '-v4', foregroundName = 'ic_launcher_foreground', badPath = false, extraForeground = false, extraBackground = false, nightOnly = false, omitMipmaps = false, wrongDensity = false, omitSpec = false } = {}) {
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  const values = densities.flatMap((d) => [
    `res/drawable-${d}${qualifier}/ic_launcher_background.png`,
    `res/drawable-${d}${qualifier}/${badPath && d === 'mdpi' ? 'other' : 'ic_launcher_foreground'}.png`,
  ]);
  const extraIndex = values.length;
  values.push('long-resource-path-' + 'x'.repeat(200)); // exercise two-byte UTF-8 lengths
  if (extraForeground) values.push(`res/drawable-${extraForeground === 'anydpi' ? 'anydpi-' : ''}v24/ic_launcher_foreground.${extraForeground === 'png' ? 'png' : 'xml'}`);
  const backgroundIndex = values.length;
  if (extraBackground) values.push('res/drawable/ic_launcher_background.xml');
  const typeStrings = strings(['drawable', 'mipmap']);
  const keyStrings = strings(['ic_launcher_background', foregroundName, 'ic_launcher', 'ic_launcher_round']);
  const configs = densities.map((d, i) => {
    const header = Buffer.alloc(84);
    header[8] = 1; header.writeUInt32LE(2, 12); header.writeUInt32LE(92, 16);
    header.writeUInt32LE(64, 20); header.writeUInt16LE(wrongDensity && i === 0 ? 240 : [160, 240, 320, 480, 640][i], 34);
    header.writeUInt16LE(4, 44); if (nightOnly) header[49] = 0x20;
    const offsets = Buffer.alloc(8);
    offsets.writeUInt32LE(0, 0); offsets.writeUInt32LE(16, 4);
    const entries = Buffer.alloc(32);
    for (let j = 0; j < 2; j++) {
      const pos = j * 16;
      entries.writeUInt16LE(8, pos); entries.writeUInt32LE(j, pos + 4);
      entries.writeUInt16LE(8, pos + 8); entries[pos + 11] = 3; entries.writeUInt32LE(i * 2 + j, pos + 12);
    }
    return chunk(0x201, header, Buffer.concat([offsets, entries]));
  });
  if (extraForeground) {
    const header = Buffer.alloc(84);
    header[8] = 1; header.writeUInt32LE(2, 12); header.writeUInt32LE(92, 16);
    header.writeUInt32LE(64, 20); header.writeUInt16LE(24, 44);
    if (extraForeground === 'anydpi') header.writeUInt16LE(0xfffe, 34);
    const offsets = Buffer.alloc(8); offsets.writeUInt32LE(0xffffffff, 0); offsets.writeUInt32LE(0, 4);
    const entry = Buffer.alloc(16); entry.writeUInt16LE(8, 0); entry.writeUInt32LE(1, 4);
    entry.writeUInt16LE(8, 8); entry[11] = 3; entry.writeUInt32LE(extraIndex + 1, 12);
    configs.push(chunk(0x201, header, Buffer.concat([offsets, entry])));
  }
  if (extraBackground) {
    const header = Buffer.alloc(84);
    header[8] = 1; header.writeUInt32LE(2, 12); header.writeUInt32LE(92, 16);
    header.writeUInt32LE(64, 20);
    const offsets = Buffer.alloc(8); offsets.writeUInt32LE(0, 0); offsets.writeUInt32LE(0xffffffff, 4);
    const entry = Buffer.alloc(16); entry.writeUInt16LE(8, 0);
    entry.writeUInt16LE(8, 8); entry[11] = 3; entry.writeUInt32LE(backgroundIndex, 12);
    configs.push(chunk(0x201, header, Buffer.concat([offsets, entry])));
  }
  const mipmaps = [...densities.map((d, i) => ({ density: [160, 240, 320, 480, 640][i], sdk: 4,
    paths: [`res/mipmap-${d}${qualifier}/ic_launcher.png`, `res/mipmap-${d}${qualifier}/ic_launcher_round.png`] })),
    { density: 0xfffe, sdk: 26, paths: ['res/mipmap-anydpi-v26/ic_launcher.xml', 'res/mipmap-anydpi-v26/ic_launcher_round.xml'] }];
  for (const config of mipmaps) {
    const base = values.length; values.push(...config.paths);
    const header = Buffer.alloc(84); header[8] = 2; header.writeUInt32LE(2, 12); header.writeUInt32LE(92, 16);
    header.writeUInt32LE(64, 20); header.writeUInt16LE(config.density, 34); header.writeUInt16LE(config.sdk, 44);
    const offsets = Buffer.alloc(8); offsets.writeUInt32LE(16, 4);
    const entries = Buffer.alloc(32);
    for (let i = 0; i < 2; i++) {
      entries.writeUInt16LE(8, i * 16); entries.writeUInt32LE(i + 2, i * 16 + 4);
      entries.writeUInt16LE(8, i * 16 + 8); entries[i * 16 + 11] = 3; entries.writeUInt32LE(base + i, i * 16 + 12);
    }
    if (!omitMipmaps) configs.push(chunk(0x201, header, Buffer.concat([offsets, entries])));
  }
  const pkg = Buffer.alloc(288);
  pkg.writeUInt32LE(0x7f, 8);
  pkg.writeUInt32LE(288, 268);
  pkg.writeUInt32LE(288 + typeStrings.length, 276);
  const spec = (id) => {
    const header = Buffer.alloc(16); header[8] = id; header.writeUInt32LE(2, 12);
    return chunk(0x202, header, Buffer.alloc(8));
  };
  const packageChunk = chunk(0x200, pkg, Buffer.concat([typeStrings, keyStrings, ...(omitSpec ? [] : [spec(1), spec(2)]), ...configs]));
  const table = Buffer.alloc(12); table.writeUInt32LE(1, 8);
  return chunk(2, table, Buffer.concat([strings(values), packageChunk]));
}

// --------------------------------------------------------------------------------------

test('android icons: the official logo is the only source and it is square', async () => {
  const logo = decodePng(await readFile(LOGO));
  assert.equal(logo.width, 512);
  assert.equal(logo.height, 512);
  assert.ok(logo.rgba.length === 512 * 512 * 4);
});

test('android icons: removes only the recognized Capacitor vectors and preserves custom conflicts', async () => {
  const out = await tempDir();
  try {
    for (const [dir, name, fixture] of [
      ['drawable', 'ic_launcher_background.xml', 'background.xml'],
      ['drawable-v24', 'ic_launcher_foreground.xml', 'foreground.xml'],
    ]) {
      await mkdir(path.join(out, dir), { recursive: true });
      await writeFile(path.join(out, dir, name), await readFile(path.join(ROOT, 'tests/fixtures/android-capacitor-7', fixture)));
    }
    await generateIcons(out);
    assert.equal(existsSync(path.join(out, 'drawable/ic_launcher_background.xml')), false);
    assert.equal(existsSync(path.join(out, 'drawable-v24/ic_launcher_foreground.xml')), false);
    assert.deepEqual(await verifyIcons(out), []);

    const custom = path.join(out, 'drawable-v24/ic_launcher_foreground.xml');
    const other = path.join(out, 'drawable-night/ic_launcher_background.xml');
    await mkdir(path.dirname(other), { recursive: true });
    await writeFile(custom, '<vector custom="true"/>');
    await writeFile(other, '<vector custom="night"/>');
    await generateIcons(out);
    assert.equal(await readFile(custom, 'utf8'), '<vector custom="true"/>');
    assert.equal(await readFile(other, 'utf8'), '<vector custom="night"/>');
    const problems = await verifyIcons(out);
    assert.ok(problems.some((p) => p.includes('drawable-v24/ic_launcher_foreground.xml: unverified competing')));
    assert.ok(problems.some((p) => p.includes('drawable-night/ic_launcher_background.xml: unverified competing')));
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('android icons: generates every required Android launcher icon variant', async () => {
  const out = await tempDir();
  try {
    const written = await generateIcons(out);
    assert.deepEqual([...written].sort(), REQUIRED_FILES);
    assert.equal(REQUIRED_FILES.length, 22, '5 densities × 4 rasters + 2 adaptive XML');
    for (const relative of REQUIRED_FILES) {
      assert.ok(existsSync(path.join(out, relative)), `${relative} exists`);
    }
    assert.deepEqual(await verifyIcons(out), [], 'a fresh generate verifies cleanly');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('android icons: every raster is a valid PNG with the density-correct dimensions', async () => {
  const out = await tempDir();
  try {
    await generateIcons(out);
    const expected = expectedSizes();
    for (const [relative, size] of expected) {
      if (size === 0) continue;
      const image = decodePng(await readFile(path.join(out, relative)));
      assert.equal(image.width, size, `${relative} width`);
      assert.equal(image.height, size, `${relative} height`);
      assert.equal(image.rgba.length, size * size * 4, `${relative} pixel count`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('android icons: the launcher icons carry the official logo, not a placeholder', async () => {
  const out = await tempDir();
  try {
    await generateIcons(out);
    const logo = decodePng(await readFile(LOGO));
    const logoAverage = averageColor(logo.rgba, logo.width, logo.height);

    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      const square = decodePng(await readFile(path.join(out, `mipmap-${density}/ic_launcher.png`)));
      const average = averageColor(square.rgba, square.width, square.height);
      const distance = Math.abs(average.r - logoAverage.r)
        + Math.abs(average.g - logoAverage.g)
        + Math.abs(average.b - logoAverage.b);
      assert.ok(distance <= 10, `mipmap-${density} average colour matches the logo (distance ${distance})`);

      // The mark is high-frequency content, not a flat fill.
      const seen = new Set();
      for (let i = 0; i < square.rgba.length; i += 4 * 13) {
        seen.add(`${square.rgba[i]},${square.rgba[i + 1]},${square.rgba[i + 2]}`);
      }
      assert.ok(seen.size > 8, `mipmap-${density} contains the logo detail`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('android icons: round icons are masked, adaptive layers are correct', async () => {
  const out = await tempDir();
  try {
    await generateIcons(out);
    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      const size = expectedSizes().get(`mipmap-${density}/ic_launcher_round.png`);
      const round = decodePng(await readFile(path.join(out, `mipmap-${density}/ic_launcher_round.png`)));
      const corner = (round.rgba[3] ?? 0);
      assert.ok(corner <= 8, `round ${density} has a transparent corner`);
      const centreAlpha = round.rgba[((Math.floor(size / 2) * size) + Math.floor(size / 2)) * 4 + 3];
      assert.ok(centreAlpha >= 200, `round ${density} keeps the logo in the centre`);

      const adapted = expectedSizes().get(`drawable-${density}/ic_launcher_foreground.png`);
      const foreground = decodePng(await readFile(path.join(out, `drawable-${density}/ic_launcher_foreground.png`)));
      assert.equal(foreground.width, adapted);
      assert.ok(foreground.rgba[3] <= 8, `foreground ${density} is transparent at the corner`);
      const centre = (Math.floor(adapted / 2) * adapted + Math.floor(adapted / 2)) * 4 + 3;
      assert.ok(foreground.rgba[centre] >= 200, `foreground ${density} keeps the logo in the centre`);
      assert.ok(!isUniform(foreground.rgba), `foreground ${density} is not flat`);

      const background = decodePng(await readFile(path.join(out, `drawable-${density}/ic_launcher_background.png`)));
      assert.equal(background.width, adapted);
      assert.ok(isUniform(background.rgba), `background ${density} is a single colour`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('android icons: the adaptive XML is a valid adaptive-icon referencing real drawables', async () => {
  const out = await tempDir();
  try {
    await generateIcons(out);
    for (const relative of ['mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-anydpi-v26/ic_launcher_round.xml']) {
      const text = await readFile(path.join(out, relative), 'utf8');
      assert.match(text, /<adaptive-icon/);
      assert.match(text, /@drawable\/ic_launcher_background/);
      assert.match(text, /@drawable\/ic_launcher_foreground/);
    }
    // Both referenced drawables exist for every density bucket.
    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      assert.ok(existsSync(path.join(out, `drawable-${density}/ic_launcher_background.png`)));
      assert.ok(existsSync(path.join(out, `drawable-${density}/ic_launcher_foreground.png`)));
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('android icons: generation is deterministic, so the APK bytes can be compared', async () => {
  const first = await tempDir();
  const second = await tempDir();
  try {
    await generateIcons(first);
    await generateIcons(second);
    for (const relative of REQUIRED_FILES) {
      const a = await readFile(path.join(first, relative));
      const b = await readFile(path.join(second, relative));
      assert.ok(a.equals(b), `${relative} is byte-identical across runs`);
    }
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('android icons: verification fails on a missing, corrupt or wrongly sized file', async () => {
  const out = await tempDir();
  try {
    await generateIcons(out);
    assert.deepEqual(await verifyIcons(out), []);

    await rm(path.join(out, 'mipmap-xxxhdpi', 'ic_launcher.png'));
    let problems = await verifyIcons(out);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /missing mipmap-xxxhdpi\/ic_launcher\.png/);

    await generateIcons(out);
    await writeFile(path.join(out, 'mipmap-mdpi', 'ic_launcher.png'), 'definitely not a png');
    problems = await verifyIcons(out);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not a PNG file/);

    await generateIcons(out);
    await writeFile(path.join(out, 'mipmap-xxhdpi', 'ic_launcher_round.png'),
      encodePng(7, 7, Buffer.alloc(7 * 7 * 4, 255)));
    problems = await verifyIcons(out);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /expected 144x144, found 7x7/);

    await generateIcons(out);
    await writeFile(path.join(out, 'mipmap-anydpi-v26', 'ic_launcher.xml'), '<linear-layout />');
    problems = await verifyIcons(out);
    assert.equal(problems.length, 3, 'a non-adaptive icon fails the shape and both reference checks');
    assert.ok(problems.some((p) => /not an <adaptive-icon>/.test(p)));
    assert.ok(problems.some((p) => /ic_launcher_foreground/.test(p)));

    await generateIcons(out);
    await writeFile(path.join(out, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'),
      '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">'
      + '<background android:drawable="@drawable/ic_launcher_background"/></adaptive-icon>');
    problems = await verifyIcons(out);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /does not reference ic_launcher_foreground/);

    const empty = await tempDir();
    try {
      const missing = await verifyIcons(empty);
      assert.equal(missing.length, REQUIRED_FILES.length);
      assert.ok(missing.every((p) => /^missing /.test(p)));
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('android icons: the CLI exits non-zero when generation or verification fails', () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  const ok = run(['--out', '/tmp/nyx-icons-cli-ok']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Android launcher icon check passed/);

  const bad = run(['--check', '--out', '/tmp/nyx-icons-definitely-missing']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Android launcher icon check failed/);

  const broken = run(['--out', '/tmp/nyx-icons-cli-broken']);
  assert.equal(broken.status, 0, broken.stderr);
  assert.ok(existsSync('/tmp/nyx-icons-cli-broken/mipmap-mdpi/ic_launcher.png'));
  writeFileSync('/tmp/nyx-icons-cli-broken/drawable-hdpi/ic_launcher_background.png', 'broken');
  const after = run(['--check', '--out', '/tmp/nyx-icons-cli-broken']);
  assert.equal(after.status, 1);
  assert.match(after.stderr, /not a PNG file/);
});

test('android icons: the generated set is exactly what an APK is checked against', async () => {
  const out = await tempDir();
  const apk = await tempDir();
  try {
    await generateIcons(out);

    // AAPT2 uses v4 on density directories and compiles XML references to IDs.
    const entries = [];
    for (const relative of REQUIRED_FILES) {
      const raster = relative.endsWith('.png');
      const name = raster ? relative.replace('/', '-v4/') : relative;
      entries.push({ name: `res/${name}`, data: raster ? await readFile(path.join(out, relative)) : binaryXml() });
    }
    entries.push({ name: 'resources.arsc', data: resourceTable(), method: 8 });
    entries.push({ name: 'AndroidManifest.xml', data: binaryManifest(), method: 8 });
    entries.push({ name: 'classes.dex', data: Buffer.from('dex\n') });
    const apkPath = path.join(apk, 'app-debug.apk');
    await writeFile(apkPath, buildZip(entries));

    const result = await verifyApkIcons(apkPath);
    assert.deepEqual(result.problems, [], `packaged icons are valid: ${result.problems.join('; ')}`);
    assert.equal(result.matches.length, 20, 'every packaged raster is byte-identical to the generated set');

    const xmlName = 'res/mipmap-anydpi-v26/ic_launcher.xml';
    const checkChange = async (name, data, pattern) => {
      const modified = entries.map((entry) => entry.name === name ? { ...entry, data } : entry);
      await writeFile(apkPath, buildZip(modified));
      const checked = await verifyApkIcons(apkPath);
      assert.ok(checked.problems.some((problem) => pattern.test(problem)), checked.problems.join('; '));
    };
    await checkChange('AndroidManifest.xml', binaryManifest({ icon: 0x7f020099 }), /unresolved drawable resource/);
    await checkChange('AndroidManifest.xml', binaryManifest({ icon: ROUND_ID }), /wrong launcher resource/);
    await checkChange('AndroidManifest.xml', binaryManifest({ activityIcon: ROUND_ID }), /launcher activity overrides icon/);
    await checkChange('AndroidManifest.xml', Buffer.from('not a manifest'), /launcher references are invalid/);
    await writeFile(apkPath, buildZip(entries.filter((entry) => entry.name !== 'resources.arsc')));
    assert.ok((await verifyApkIcons(apkPath)).problems.some((p) => /missing AndroidManifest.xml or resources.arsc/.test(p)));
    await writeFile(apkPath, buildZip(entries.filter((entry) => entry.name !== 'AndroidManifest.xml')));
    assert.ok((await verifyApkIcons(apkPath)).problems.some((p) => /missing AndroidManifest.xml/.test(p)));
    await checkChange(xmlName, binaryXml({ root: 'not-adaptive' }), /not an adaptive-icon root/);
    await checkChange(xmlName, binaryXml({ omitForeground: true }), /incomplete adaptive-icon/);
    await writeFile(apkPath, buildZip(entries.map((entry) => entry.name === xmlName ? { ...entry, data: binaryXml({ monochrome: FG_ID }) } : entry)));
    assert.deepEqual((await verifyApkIcons(apkPath)).problems, [], 'valid monochrome mask is accepted');
    await checkChange(xmlName, binaryXml({ monochrome: BG_ID }), /monochrome drawable has incorrect mask/);
    await checkChange(xmlName, binaryXml({ foreground: BG_ID }), /foreground references the wrong drawable/);
    await checkChange(xmlName, binaryXml({ background: FG_ID }), /background references the wrong drawable/);
    await checkChange(xmlName, binaryXml({ foregroundType: 3 }), /drawable must be a resource reference/);
    await checkChange(xmlName, binaryXml({ attributeId: 0x01010000 }), /invalid android:drawable attribute ID/);
    await checkChange(xmlName, binaryXml({ foreground: 0x7f010099 }), /unresolved drawable resource/);
    await checkChange(xmlName, binaryXml().subarray(0, 32), /invalid Android resource/);
    await checkChange(xmlName, Buffer.from('<adaptive-icon>ic_launcher_foreground</adaptive-icon>'), /invalid Android resource/);
    await checkChange('resources.arsc', resourceTable({ badPath: true }), /does not resolve to mdpi drawable/);
    await checkChange('resources.arsc', resourceTable({ nightOnly: true }), /unsupported resource configuration qualifier/);
    await checkChange('resources.arsc', resourceTable({ wrongDensity: true }), /does not resolve to mdpi drawable/);
    await checkChange('resources.arsc', resourceTable({ omitMipmaps: true }), /unresolved drawable resource/);
    await checkChange('resources.arsc', resourceTable({ foregroundName: 'placeholder' }), /wrong drawable/);
    await checkChange('resources.arsc', resourceTable({ extraBackground: true }), /unverified drawable configuration: res\/drawable\/ic_launcher_background.xml/);
    await checkChange('resources.arsc', resourceTable({ extraForeground: true }), /unverified drawable configuration: res\/drawable-v24\/ic_launcher_foreground.xml/);
    // AAPT2 compiles the Capacitor v24 vector as anydpi-v24, preferred over the PNGs.
    await checkChange('resources.arsc', resourceTable({ extraForeground: 'anydpi' }), /unverified drawable configuration: res\/drawable-anydpi-v24\/ic_launcher_foreground.xml/);
    const pngAlternative = { name: 'res/drawable-v24/ic_launcher_foreground.png', data: await readFile(path.join(out, 'drawable-mdpi/ic_launcher_foreground.png')) };
    const withAlternative = entries.map((entry) => entry.name === 'resources.arsc' ? { ...entry, data: resourceTable({ extraForeground: 'png' }) } : entry).concat([pngAlternative]);
    await writeFile(apkPath, buildZip(withAlternative));
    assert.deepEqual((await verifyApkIcons(apkPath)).problems, [], 'valid alternative drawable pixels are checked and accepted');
    await writeFile(apkPath, buildZip(withAlternative.map((entry) => entry.name === pngAlternative.name ? { ...entry, data: encodePng(108, 108, Buffer.alloc(108 * 108 * 4)) } : entry)));
    assert.ok((await verifyApkIcons(apkPath)).problems.some((p) => /alternative pixels differ/.test(p)));
    await checkChange('resources.arsc', resourceTable({ omitSpec: true }), /missing or invalid resource type spec/);
    await checkChange('resources.arsc', Buffer.from('corrupt'), /Android resource/);
    await checkChange('res/mipmap-mdpi-v4/ic_launcher.png', encodePng(7, 7, Buffer.alloc(196)), /expected 48x48, found 7x7/);
    await checkChange('res/mipmap-mdpi-v4/ic_launcher_round.png', encodePng(48, 48, Buffer.alloc(48 * 48 * 4, 255)), /opaque corners/);
    await checkChange('res/mipmap-mdpi-v4/ic_launcher.png', Buffer.from('bad PNG'), /not a readable PNG/);
    await checkChange('res/mipmap-mdpi-v4/ic_launcher_round.png', encodePng(48, 48, Buffer.alloc(48 * 48 * 4)), /pixels differ/);
    await checkChange('res/drawable-mdpi-v4/ic_launcher_foreground.png', encodePng(108, 108, Buffer.alloc(108 * 108 * 4)), /pixels differ/);
    await checkChange('res/drawable-mdpi-v4/ic_launcher_background.png', encodePng(108, 108, Buffer.alloc(108 * 108 * 4)), /pixels differ/);
    const badCrc = Buffer.from(entries.find((entry) => entry.name === 'res/mipmap-mdpi-v4/ic_launcher.png').data);
    badCrc[badCrc.length - 1] ^= 1;
    await checkChange('res/mipmap-mdpi-v4/ic_launcher.png', badCrc, /CRC mismatch/);
    await writeFile(apkPath, buildZip(entries.map((entry) => entry.name.startsWith('res/mipmap-') ? { ...entry, name: `bogus/${entry.name}` } : entry)));
    assert.ok((await verifyApkIcons(apkPath)).problems.some((p) => /APK is missing res\/mipmap/.test(p)));
    await checkChange('res/mipmap-mdpi-v4/ic_launcher.png', encodePng(48, 48, Buffer.alloc(48 * 48 * 4, 255)), /does not contain the NYX AI logo/);
    await writeFile(apkPath, buildZip(entries.filter((entry) => entry.name !== 'res/drawable-mdpi-v4/ic_launcher_foreground.png')));
    const missingLayer = await verifyApkIcons(apkPath);
    assert.ok(missingLayer.problems.some((p) => /missing res\/drawable-mdpi\/ic_launcher_foreground/.test(p)));
    assert.ok(missingLayer.problems.some((p) => /foreground does not resolve to mdpi drawable/.test(p)));
    const brokenArchive = buildZip(entries);
    let cd = brokenArchive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    while (brokenArchive.readUInt32LE(cd) === 0x02014b50) {
      const nameLen = brokenArchive.readUInt16LE(cd + 28), extraLen = brokenArchive.readUInt16LE(cd + 30), commentLen = brokenArchive.readUInt16LE(cd + 32);
      if (brokenArchive.toString('utf8', cd + 46, cd + 46 + nameLen) === 'classes.dex') {
        brokenArchive.writeUInt32LE(0, brokenArchive.readUInt32LE(cd + 42) + 14); brokenArchive.writeUInt32LE(0, cd + 16); break;
      }
      cd += 46 + nameLen + extraLen + commentLen;
    }
    await writeFile(apkPath, brokenArchive);
    assert.ok((await verifyApkIcons(apkPath)).problems.some((p) => /ZIP CRC or size mismatch/.test(p)));
    await writeFile(apkPath, Buffer.from('not a zip'));
    assert.match((await verifyApkIcons(apkPath)).problems[0], /not a ZIP\/APK/);

    // The original unqualified paths remain supported, too.
    const unqualified = entries.map((entry) => ({ ...entry, name: entry.name.replace(/-v4\//, '/') }));
    unqualified.find((entry) => entry.name === 'resources.arsc').data = resourceTable({ qualifier: '' });
    await writeFile(apkPath, buildZip(unqualified));
    assert.deepEqual((await verifyApkIcons(apkPath)).problems, []);

    // An APK without the launcher icon must fail.
    const emptyPath = path.join(apk, 'empty.apk');
    await writeFile(emptyPath, buildZip([{ name: 'classes.dex', data: Buffer.from('x') }]));
    const missing = await verifyApkIcons(emptyPath);
    assert.equal(missing.problems.length, REQUIRED_FILES.length + 1);
    assert.ok(missing.problems.some((p) => /missing AndroidManifest.xml or resources.arsc/.test(p)));
    assert.equal(missing.problems.filter((p) => /APK is missing res\//.test(p)).length, REQUIRED_FILES.length);
    assert.equal(missing.matches.length, 0);
  } finally {
    await rm(out, { recursive: true, force: true });
    await rm(apk, { recursive: true, force: true });
    await rm('/tmp/nyx-icons-cli-ok', { recursive: true, force: true });
    await rm('/tmp/nyx-icons-cli-broken', { recursive: true, force: true });
  }
});

test('android icons: PNG supports four-bit indexed pixels and checks chunk integrity', () => {
  const pngChunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 4; ihdr[9] = 3;
  const data = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 7, 8, 9])),
    pngChunk('tRNS', Buffer.from([255, 128, 0, 255])),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0x01, 0x23]))), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.deepEqual([...decodePng(data).rgba], [255,0,0,255, 0,255,0,128, 0,0,255,0, 7,8,9,255]);
  ihdr[12] = 1;
  const interlaced = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 7, 8, 9])),
    pngChunk('tRNS', Buffer.from([255, 128, 0, 255])),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0x00, 0, 0x20, 0, 0x13]))), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.deepEqual([...decodePng(interlaced).rgba], [...decodePng(data).rgba]);
  const broken = Buffer.from(data); broken[broken.length - 1] ^= 1;
  assert.throws(() => decodePng(broken), /CRC mismatch/);
});

test('android icons: ZIP reader rejects bad CRC and unsupported compression', () => {
  const bad = buildZip([{ name: 'file', data: Buffer.from('content') }]);
  const cd = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bad.writeUInt32LE(0, 14); bad.writeUInt32LE(0, cd + 16);
  assert.throws(() => readZipEntries(bad).read('file'), /CRC or size mismatch/);
  const unsupported = buildZip([{ name: 'file', data: Buffer.from('content'), method: 99 }]);
  assert.throws(() => readZipEntries(unsupported), /unsupported ZIP compression method 99/);
});

test('android icons: image helpers behave (mask, resample, solid)', () => {
  const size = 8;
  const img = solidColor(size, [255, 0, 0, 255]);
  applyRoundMask(img, size);
  assert.ok(img[3] <= 8, 'corner is transparent after masking');
  assert.equal(img[((4 * size) + 4) * 4 + 3], 255, 'centre stays opaque');

  const big = solidColor(32, [0, 0, 0, 0]);
  for (let i = 3; i < big.length; i += 4) big[i] = 255;
  const small = resample(big, 32, 32, 16, 16);
  assert.equal(small.length, 16 * 16 * 4);
  assert.equal(small[3], 255, 'fully opaque source stays opaque');
  const flat = encodePng(2, 2, solidColor(2, [1, 2, 3, 255]));
  const back = decodePng(flat);
  assert.deepEqual([...back.rgba], [1, 2, 3, 255, 1, 2, 3, 255, 1, 2, 3, 255, 1, 2, 3, 255]);
});
