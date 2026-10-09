// Lógica del servidor de Tasques, separada del arranque para poder probarla.
//
// - Configuración: lee tasques.config.json (sin secretos) y las variables de entorno.
// - Seguridad: lista de nombres de host válidos (DNS rebinding), mismo origen,
//   cabeceras estrictas y CSP.
// - Puente (proxy) con Moodle: solo dos rutas, solo HTTPS, solo hacia el Moodle
//   configurado (prefijo exacto) o hacia los hosts que autorices, con límites de
//   tamaño y de peticiones simultáneas. No registra ni guarda nada.

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export const PROXY_PATHS = new Set(['login/token.php', 'webservice/rest/server.php']);
export const MAX_BODY = 16 * 1024;
export const MAX_UPSTREAM = 8 * 1024 * 1024;
export const MAX_IN_FLIGHT = 4;
export const UPSTREAM_TIMEOUT = 20_000;
export const DEFAULT_PORT = 8080;

// Claves que nunca deben estar en tasques.config.json.
const SECRET_KEY = /token|pass|contrase|clave|secret/i;

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

// Respuesta a cualquier petición de un service worker (cabecera «Service-Worker: script»).
// Si otra web que usó esta misma dirección dejó un service worker, en su próxima
// comprobación recibe este script, que se da de baja y recarga las pestañas.
export const KILL_SWITCH_SW =
  "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.registration.unregister().then(()=>self.clients.matchAll()).then(cs=>cs.forEach(c=>c.navigate(c.url)))));";

export class ConfigError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

// --- Configuración -------------------------------------------------------------

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// Texto de tasques.config.json -> { cfg, ignored }. Quita el BOM que a veces añade
// el Bloc de notas y descarta (avisando) cualquier clave que parezca un secreto.
export function parseConfigText(text) {
  let cfg;
  try {
    cfg = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new ConfigError(
      'No se puede leer tasques.config.json.',
      `Revisa que sea JSON válido (comillas dobles, sin coma al final). Detalle: ${e.message}`
    );
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ConfigError('tasques.config.json no tiene el formato esperado.', 'Debe empezar por { y acabar por }, como el archivo original.');
  }
  const ignored = [];
  for (const k of Object.keys(cfg)) {
    if (SECRET_KEY.test(k)) {
      ignored.push(k);
      delete cfg[k];
    }
  }
  return { cfg, ignored };
}

// Dirección de Moodle canónica: https, sin credenciales, consulta ni fragmento,
// sin barras repetidas ni barra final. Igual que normalizeSiteUrl() del cliente.
export function normalizeMoodleUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  return u.origin + (parts.length ? '/' + parts.join('/') : '');
}

