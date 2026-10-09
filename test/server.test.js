import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  proxyTarget,
  okHosts,
  hostAllowed,
  sameOrigin,
  isJsonType,
  parseConfigText,
  resolveConfig,
  normalizeMoodleUrl,
  buildCsp,
  readCapped,
  createHandler,
  ConfigError,
  KILL_SWITCH_SW,
  MAX_IN_FLIGHT,
  MAX_UPSTREAM,
} from '../server-lib.js';

const SCHOOL = 'https://educaciodigital.cat/iesgabrielamistral/moodle';
const SITES = new Set([SCHOOL]);
const NO_HOSTS = new Set();
const LOCALHOST = new Set(['localhost']);
const ROOT = fileURLToPath(new URL('../public', import.meta.url));

test('proxyTarget: rejects sites that smuggle another path, query or fragment', () => {
  // Even with the whole host allowed, the target must stay <site>/<allowed path>.
  for (const site of [
    'https://localhost/admin/user.php?x=',
    'https://localhost/lib/ajax/service.php#',
    'https://localhost/a/../../user/edit.php?',
    'https://localhost/lib/ajax/service.php',
    'https://localhost/a%2Fb',
    'https://localhost/a;x=1',
    'https://localhost//moodle',
    'https://localhost/./moodle',
    'https://localhost:8443/moodle',
    'https://user:pw@localhost/moodle',
    'https://localhost/lib/ajax/service.php%20',
    'https://localhost/lib/ajax/service.php.',
    'https://localhost/lib/ajax/service.php::$DATA',
    'https://localhost/a%5cb',
    'https://localhost/a%00',
    'https://localhost/%E0%A4%A',
    'HTTPS://LOCALHOST/moodle',
    'https://localhost\\moodle',
  ]) {
    assert.equal(proxyTarget(site, 'login/token.php', SITES, LOCALHOST), null, site);
  }
});

test('proxyTarget: only the configured school, only https, only two paths', () => {
  assert.equal(proxyTarget('https://educaciodigital.cat/otroinstituto/moodle', 'login/token.php', SITES, NO_HOSTS), null);
  assert.equal(proxyTarget('https://educaciodigital.cat/iesgabrielamistral', 'login/token.php', SITES, NO_HOSTS), null);
  assert.equal(proxyTarget('https://educaciodigital.cat/iesgabrielamistral/moodle/extra', 'login/token.php', SITES, NO_HOSTS), null);
  assert.equal(proxyTarget('http://educaciodigital.cat/iesgabrielamistral/moodle', 'login/token.php', SITES, NO_HOSTS), null);
  assert.equal(proxyTarget(SCHOOL, 'admin/x.php', SITES, NO_HOSTS), null);
  assert.equal(proxyTarget(SCHOOL, '../login/token.php', SITES, NO_HOSTS), null);
  assert.equal(proxyTarget('not a url', 'login/token.php', SITES, NO_HOSTS), null);
  assert.equal(proxyTarget(null, 'login/token.php', SITES, NO_HOSTS), null);
});

test('proxyTarget: builds the school URL', () => {
  const t = proxyTarget(SCHOOL, 'login/token.php', SITES, NO_HOSTS);
  assert.ok(t instanceof URL);
  assert.ok(t.href.endsWith('/iesgabrielamistral/moodle/login/token.php'), t.href);
  assert.equal(t.href, SCHOOL + '/login/token.php');
  assert.equal(proxyTarget(SCHOOL + '/', 'webservice/rest/server.php', SITES, NO_HOSTS).href, SCHOOL + '/webservice/rest/server.php');
});

test('proxyTarget: host allowlist (MOODLE_ALLOWED_HOSTS / extraAllowedHosts) covers the whole host', () => {
  const hosts = new Set(['campus.example.cat']);
  assert.equal(proxyTarget('https://campus.example.cat', 'login/token.php', new Set(), hosts).href, 'https://campus.example.cat/login/token.php');
  assert.equal(proxyTarget('https://campus.example.cat/moodle', 'login/token.php', new Set(), hosts).href, 'https://campus.example.cat/moodle/login/token.php');
  assert.equal(proxyTarget('https://other.example.cat/moodle', 'login/token.php', new Set(), hosts), null);
  // What the client's normalizeSiteUrl() sends for a path with an accent or a space still works.
  const acc = new URL('https://campus.example.cat/Mòdul 2/moodle');
  assert.equal(proxyTarget(acc.origin + acc.pathname, 'login/token.php', new Set(), hosts).pathname, '/M%C3%B2dul%202/moodle/login/token.php');
});

