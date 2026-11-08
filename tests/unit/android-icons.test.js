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
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import {
  REQUIRED_FILES, expectedSizes, decodePng, encodePng, generateIcons, verifyIcons,
  verifyApkIcons, resample, applyRoundMask, solidColor, averageColor, isUniform,
} from '../../scripts/android-icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'android-icons.mjs');
const LOGO = path.join(ROOT, 'src', 'assets', 'logo', 'nyx-mark.png');

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

// --------------------------------------------------------------------------------------

test('android icons: the official logo is the only source and it is square', async () => {
  const logo = decodePng(await readFile(LOGO));
  assert.equal(logo.width, 512);
  assert.equal(logo.height, 512);
  assert.ok(logo.rgba.length === 512 * 512 * 4);
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

    // A realistic APK: every launcher icon resource plus unrelated entries, one deflated.
    const entries = [];
    for (const relative of REQUIRED_FILES) {
      entries.push({ name: `res/${relative}`, data: await readFile(path.join(out, relative)) });
    }
    entries.push({ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>'), method: 8 });
    entries.push({ name: 'classes.dex', data: Buffer.from('dex\n') });
    const apkPath = path.join(apk, 'app-debug.apk');
    await writeFile(apkPath, buildZip(entries));

    const result = await verifyApkIcons(apkPath);
    assert.deepEqual(result.problems, [], `packaged icons are valid: ${result.problems.join('; ')}`);
    assert.equal(result.matches.length, 20, 'every packaged raster is byte-identical to the generated set');

    // An APK without the launcher icon must fail.
    const emptyPath = path.join(apk, 'empty.apk');
    await writeFile(emptyPath, buildZip([{ name: 'classes.dex', data: Buffer.from('x') }]));
    const missing = await verifyApkIcons(emptyPath);
    assert.equal(missing.problems.length, REQUIRED_FILES.length);
    assert.ok(missing.problems.every((p) => /APK is missing res\//.test(p)));
    assert.equal(missing.matches.length, 0);
  } finally {
    await rm(out, { recursive: true, force: true });
    await rm(apk, { recursive: true, force: true });
    await rm('/tmp/nyx-icons-cli-ok', { recursive: true, force: true });
    await rm('/tmp/nyx-icons-cli-broken', { recursive: true, force: true });
  }
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
