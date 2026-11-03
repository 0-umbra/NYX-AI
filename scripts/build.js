/** Copies the web app into www/ (the Capacitor webDir). No bundling needed: the app is plain ES modules. */
import { cp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'www');
const ENTRIES = ['index.html', 'manifest.webmanifest', 'src'];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const entry of ENTRIES) await cp(path.join(ROOT, entry), path.join(OUT, entry), { recursive: true });
console.log(`Built ${ENTRIES.join(', ')} -> www/`);
