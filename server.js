#!/usr/bin/env node
// Servidor estático sin dependencias para Tasques.
//
// - Sirve /public con cabeceras de seguridad estrictas (CSP, HSTS, COOP...).
// - Opcional: un proxy hacia Moodle para cuando el navegador no puede hablar
//   con él directamente (CORS). Solo se activa si defines MOODLE_ALLOWED_HOSTS,
//   y solo reenvía a esos hosts y a dos rutas concretas, para no convertirse
//   en un proxy abierto. No registra ni guarda nada de lo que pasa por él.
//
//   PORT=8080 MOODLE_ALLOWED_HOSTS=campus.miinstituto.cat node server.js

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED = new Set(
  (process.env.MOODLE_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const PROXY_PATHS = new Set(['login/token.php', 'webservice/rest/server.php']);
const MAX_BODY = 16 * 1024;
const MAX_UPSTREAM = 8 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (process.env.HTTPS_BEHIND_PROXY === '1') res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT + sep)) return send(res, 403, 'Prohibido');
  try {
    const st = await stat(file);
    if (!st.isFile()) return send(res, 404, 'No encontrado');
    const body = await readFile(file);
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'No encontrado');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too-large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function proxy(req, res) {
  if (!ALLOWED.size) return send(res, 404, 'Proxy desactivado');
  if (req.method !== 'POST') return send(res, 405, 'Método no permitido');
  // Solo peticiones de la propia app (mismo origen).
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && new URL(origin).host !== host) return send(res, 403, 'Origen no permitido');
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, 'Se esperaba JSON');

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, 'Petición no válida');
  }
  const { site, path, body } = payload || {};
  if (typeof site !== 'string' || typeof path !== 'string' || typeof body !== 'string') return send(res, 400, 'Petición no válida');
  if (!PROXY_PATHS.has(path)) return send(res, 403, 'Ruta no permitida');
  let target;
  try {
    target = new URL(site.replace(/\/+$/, '') + '/' + path);
  } catch {
    return send(res, 400, 'Dirección no válida');
  }
  if (target.protocol !== 'https:' || !ALLOWED.has(target.hostname.toLowerCase()) || target.username || target.password || target.port) {
    return send(res, 403, 'Host no permitido');
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'Tasques/1.0' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_UPSTREAM) return send(res, 502, 'Respuesta demasiado grande');
    send(res, upstream.status, buf, 'application/json; charset=utf-8');
  } catch {
    send(res, 502, JSON.stringify({ exception: 'proxy', errorcode: 'network', message: 'No se ha podido contactar con Moodle desde el servidor.' }), 'application/json; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/proxy') return await proxy(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
    return await serveStatic(req, res);
  } catch {
    send(res, 500, 'Error interno');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tasques en http://${HOST}:${PORT}`);
  console.log(ALLOWED.size ? `Proxy activo para: ${[...ALLOWED].join(', ')}` : 'Proxy desactivado (define MOODLE_ALLOWED_HOSTS para activarlo).');
});
