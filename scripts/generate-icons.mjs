/**
 * Regenerates the PNG icons and the Android icon sources from the NYX AI logo
 * (`src/assets/logo/nyx-mark.png`). The outputs are committed, so you normally never run this.
 * It needs sharp, which is not a project dependency:
 *   npm i --no-save sharp && node scripts/generate-icons.mjs
 *
 * The logo is only ever rescaled and centred, never cropped, recoloured or redrawn.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (p) => path.join(root, p);
const logo = out('src/assets/logo/nyx-mark-512.png');

const png = (image) => image.png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 });
const squared = (size) => sharp(logo).resize(size, size, { fit: 'fill' });

for (const size of [192, 512]) await png(squared(size)).toFile(out(`src/assets/icons/icon-${size}.png`));

// Maskable / adaptive: the logo inside the safe zone (~70%) on the app's black background.
const inner = await squared(360).png().toBuffer();
await png(sharp({ create: { width: 512, height: 512, channels: 4, background: '#000000' } })
  .composite([{ input: inner, gravity: 'center' }])).toFile(out('src/assets/icons/icon-maskable-512.png'));

// Inputs for `npx @capacitor/assets generate --android` (see README).
await png(squared(1024)).toFile(out('resources/icon-only.png'));
await png(sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#07060f' } }))
  .toFile(out('resources/icon-background.png'));
const fg = await squared(660).png().toBuffer();
await png(sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: fg, gravity: 'center' }])).toFile(out('resources/icon-foreground.png'));

console.log('Icons written.');
