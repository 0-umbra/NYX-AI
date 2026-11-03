/**
 * Zero-dependency static dev server (`npm run dev`).
 * Serves only index.html, manifest.webmanifest and src/. Binds to 127.0.0.1 unless HOST is set
 * (e.g. HOST=0.0.0.0 npm run dev to open it from another device on your Wi-Fi).
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_TOP = new Set(['index.html', 'manifest.webmanifest', 'src']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

export function createDevServer(root = ROOT) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return send(res, 400, 'Bad request'); }
      if (pathname === '/healthz') return send(res, 200, 'ok');
      if (pathname === '/') pathname = '/index.html';
      if (pathname.includes('\0')) return send(res, 400, 'Bad request');

      const file = path.resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
      const top = path.relative(root, file).split(path.sep)[0];
      if (!ALLOWED_TOP.has(top)) return send(res, 404, 'Not found');

      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) return send(res, 404, 'Not found');
      const body = await readFile(file);
      send(res, 200, req.method === 'HEAD' ? '' : body, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    } catch (err) {
      console.error('[dev-server]', err);
      send(res, 500, 'Internal server error');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5173;
  const host = process.env.HOST || '127.0.0.1';
  const server = createDevServer();
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try: PORT=${port + 1} npm run dev` : err.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`NYX AI dev server running\n  Local: http://localhost:${port}/`);
    if (host === '0.0.0.0') console.log('  Also reachable from other devices on your network.');
    console.log('Press Ctrl+C to stop.');
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
