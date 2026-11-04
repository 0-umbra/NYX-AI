/** Builds the web app and bundles npm dependencies for Capacitor/WebView. */
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'www');
const ENTRIES = ['index.html', 'manifest.webmanifest', 'src'];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const entry of ENTRIES) {
  await cp(path.join(ROOT, entry), path.join(OUT, entry), { recursive: true });
}

await build({
  absWorkingDir: ROOT,
  entryPoints: ['src/js/app.js'],
  outfile: path.join(OUT, 'src/js/app.bundle.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
});

const htmlPath = path.join(OUT, 'index.html');
let html = await readFile(htmlPath, 'utf8');

const originalScript = '<script type="module" src="src/js/app.js"></script>';
if (!html.includes(originalScript)) {
  throw new Error('Expected application script reference was not found in index.html');
}

html = html.replace(
  originalScript,
  '<script type="module" src="src/js/app.bundle.js"></script>'
);

await writeFile(htmlPath, html);

console.log('Built original assets and bundled application -> www/');
