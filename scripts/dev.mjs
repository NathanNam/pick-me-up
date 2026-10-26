// Local preview: serves public/ and the api/ functions the way Vercel does.
//   node scripts/dev.mjs   → http://localhost:3000   (keys from .env.local)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../public');
const envFile = path.resolve(here, '../.env.local');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const fns = {
  '/api/events': await import('../api/events.mjs'),
  '/api/geocode': await import('../api/geocode.mjs'),
  '/api/plan': await import('../api/plan.mjs'),
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const port = Number(process.env.PORT) || 3000;
const security = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(root, '../vercel.json'), 'utf8')).headers[0].headers.map((h) => [h.key, h.value]));

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const fn = fns[url.pathname];
  if (fn) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
    const handler = fn[req.method];
    const r = handler ? await handler(request) : new Response('method not allowed', { status: 405 });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { ...security, 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Pick Me Up: http://localhost:${port}`));
