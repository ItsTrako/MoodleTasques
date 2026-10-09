// Tasques en Netlify: /api/config, /api/health y el puente con Moodle.
//
// Es lo mismo que hace server.js en tu ordenador, pero como función de Netlify.
// La app intenta primero hablar directamente con Moodle desde el navegador; el
// puente solo se usa si Moodle no lo permite (CORS). Mismas reglas que en local:
// solo peticiones de la propia web, solo el Moodle configurado, solo dos rutas,
// solo HTTPS, sin redirecciones, con límites de tamaño y sin registrar nada.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, proxyEnabled, proxyTarget, isJsonType, readCapped, PROXY_PATHS, MAX_BODY, UPSTREAM_TIMEOUT } from '../../server-lib.js';

// Netlify corta las respuestas de más de 6 MB; nos quedamos por debajo.
const MAX_UPSTREAM = 5 * 1024 * 1024;

function readJson(name) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const p of [resolve(process.cwd(), name), resolve(here, '../..', name), resolve(here, name)]) {
    try {
      return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
    } catch {
      /* siguiente */
    }
  }
  return {};
}

// Las variables de entorno de Netlify (opcionales) mandan sobre tasques.config.json.
export function loadConfig(env = process.env) {
  const file = readJson('tasques.config.json');
  const raw = {
    schoolName: env.SCHOOL_NAME || file.schoolName,
    moodleUrl: env.MOODLE_URL || file.moodleUrl,
    loginMode: env.LOGIN_MODE || file.loginMode,
    extraAllowedHosts: file.extraAllowedHosts,
  };
  try {
    return resolveConfig(raw, { env });
  } catch {
    return resolveConfig({}, { env });
  }
}

const cfg = loadConfig();
const version = readJson('package.json').version || '0';

const headers = (type) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
const text = (status, msg, extra = {}) => new Response(msg, { status, headers: { ...headers('text/plain; charset=utf-8'), ...extra } });
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: headers('application/json; charset=utf-8') });

export function sameSite(req) {
  const own = new URL(req.url).host.toLowerCase();
  const origin = req.headers.get('origin');
  let oh = null;
  try {
    oh = origin && origin !== 'null' ? new URL(origin).host.toLowerCase() : null;
  } catch {
    oh = null;
  }
  if (!oh || oh !== own) return false;
  const sfs = req.headers.get('sec-fetch-site');
  return !sfs || sfs === 'same-origin';
}

export async function handle(req, { config = cfg, fetchImpl = globalThis.fetch } = {}) {
  const { pathname } = new URL(req.url);
  const proxyOn = proxyEnabled(config);

  if (pathname === '/api/health' || pathname === '/api/config') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Método no permitido', { Allow: 'GET, HEAD' });
    if (pathname === '/api/health') return json(200, { app: 'tasques', version });
    return json(200, { ...config.publicConfig, proxy: proxyOn });
  }
  if (pathname !== '/api/proxy') return text(404, 'No encontrado');

  if (!proxyOn) return text(404, 'Proxy desactivado');
  if (req.method !== 'POST') return text(405, 'Método no permitido', { Allow: 'POST' });
  if (!sameSite(req)) return text(403, 'Origen no permitido');
  if (!isJsonType(req.headers.get('content-type'))) return text(415, 'Se esperaba JSON');
  if (Number(req.headers.get('content-length')) > MAX_BODY) return text(413, 'Petición demasiado grande');

  const raw = await readCapped(req.body, MAX_BODY);
  if (!raw) return text(413, 'Petición demasiado grande');
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return text(400, 'Petición no válida');
  }
  const { site, path, body } = payload || {};
  if (typeof site !== 'string' || typeof path !== 'string' || typeof body !== 'string') return text(400, 'Petición no válida');
  if (!PROXY_PATHS.has(path)) return text(403, 'Ruta no permitida');
  const target = proxyTarget(site, path, config.allowedSites, config.allowedHosts);
  if (!target) return text(403, 'Dirección de Moodle no permitida');

  try {
    const upstream = await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': `Tasques/${version}` },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    if (Number(upstream.headers.get('content-length')) > MAX_UPSTREAM) {
      await upstream.body?.cancel().catch(() => {});
      return text(502, 'Respuesta demasiado grande');
    }
    const buf = await readCapped(upstream.body, MAX_UPSTREAM);
    if (!buf) return text(502, 'Respuesta demasiado grande');
    return new Response(buf, { status: upstream.status, headers: headers('application/json; charset=utf-8') });
  } catch {
    return json(502, { exception: 'proxy', errorcode: 'network', message: 'No se ha podido contactar con Moodle desde el servidor.' });
  }
}

export default (req) => handle(req);

export const config = { path: ['/api/config', '/api/health', '/api/proxy'] };