// Nombre de servidor de una entrada de MOODLE_ALLOWED_HOSTS o extraAllowedHosts
// ('campus.example.cat' o 'https://campus.example.cat/moodle'). '' si está vacía,
// null si no es un nombre válido.
function hostOf(entry) {
  const s = String(entry ?? '').trim().toLowerCase();
  if (!s) return '';
  try {
    const h = new URL(s.includes('://') ? s : 'https://' + s).hostname;
    return /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

// cfg (ya parseado) + entorno + argumentos -> configuración efectiva.
export function resolveConfig(cfg = {}, { env = {}, argv = [] } = {}) {
  const warnings = [];

  let port = DEFAULT_PORT;
  if (cfg.port !== undefined && cfg.port !== null && cfg.port !== '') {
    const p = Number(cfg.port);
    if (!validPort(p)) {
      throw new ConfigError(`El puerto «${cfg.port}» de tasques.config.json no es válido.`, 'Usa un número entre 1024 y 65535, por ejemplo 8080.');
    }
    port = p;
  }
  if (env.PORT !== undefined && env.PORT !== '') {
    const p = Number(env.PORT);
    if (validPort(p)) port = p;
    else warnings.push(`He ignorado PORT=${env.PORT} porque no es un puerto válido. Uso el ${port}.`);
  }

  let moodleUrl = null;
  if (cfg.moodleUrl) {
    moodleUrl = normalizeMoodleUrl(cfg.moodleUrl);
    if (!moodleUrl) {
      throw new ConfigError(
        `La dirección de Moodle «${cfg.moodleUrl}» de tasques.config.json no es válida.`,
        'Debe empezar por https://, por ejemplo https://educaciodigital.cat/iesgabrielamistral/moodle'
      );
    }
  }

  const allowedHosts = new Set();
  for (const entry of [...String(env.MOODLE_ALLOWED_HOSTS || '').split(','), ...(Array.isArray(cfg.extraAllowedHosts) ? cfg.extraAllowedHosts : [])]) {
    const h = hostOf(entry);
    if (h) allowedHosts.add(h);
    else if (h === null) warnings.push(`He ignorado «${String(entry).trim().slice(0, 80)}» de los servidores autorizados: no es un nombre de servidor válido.`);
  }

  let connectOrigin = null;
  if (cfg.lockToMoodle === true) {
    if (moodleUrl) connectOrigin = new URL(moodleUrl).origin;
    else warnings.push('He ignorado «lockToMoodle» porque falta «moodleUrl» en tasques.config.json.');
  }

  const schoolName =
    typeof cfg.schoolName === 'string' && cfg.schoolName.trim()
      ? cfg.schoolName.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80)
      : null;

  return {
    port,
    host: env.HOST || '127.0.0.1',
    publicHost: env.PUBLIC_HOST || '',
    open: !argv.includes('--no-open') && cfg.openBrowser !== false && !env.CI,
    moodleUrl,
    allowedSites: new Set(moodleUrl ? [moodleUrl.toLowerCase()] : []),
    allowedHosts,
    connectOrigin,
    publicConfig: {
      schoolName,
      moodleUrl,
      loginMode: cfg.loginMode === 'token' ? 'token' : 'password',
    },
    warnings,
  };
}

export const proxyEnabled = (cfg) => cfg.allowedSites.size > 0 || cfg.allowedHosts.size > 0;

// --- Comprobaciones de seguridad -----------------------------------------------

// Nombres con los que se puede llegar a este servidor. Cualquier otro (por ejemplo
// un dominio que alguien hace apuntar a 127.0.0.1) recibe 421.
export function okHosts(port, publicHost = '') {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  const set = new Set(names.map((n) => `${n}:${port}`));
  // En el puerto 80 el navegador no escribe el puerto en Host ni en Origin.
  if (Number(port) === 80) names.forEach((n) => set.add(n));
  for (const h of String(publicHost || '').split(',')) {
    const v = h.trim().toLowerCase();
    if (v) set.add(v);
  }
  return set;
}

export const hostAllowed = (hostHeader, hosts) => hosts.has(String(hostHeader || '').toLowerCase());

// El puente solo acepta peticiones hechas por la propia app: Origin obligatorio y
// de un host válido, y Sec-Fetch-Site (si llega) igual a same-origin.
export function sameOrigin(headers, hosts) {
  const origin = headers.origin;
  let oh = null;
  try {
    oh = origin && origin !== 'null' ? new URL(origin).host.toLowerCase() : null;
  } catch {}
  if (!oh || !hosts.has(oh)) return false;
  const sfs = headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin') return false;
  return true;
}

export const isJsonType = (ct) => String(ct || '').split(';')[0].trim().toLowerCase() === 'application/json';

// Segmentos que nunca forman parte de la raíz de un Moodle y que, delante de
// /login/token.php, harían que el servidor ejecutara otro script (PATH_INFO).
// Se mira también el texto decodificado («service.php%20», «x.php::$DATA»...).
function badSegment(seg) {
  if (!seg || /;|%(2f|5c|2e|00)/i.test(seg)) return true;
  let d;
  try {
    d = decodeURIComponent(seg);
  } catch {
    return true;
  }
  return /[\u0000-\u001f:\\]/.test(d) || /\.(php\d?|phtml|phar|cgi|pl|aspx?|jsp)[\s.]*$/i.test(d);
}

// URL final del puente, o null si no está permitida. `site` debe venir en forma
// canónica (como la produce el cliente) y coincidir con el Moodle configurado
// (prefijo exacto) o con un host autorizado.
export function proxyTarget(site, path, allowedSites, allowedHosts) {
  if (typeof site !== 'string' || typeof path !== 'string') return null;
  if (!PROXY_PATHS.has(path)) return null;
  let s;
  try {
    s = new URL(site);
  } catch {
    return null;
  }
  if (s.protocol !== 'https:' || s.search || s.hash || s.username || s.password || s.port || s.pathname.split('/').includes('..')) return null;
  const base = s.pathname.replace(/\/+$/, '');
  // Nada de «?», «#», «.», «..», «//» ni puertos escondidos en el texto original.
  if (site.replace(/\/+$/, '') !== s.origin + base) return null;
  if (base.split('/').slice(1).some(badSegment)) return null;
  const t = new URL(s.origin + base + '/' + path);
  if (t.pathname !== base + '/' + path || t.search) return null;
  return allowedSites.has((s.origin + base).toLowerCase()) || allowedHosts.has(s.hostname.toLowerCase()) ? t : null;
}

export function buildCsp(connectOrigin = null) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    connectOrigin ? `connect-src 'self' ${connectOrigin}` : "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

// Lee un cuerpo (ReadableStream) sin pasar de `max` bytes. Devuelve null si se pasa.
export async function readCapped(stream, max) {
  if (!stream) return Buffer.alloc(0);
  const r = stream.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await r.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts, n);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = (ch) => {
      size += ch.length;
      if (size > max) {
        req.off('data', onData);
        req.pause();
        reject(Object.assign(new Error('too-large'), { code: 'too-large' }));
      } else chunks.push(ch);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// --- Manejador HTTP ------------------------------------------------------------

export function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

// cfg: resultado de resolveConfig(). getPort(): puerto en el que escucha ahora.
export function createHandler({ cfg, root, version = '0', getPort, fetchImpl = globalThis.fetch, env = {} }) {
  const csp = buildCsp(cfg.connectOrigin);
  const proxyOn = proxyEnabled(cfg);
  const hsts = env.HTTPS_BEHIND_PROXY === '1';
  let inFlight = 0;

  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  async function serveStatic(req, res, rawPath) {
    let path;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return send(res, 400, 'Petición no válida');
    }
    if (path.includes('\0')) return send(res, 400, 'Petición no válida');
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep)) return send(res, 403, 'Prohibido');
    try {
      const st = await stat(file);
      if (!st.isFile()) return send(res, 404, 'No encontrado');
      const body = await readFile(file);
      const ext = extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      send(res, 404, 'No encontrado');
    }
  }

  async function proxy(req, res, hosts) {
    if (!proxyOn) return send(res, 404, 'Proxy desactivado');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, 'Método no permitido');
    }
    if (!sameOrigin(req.headers, hosts)) return send(res, 403, 'Origen no permitido');
    if (!isJsonType(req.headers['content-type'])) return send(res, 415, 'Se esperaba JSON');
    if (inFlight >= MAX_IN_FLIGHT) {
      res.setHeader('Retry-After', '2');
      return send(res, 429, 'Demasiadas peticiones');
    }
    inFlight++;
    try {
      let payload;
      try {
        payload = JSON.parse(await readBody(req, MAX_BODY));
      } catch (e) {
        if (e.code === 'too-large') {
          res.setHeader('Connection', 'close');
          return send(res, 413, 'Petición demasiado grande');
        }
        return send(res, 400, 'Petición no válida');
      }
      const { site, path, body } = payload || {};
      if (typeof site !== 'string' || typeof path !== 'string' || typeof body !== 'string') return send(res, 400, 'Petición no válida');
      if (!PROXY_PATHS.has(path)) return send(res, 403, 'Ruta no permitida');
      const target = proxyTarget(site, path, cfg.allowedSites, cfg.allowedHosts);
      if (!target) return send(res, 403, 'Dirección de Moodle no permitida');

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
          return send(res, 502, 'Respuesta demasiado grande');
        }
        const buf = await readCapped(upstream.body, MAX_UPSTREAM);
        if (!buf) return send(res, 502, 'Respuesta demasiado grande');
        return send(res, upstream.status, buf, 'application/json; charset=utf-8');
      } catch {
        return sendJson(res, 502, { exception: 'proxy', errorcode: 'network', message: 'No se ha podido contactar con Moodle desde el servidor.' });
      }
    } finally {
      inFlight--;
    }
  }

  return async function handler(req, res) {
    securityHeaders(res);
    try {
      const hosts = okHosts(getPort(), cfg.publicHost);
      if (!hostAllowed(req.headers.host, hosts)) return send(res, 421, 'Host no reconocido');

      if (req.headers['service-worker'] === 'script') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(KILL_SWITCH_SW);
      }

      let pathname;
      try {
        pathname = new URL(req.url, 'http://x').pathname;
      } catch {
        return send(res, 400, 'Petición no válida');
      }

      if (pathname === '/api/proxy') return await proxy(req, res, hosts);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return send(res, 405, 'Método no permitido');
      }
      if (pathname === '/api/health') return sendJson(res, 200, { app: 'tasques', version });
      if (pathname === '/api/config') return sendJson(res, 200, { ...cfg.publicConfig, proxy: proxyOn });
      return await serveStatic(req, res, pathname);
    } catch {
      if (!res.headersSent) send(res, 500, 'Error interno');
      else res.destroy();
    }
  };
}
