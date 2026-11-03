/**
 * Regenerates PNG icons from src/assets/logo/nyx-mark.svg.
 * The PNGs are committed, so you normally never run this. It needs sharp (not a project dependency):
 *   npm i --no-save sharp && node scripts/generate-icons.mjs
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'src/assets/logo/nyx-mark.svg'));
const out = (p) => path.join(root, p);

for (const size of [192, 512]) await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out(`src/assets/icons/icon-${size}.png`));

// Maskable / adaptive: full-bleed background with the mark inside the safe zone (~62%).
const inner = await sharp(svg, { density: 384 }).resize(318, 318).png().toBuffer();
const bg = { create: { width: 512, height: 512, channels: 4, background: '#07060f' } };
await sharp(bg).composite([{ input: inner, gravity: 'center' }]).png().toFile(out('src/assets/icons/icon-maskable-512.png'));

// Inputs for `npx @capacitor/assets generate --android` (see README).
await sharp(svg, { density: 512 }).resize(1024, 1024).png().toFile(out('resources/icon-only.png'));
await sharp(bg).resize(1024, 1024).png().toFile(out('resources/icon-background.png'));
const fg = await sharp(svg, { density: 512 }).resize(660, 660).png().toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: fg, gravity: 'center' }]).png().toFile(out('resources/icon-foreground.png'));
console.log('Icons written.');