test('okHosts: loopback names on the current port, plus PUBLIC_HOST', () => {
  const h = okHosts(8080);
  assert.ok(h.has('127.0.0.1:8080'));
  assert.ok(h.has('localhost:8080'));
  assert.ok(h.has('[::1]:8080'));
  assert.ok(!h.has('127.0.0.1:8081'));
  assert.ok(!h.has('evil.example'));
  assert.ok(!h.has('evil.example:8080'));
  assert.equal(h.size, 3);
  const p = okHosts(8080, 'Tasques.Example.cat');
  assert.ok(p.has('tasques.example.cat'));
  assert.ok(hostAllowed('LOCALHOST:8080', h));
  assert.ok(!hostAllowed(undefined, h));
  assert.ok(!hostAllowed('', h));
  // Browsers leave the default port out of Host and Origin.
  const p80 = okHosts(80);
  assert.ok(p80.has('127.0.0.1') && p80.has('localhost') && p80.has('[::1]') && p80.has('127.0.0.1:80'));
  assert.ok(!h.has('127.0.0.1'));
  assert.equal(sameOrigin({ origin: 'http://127.0.0.1' }, p80), true);
});

test('sameOrigin: Origin is required and must be ours; Sec-Fetch-Site must be same-origin', () => {
  const h = okHosts(8080);
  assert.equal(sameOrigin({}, h), false);
  assert.equal(sameOrigin({ origin: 'null' }, h), false);
  assert.equal(sameOrigin({ origin: '::bad::' }, h), false);
  assert.equal(sameOrigin({ origin: 'http://evil.example:8080' }, h), false);
  assert.equal(sameOrigin({ origin: 'http://127.0.0.1:8081' }, h), false);
  assert.equal(sameOrigin({ origin: 'http://127.0.0.1:8080' }, h), true);
  assert.equal(sameOrigin({ origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-origin' }, h), true);
  assert.equal(sameOrigin({ origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'cross-site' }, h), false);
  assert.equal(sameOrigin({ origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-site' }, h), false);
});

test('isJsonType: exact media type', () => {
  assert.ok(isJsonType('application/json'));
  assert.ok(isJsonType('application/json; charset=utf-8'));
  assert.ok(!isJsonType('application/jsonp'));
  assert.ok(!isJsonType('text/plain'));
  assert.ok(!isJsonType(undefined));
});

test('config: BOM, invalid JSON and secret keys', () => {
  const { cfg, ignored } = parseConfigText('\uFEFF{"moodleUrl":"' + SCHOOL + '","token":"abc","wsPassword":"x","claveMoodle":"y"}');
  assert.deepEqual(ignored, ['token', 'wsPassword', 'claveMoodle']);
  assert.deepEqual(Object.keys(cfg), ['moodleUrl']);
  assert.throws(() => parseConfigText('{"port": 8080,}'), ConfigError);
  assert.throws(() => parseConfigText('[1]'), ConfigError);
});

test('config: the committed tasques.config.json', () => {
  const text = readFileSync(new URL('../tasques.config.json', import.meta.url), 'utf8');
  const { cfg, ignored } = parseConfigText(text);
  assert.deepEqual(ignored, []);
  assert.equal(cfg.schoolName, 'IES Gabriela Mistral');
  assert.equal(cfg.moodleUrl, SCHOOL);
  assert.equal(cfg.loginMode, 'token');
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.openBrowser, true);
  assert.deepEqual(cfg.extraAllowedHosts, []);
  assert.equal(cfg.lockToMoodle, false);
  assert.doesNotMatch(text, /[0-9a-f]{32}/i, 'no tokens in the config file');

  const r = resolveConfig(cfg, { env: {}, argv: [] });
  assert.equal(r.port, 8080);
  assert.equal(r.host, '127.0.0.1');
  assert.equal(r.open, true);
  assert.deepEqual([...r.allowedSites], [SCHOOL]);
  assert.equal(r.allowedHosts.size, 0);
  assert.equal(r.connectOrigin, null);
  assert.deepEqual(r.publicConfig, { schoolName: 'IES Gabriela Mistral', moodleUrl: SCHOOL, loginMode: 'token' });
});

test('config: env, flags and validation', () => {
  const base = { moodleUrl: SCHOOL + '/', port: 8080, extraAllowedHosts: ['Campus.Example.cat'] };
  const r = resolveConfig(base, { env: { PORT: '8181', MOODLE_ALLOWED_HOSTS: 'a.example, b.example', HOST: '0.0.0.0', CI: '' }, argv: ['--no-open'] });
  assert.equal(r.port, 8181);
  assert.equal(r.host, '0.0.0.0');
  assert.equal(r.open, false);
  assert.equal(r.moodleUrl, SCHOOL);
  assert.deepEqual([...r.allowedHosts].sort(), ['a.example', 'b.example', 'campus.example.cat']);
  assert.equal(r.publicConfig.loginMode, 'password');

  const odd = resolveConfig({ extraAllowedHosts: ['https://Campus.Example.cat/moodle', 'a b', '*.cat', ''] }, { env: { MOODLE_ALLOWED_HOSTS: ' , x.example' } });
  assert.deepEqual([...odd.allowedHosts].sort(), ['campus.example.cat', 'x.example']);
  assert.equal(odd.warnings.length, 2);

  const bad = resolveConfig(base, { env: { PORT: '99999' } });
  assert.equal(bad.port, 8080);
  assert.equal(bad.warnings.length, 1);

  assert.throws(() => resolveConfig({ port: 'abc' }), ConfigError);
  assert.throws(() => resolveConfig({ moodleUrl: 'http://educaciodigital.cat/iesgabrielamistral/moodle' }), ConfigError);
  assert.equal(resolveConfig({ openBrowser: false }).open, false);

  const none = resolveConfig({}, { env: {} });
  assert.equal(none.allowedSites.size, 0);
  assert.equal(none.publicConfig.moodleUrl, null);
  assert.equal(none.publicConfig.schoolName, null);

  assert.equal(normalizeMoodleUrl('https://educaciodigital.cat//iesgabrielamistral/moodle//'), SCHOOL);
  assert.equal(normalizeMoodleUrl('https://x.cat/moodle?x=1'), null);
});

test('config: lockToMoodle pins connect-src to the Moodle origin', () => {
  const r = resolveConfig({ moodleUrl: SCHOOL, lockToMoodle: true });
  assert.equal(r.connectOrigin, 'https://educaciodigital.cat');
  assert.match(buildCsp(r.connectOrigin), /connect-src 'self' https:\/\/educaciodigital\.cat;/);
  assert.match(buildCsp(null), /connect-src 'self' https: http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*;/);
  const noUrl = resolveConfig({ lockToMoodle: true });
  assert.equal(noUrl.connectOrigin, null);
  assert.equal(noUrl.warnings.length, 1);
});

test('readCapped: stops past the cap', async () => {
  const stream = (n, chunk = 1024) =>
    new ReadableStream({
      start(c) {
        for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(chunk));
        c.close();
      },
    });
  assert.equal((await readCapped(stream(4), 8192)).length, 4096);
  assert.equal(await readCapped(stream(9), 8192), null);
  assert.equal((await readCapped(null, 10)).length, 0);
});

// --- HTTP handler, on an ephemeral port ------------------------------------------------

async function withServer(cfgIn, fn, fetchImpl) {
  const cfg = resolveConfig(cfgIn, { env: {}, argv: [] });
  let port = 0;
  const server = http.createServer(createHandler({ cfg, root: ROOT, version: '9.9.9', getPort: () => port, fetchImpl }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  try {
    await fn(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

function req(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const all = Object.fromEntries(Object.entries({ Host: `127.0.0.1:${port}`, ...headers }).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: all }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const proxyReq = (port, payload, extra = {}) =>
  req(port, {
    method: 'POST',
    path: '/api/proxy',
    headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(payload),
  });

test('http: health, config, headers, Host allowlist, bad escapes, service-worker kill switch', async () => {
  await withServer({ schoolName: 'IES Gabriela Mistral', moodleUrl: SCHOOL, loginMode: 'token' }, async (port) => {
    const h = await req(port, { path: '/api/health' });
    assert.equal(h.status, 200);
    assert.deepEqual(JSON.parse(h.text), { app: 'tasques', version: '9.9.9' });

    const c = await req(port, { path: '/api/config' });
    assert.equal(c.status, 200);
    assert.equal(c.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(c.text), { schoolName: 'IES Gabriela Mistral', moodleUrl: SCHOOL, loginMode: 'token', proxy: true });

    const page = await req(port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(page.headers['content-security-policy'], /connect-src 'self' https: /);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');

    const ico = await req(port, { method: 'HEAD', path: '/assets/tasques.ico' });
    assert.equal(ico.status, 200);
    assert.equal(ico.headers['content-type'], 'image/x-icon');

    assert.equal((await req(port, { path: '/', headers: { Host: 'evil.example' } })).status, 421);
    assert.equal((await req(port, { path: '/', headers: { Host: `evil.example:${port}` } })).status, 421);
    assert.equal((await req(port, { path: '/', headers: { Host: `localhost:${port}` } })).status, 200);
    assert.equal((await req(port, { path: '/%E0%A4%A' })).status, 400);
    assert.equal((await req(port, { path: '/%2e%2e/server.js' })).status, 404);
    assert.equal((await req(port, { path: '/nope.txt' })).status, 404);
    assert.equal((await req(port, { method: 'DELETE', path: '/' })).status, 405);

    const sw = await req(port, { path: '/sw.js', headers: { 'Service-Worker': 'script' } });
    assert.equal(sw.status, 200);
    assert.match(sw.headers['content-type'], /^text\/javascript/);
    assert.equal(sw.headers['cache-control'], 'no-store');
    assert.equal(sw.text, KILL_SWITCH_SW);
  });
});

test('http: proxy checks (origin, content type, site, size, concurrency)', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const fakeFetch = async (url, opts) => {
    calls++;
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.method, 'POST');
    if (opts.body === 'big') return new Response('x', { headers: { 'content-length': String(MAX_UPSTREAM + 1) } });
    if (opts.body === 'stream') {
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(1024 * 1024));
          },
        })
      );
    }
    if (opts.body === 'slow') await gate;
    return new Response(JSON.stringify({ url: String(url), body: opts.body }), { headers: { 'content-type': 'application/json' } });
  };
  await withServer(
    { moodleUrl: SCHOOL },
    async (port) => {
      const ok = { site: SCHOOL, path: 'login/token.php', body: 'username=a&password=b&service=moodle_mobile_app' };
      assert.equal((await proxyReq(port, ok, { Origin: undefined })).status, 403, 'no Origin');
      assert.equal((await proxyReq(port, ok, { Origin: 'null' })).status, 403);
      assert.equal((await proxyReq(port, ok, { Origin: 'http://evil.example' })).status, 403);
      assert.equal((await proxyReq(port, ok, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await proxyReq(port, ok, { 'Content-Type': 'application/jsonp' })).status, 415);
      assert.equal((await proxyReq(port, ok, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await req(port, { path: '/api/proxy' })).status, 405);
      assert.equal((await proxyReq(port, { ...ok, site: 'https://educaciodigital.cat/otroinstituto/moodle' })).status, 403);
      assert.equal((await proxyReq(port, { ...ok, path: 'admin/x.php' })).status, 403);
      assert.equal((await proxyReq(port, { ...ok, body: 1 })).status, 400);
      assert.equal(calls, 0);

      const good = await proxyReq(port, ok, { 'Sec-Fetch-Site': 'same-origin' });
      assert.equal(good.status, 200);
      assert.deepEqual(JSON.parse(good.text), { url: SCHOOL + '/login/token.php', body: ok.body });

      assert.equal((await proxyReq(port, { ...ok, body: 'big' })).status, 502);
      assert.equal((await proxyReq(port, { ...ok, body: 'stream' })).status, 502);
      assert.equal((await proxyReq(port, { ...ok, body: 'x'.repeat(20 * 1024) })).status, 413);

      const slow = Array.from({ length: MAX_IN_FLIGHT }, () => proxyReq(port, { ...ok, body: 'slow' }));
      await new Promise((r) => setTimeout(r, 100));
      assert.equal((await proxyReq(port, ok)).status, 429);
      release();
      for (const r of await Promise.all(slow)) assert.equal(r.status, 200);
      assert.equal((await proxyReq(port, ok)).status, 200);
    },
    fakeFetch
  );
});

test('http: proxy is off without a Moodle in the config', async () => {
  await withServer({}, async (port) => {
    const c = await req(port, { path: '/api/config' });
    assert.equal(JSON.parse(c.text).proxy, false);
    assert.equal((await proxyReq(port, { site: SCHOOL, path: 'login/token.php', body: '' })).status, 404);
  });
});

test('http: lockToMoodle sends the pinned CSP', async () => {
  await withServer({ moodleUrl: SCHOOL, lockToMoodle: true }, async (port) => {
    const page = await req(port, { path: '/' });
    assert.match(page.headers['content-security-policy'], /connect-src 'self' https:\/\/educaciodigital\.cat;/);
  });
});

// --- Windows launchers, icon and startup --------------------------------------------

test('windows: .cmd launchers are ASCII-only with CRLF line endings', () => {
  for (const name of ['Iniciar.cmd', 'CrearAccesoDirecto.cmd', 'Actualizar.cmd']) {
    const buf = readFileSync(new URL('../' + name, import.meta.url));
    assert.ok(buf.every((b) => b < 0x80), `${name} must be ASCII-only (cmd.exe reads it in the OEM code page)`);
    const text = buf.toString('latin1');
    assert.ok(text.endsWith('\r\n'), `${name} ends with CRLF`);
    assert.equal(text.split('\r\n').join('').includes('\n'), false, `${name} has a bare LF (check .gitattributes)`);
  }
  const shortcut = readFileSync(new URL('../CrearAccesoDirecto.cmd', import.meta.url), 'latin1');
  assert.match(shortcut, /public\\assets\\tasques\.ico/);
});

test('windows: tasques.ico is a PNG-in-ICO from 16 to 256 px', () => {
  const ico = readFileSync(new URL('../public/assets/tasques.ico', import.meta.url));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const n = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    sizes.push(ico[e] || 256);
    const off = ico.readUInt32LE(e + 12);
    const len = ico.readUInt32LE(e + 8);
    assert.ok(off + len <= ico.length);
    assert.equal(ico.subarray(off, off + 8).toString('hex'), '89504e470d0a1a0a', 'PNG payload');
  }
  assert.ok(sizes.includes(16) && sizes.includes(32) && sizes.includes(48) && sizes.includes(256), String(sizes));
});

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function runServer(port, args = ['--no-open']) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url)), ...args], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CI: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const until = (re, ms = 8000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (re.test(out)) return resolve(out);
        if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for ' + re + '\n' + out));
        setTimeout(tick, 50);
      };
      tick();
    });
  return { child, exited, until, output: () => out };
}

