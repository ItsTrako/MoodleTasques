import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, loadConfig, sameSite, config as routeConfig } from '../netlify/functions/api.mjs';

const SITE = 'https://tasques.example.netlify.app';
const MOODLE = 'https://educaciodigital.cat/iesgabrielamistral/moodle';
const cfg = loadConfig({});

const post = (body, headers = {}) =>
  new Request(SITE + '/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE, 'Sec-Fetch-Site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const okFetch = (calls, reply = '{"ok":1}', extraHeaders = {}) => async (url, opts) => {
  calls.push({ url: String(url), opts });
  return new Response(reply, { status: 200, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
};

test('la función atiende solo sus tres rutas', () => {
  assert.deepEqual(routeConfig.path, ['/api/config', '/api/health', '/api/proxy']);
});

test('la configuración sale de tasques.config.json y las variables de Netlify mandan', () => {
  assert.equal(cfg.publicConfig.moodleUrl, MOODLE);
  assert.equal(cfg.publicConfig.loginMode, 'token');
  const other = loadConfig({ MOODLE_URL: 'https://moodle.altre.cat/', SCHOOL_NAME: 'Institut Altre' });
  assert.equal(other.publicConfig.moodleUrl, 'https://moodle.altre.cat');
  assert.equal(other.publicConfig.schoolName, 'Institut Altre');
  // Una dirección no válida no rompe la función: se queda sin Moodle preconfigurado.
  assert.equal(loadConfig({ MOODLE_URL: 'http://inseguro.cat' }).publicConfig.moodleUrl, null);
});

test('/api/config y /api/health', async () => {
  const c = await handle(new Request(SITE + '/api/config'), { config: cfg });
  assert.equal(c.status, 200);
  assert.equal(c.headers.get('cache-control'), 'no-store');
  const body = await c.json();
  assert.deepEqual(Object.keys(body).sort(), ['loginMode', 'moodleUrl', 'proxy', 'schoolName']);
  assert.equal(body.proxy, true);
  const hres = await handle(new Request(SITE + '/api/health'), { config: cfg });
  assert.equal((await hres.json()).app, 'tasques');
  assert.equal((await handle(new Request(SITE + '/api/config', { method: 'POST' }), { config: cfg })).status, 405);
});

test('el puente reenvía al Moodle del centro', async () => {
  const calls = [];
  const res = await handle(post({ site: MOODLE, path: 'webservice/rest/server.php', body: 'wstoken=x&wsfunction=y' }), { config: cfg, fetchImpl: okFetch(calls) });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":1}');
  assert.equal(calls[0].url, MOODLE + '/webservice/rest/server.php');
  assert.equal(calls[0].opts.redirect, 'error');
  assert.equal(calls[0].opts.body, 'wstoken=x&wsfunction=y');
});

test('el puente rechaza lo que no toca', async () => {
  const calls = [];
  const f = okFetch(calls);
  const good = { site: MOODLE, path: 'login/token.php', body: 'a=b' };
  const cases = [
    [post(good, { Origin: 'https://evil.example' }), 403],
    [post(good, { Origin: '' }), 403],
    [post(good, { 'Sec-Fetch-Site': 'cross-site' }), 403],
    [post(good, { 'Content-Type': 'text/plain' }), 415],
    [post({ ...good, site: 'https://educaciodigital.cat/altreinstitut/moodle' }), 403],
    [post({ ...good, site: 'http://educaciodigital.cat/iesgabrielamistral/moodle' }), 403],
    [post({ ...good, path: 'admin/index.php' }), 403],
    [post({ ...good, site: MOODLE + '?x=1' }), 403],
    [post('{no json'), 400],
    [post({ site: MOODLE, path: 'login/token.php', body: 5 }), 400],
    [post({ ...good, body: 'x'.repeat(20_000) }), 413],
    [new Request(SITE + '/api/proxy', { method: 'GET' }), 405],
    [new Request(SITE + '/api/otra'), 404],
  ];
  for (const [req, status] of cases) {
    const res = await handle(req, { config: cfg, fetchImpl: f });
    assert.equal(res.status, status, `${req.method} ${req.headers.get('origin')} -> ${status}`);
  }
  assert.equal(calls.length, 0, 'ninguna petición rechazada llega a Moodle');
});

test('respuestas demasiado grandes y errores de red', async () => {
  const big = await handle(post({ site: MOODLE, path: 'login/token.php', body: '' }), { config: cfg, fetchImpl: okFetch([], '{}', { 'Content-Length': String(9 * 1024 * 1024) }) });
  assert.equal(big.status, 502);
  const down = await handle(post({ site: MOODLE, path: 'login/token.php', body: '' }), {
    config: cfg,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(down.status, 502);
  assert.equal((await down.json()).errorcode, 'network');
});

test('sin Moodle configurado el puente está apagado', async () => {
  const off = loadConfig({ MOODLE_URL: 'http://inseguro.cat' });
  const blank = { ...off, allowedSites: new Set(), allowedHosts: new Set() };
  const res = await handle(post({ site: MOODLE, path: 'login/token.php', body: '' }), { config: blank });
  assert.equal(res.status, 404);
});

test('sameSite compara el origen con la propia web', () => {
  assert.equal(sameSite(new Request(SITE + '/api/proxy', { method: 'POST', headers: { Origin: SITE } })), true);
  assert.equal(sameSite(new Request(SITE + '/api/proxy', { method: 'POST', headers: { Origin: 'null' } })), false);
});