test('startup: a second copy on the same port sees Tasques running and exits 0', async () => {
  const port = await freePort();
  const first = runServer(port);
  try {
    await first.until(/Listo en http:\/\/127\.0\.0\.1:\d+\//);
    assert.match(first.output(), new RegExp(`127\\.0\\.0\\.1:${port}/`));
    const second = runServer(port);
    const code = await Promise.race([second.exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
    if (code === 'timeout') second.child.kill();
    assert.equal(code, 0, second.output());
    assert.match(second.output(), /Tasques ya estaba abierto en http:\/\/127\.0\.0\.1:\d+\//);
  } finally {
    first.child.kill();
    await first.exited;
  }
});

test('startup: a port held by another program falls back to the next one with a data warning', async () => {
  // Another program (not Tasques) on the preferred port.
  const other = http.createServer((q, r) => r.end('otro programa'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const port = other.address().port;
  const srv = runServer(port);
  try {
    const out = await srv.until(/Listo en http:\/\/127\.0\.0\.1:\d+\/|Error:/);
    assert.match(out, /lo est. usando otro programa/);
    const used = Number(/Listo en http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)?.[1]);
    assert.ok(used > port && used <= port + 9, out);
    assert.match(out, new RegExp(`Tus datos guardados est.n en http://127\\.0\\.0\\.1:${port}/`));
  } finally {
    srv.child.kill();
    await srv.exited;
    await new Promise((r) => other.close(r));
  }
});

test('startup: a broken tasques.config.json is reported in Spanish, not as a stack trace', async () => {
  const { mkdtempSync, writeFileSync, copyFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tasques-'));
  try {
    for (const f of ['server.js', 'server-lib.js', 'package.json']) copyFileSync(fileURLToPath(new URL('../' + f, import.meta.url)), join(dir, f));
    writeFileSync(join(dir, 'tasques.config.json'), '{"moodleUrl": "http://inseguro.example/moodle",}');
    const child = spawn(process.execPath, [join(dir, 'server.js'), '--no-open'], { env: { ...process.env, PORT: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 1);
    assert.match(out, /No se puede leer tasques\.config\.json/);
    assert.doesNotMatch(out, /at .*server-lib\.js:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
