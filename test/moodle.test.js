import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MoodleClient,
  MoodleError,
  FRIENDLY,
  friendlyMessage,
  tokenErrorMessage,
  normalizeSiteUrl,
  safeMoodleLink,
  decodeEntities,
  pickLang,
  textOf,
  plainText,
  eventToTask,
} from '../public/js/moodle.js';

const SITE = 'https://c.example';
const TOKEN = 'f'.repeat(32);
const NOW = Date.UTC(2026, 9, 9, 8);

// Respuesta falsa de fetch.
const reply = (data, { status = 200, type = 'application/json; charset=utf-8' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': type }),
  json: async () => (typeof data === 'string' ? JSON.parse(data) : data),
});
const client = (fetchImpl, extra = {}) => new MoodleClient({ siteUrl: SITE, token: TOKEN, transport: 'direct', fetchImpl, ...extra });
const typeError = () => new TypeError('Failed to fetch');
const named = (name) => new DOMException('falló', name);

// ---------------------------------------------------------------------------
// Direcciones y enlaces
// ---------------------------------------------------------------------------

test('normaliza la dirección de Moodle', () => {
  assert.equal(normalizeSiteUrl('campus.example.cat'), 'https://campus.example.cat');
  assert.equal(normalizeSiteUrl('https://example.cat/moodle/my/'), 'https://example.cat/moodle');
  assert.equal(normalizeSiteUrl('https://example.cat/login/index.php'), 'https://example.cat');
  assert.equal(normalizeSiteUrl('educaciodigital.cat/iesgabrielamistral/moodle/course/view.php?id=3'), 'https://educaciodigital.cat/iesgabrielamistral/moodle');
  assert.throws(() => normalizeSiteUrl('http://example.cat'), (e) => e.code === 'insecure' && /https/.test(e.message));
  assert.throws(() => normalizeSiteUrl('https://user:pw@example.cat'), /credenciales/);
  assert.throws(() => normalizeSiteUrl(''), (e) => e instanceof MoodleError && e.code === 'nourl');
  assert.throws(() => normalizeSiteUrl('https://exa mple'), (e) => e.code === 'badurl');
  assert.equal(normalizeSiteUrl('http://localhost:8000'), 'http://localhost:8000');
});

test('solo se aceptan enlaces del propio Moodle', () => {
  const site = 'https://campus.example.cat';
  assert.equal(safeMoodleLink('https://campus.example.cat/mod/assign/view.php?id=4', site), 'https://campus.example.cat/mod/assign/view.php?id=4');
  assert.equal(safeMoodleLink('/mod/quiz/view.php?id=2', site), 'https://campus.example.cat/mod/quiz/view.php?id=2');
  assert.equal(safeMoodleLink('javascript:alert(1)', site), null);
  assert.equal(safeMoodleLink('https://evil.example/phish', site), null);
  assert.equal(safeMoodleLink('', site), null);
});

// ---------------------------------------------------------------------------
// Texto: idiomas, etiquetas, entidades y controles bidi
// ---------------------------------------------------------------------------

test('decodifica entidades sin interpretar HTML', () => {
  assert.equal(decodeEntities('R&amp;D &lt;b&gt; Matem&#224;tiques &#x27;x&#x27;'), "R&D <b> Matemàtiques 'x'");
  assert.equal(decodeEntities('&bogus; &#0;'), '&bogus; &#0;');
  assert.equal(decodeEntities(null), '');
});

test('pickLang: spans multilang en los dos órdenes de atributos', () => {
  const classFirst = '<span class="multilang" lang="ca">Matemàtiques II</span><span class="multilang" lang="es">Matemáticas II</span>';
  const langFirst = "<span lang='ca' class='multilang'>Matemàtiques II</span> <span lang='es' class='multilang'>Matemáticas II</span>";
  for (const s of [classFirst, langFirst]) {
    assert.equal(pickLang(s, 'es'), 'Matemáticas II');
    assert.equal(pickLang(s, 'ca'), 'Matemàtiques II');
    assert.equal(pickLang(s, 'en'), 'Matemáticas II', 'sin el preferido, castellano');
  }
  const caEn = '<span lang="en" class="multilang">History</span><span lang="ca_valencia" class="multilang">Història</span>';
  assert.equal(pickLang(caEn, 'fr'), 'Història', 'sin pref ni es, catalán');
  assert.equal(pickLang(caEn, 'en'), 'History');
  const other = '<span lang="de" class="multilang">Geschichte</span><span lang="fr" class="multilang">Histoire</span>';
  assert.equal(pickLang(other, 'es'), 'Geschichte', 'si no, el primero');
  assert.equal(pickLang('Tema 1: <span lang="ca" class="multilang">Història</span><span lang="es" class="multilang">Historia</span> (2n)', 'es'), 'Tema 1: Historia (2n)');
  assert.equal(pickLang('Sin idiomas', 'es'), 'Sin idiomas');
  assert.equal(pickLang('<span lang="ca">Normal</span>', 'es'), '<span lang="ca">Normal</span>', 'un span sin multilang no se toca');
});

test('pickLang: bloques {mlang}', () => {
  const s = '{mlang ca}Història{mlang}{mlang es}Historia{mlang}';
  assert.equal(pickLang(s, 'es'), 'Historia');
  assert.equal(pickLang(s, 'ca'), 'Història');
  assert.equal(pickLang(s, 'en'), 'Historia');
  assert.equal(pickLang('{mlang other}Hello{mlang}{mlang ca}Hola{mlang}', 'fr'), 'Hola');
  assert.equal(pickLang('4t ESO {mlang ca}Ciències{mlang} {mlang es}Ciencias{mlang}', 'es'), '4t ESO Ciencias');
  assert.equal(textOf('{mlang ca}Història{mlang}{mlang es}Historia{mlang}', 200, 'ca'), 'Història');
});

test('textOf deja una sola línea de texto plano', () => {
  assert.equal(textOf('Campus Virtual Institut <b>Test</b>', 200), 'Campus Virtual Institut Test');
  assert.equal(textOf('Matem<b>à</b>tiques', 200), 'Matemàtiques');
  assert.equal(textOf('Línea 1<br>Línea 2', 200), 'Línea 1 Línea 2');
  assert.equal(textOf('  R&amp;D \n\t  2  ', 200), 'R&D 2');
  assert.equal(textOf('Eva‮.gnp', 200), 'Eva.gnp');
  assert.equal(textOf('Eva&#x202E;.gnp &#x2066;x&#x2069;', 200), 'Eva.gnp x');
  assert.equal(textOf('abcdef', 3), 'abc');
  assert.equal(textOf(undefined, 10), '');
  assert.equal(textOf('&lt;script&gt;', 50), '<script>', 'las entidades se quedan como texto');
  assert.equal(textOf('<script>alert(1)</script>Tema <style>.x{}</style>4', 50), 'Tema 4', 'sin código');
  assert.equal(textOf('<span lang="ca" class="multilang">A <b>x</b></span><span lang="es" class="multilang">B <i>y</i></span>', 50), 'B y');
});

test('decodeEntities no crea sustitutos sueltos', () => {
  assert.equal(decodeEntities('&#xD800;&#55296;'), '&#xD800;&#55296;');
  assert.equal(decodeEntities('&#x1F600;'), '\u{1F600}');
  assert.equal(decodeEntities('&#1114112;'), '&#1114112;');
});

test('plainText conserva saltos de línea sencillos', () => {
  const html = '<p>Hola <b>món</b></p>\n\n<p>Línia&nbsp;2<br/>Línia   3</p><ul><li>a</li><li>b</li></ul><script>alert(1)</script>';
  assert.equal(plainText(html), 'Hola món\nLínia 2\nLínia 3\na\nb');
  assert.equal(plainText('x'.repeat(700)).length, 600);
  assert.equal(plainText(null), '');
});

// ---------------------------------------------------------------------------
// Eventos de Moodle a tareas
// ---------------------------------------------------------------------------

const event = (extra = {}) => ({
  id: 9,
  name: 'X vence',
  activityname: 'Pràctica 3',
  activitystr: 'La tasca venç',
  modulename: 'assign',
  instance: 412,
  eventtype: 'due',
  timesort: NOW / 1000,
  overdue: false,
  description: '<p>Entregueu un <b>PDF</b>.</p><p>Màxim 2 pàgines.</p>',
  course: { id: 7, fullname: 'Programació', shortname: 'PWEB' },
  action: { name: 'Afegeix una tramesa', url: 'https://c.example/mod/assign/view.php?id=412&action=editsubmission', actionable: true },
  url: 'https://c.example/mod/assign/view.php?id=412',
  ...extra,
});

test('convierte eventos de Moodle', () => {
  const t = eventToTask(event(), SITE);
  assert.deepEqual(t, {
    id: 'ev9',
    title: 'Pràctica 3',
    kind: 'assign',
    kindLabel: 'La tasca venç',
    courseId: 7,
    courseName: 'Programació',
    courseShort: 'PWEB',
    due: NOW,
    overdue: false,
    url: 'https://c.example/mod/assign/view.php?id=412&action=editsubmission',
    actionName: 'Afegeix una tramesa',
    actionable: true,
    cmid: 412,
    instance: 412,
    eventtype: 'due',
    description: 'Entregueu un PDF.\nMàxim 2 pàgines.',
    source: 'moodle',
  });
});

test('eventToTask descarta fechas imposibles', () => {
  assert.equal(eventToTask(event({ timesort: 1e13 }), SITE), null);
  assert.equal(eventToTask(event({ timesort: 'mañana' }), SITE), null);
  assert.equal(eventToTask(event({ timesort: 0 }), SITE), null);
  assert.equal(eventToTask(event({ timesort: -5 }), SITE), null);
  assert.equal(eventToTask(event({ timesort: undefined, timestart: undefined }), SITE), null);
  assert.equal(eventToTask(event({ timesort: undefined, timestart: NOW / 1000 }), SITE).due, NOW);
  assert.equal(eventToTask(event({ id: undefined }), SITE), null);
  assert.equal(eventToTask(event({ id: '' }), SITE), null);
  assert.equal(eventToTask(event({ id: 0 }), SITE).id, 'ev0');
  assert.equal(eventToTask(event({ timesort: String(NOW / 1000) }), SITE).due, NOW);
  assert.equal(eventToTask(null, SITE), null);
  assert.equal(eventToTask(event({ timesort: Date.UTC(2099, 11, 31) / 1000 }), SITE).due, Date.UTC(2099, 11, 31));
});

test('eventToTask conserva actionable=false y enlaza a la actividad', () => {
  const t = eventToTask(event({ action: { name: 'Afegeix una tramesa', url: 'https://c.example/mod/assign/view.php?id=412&action=editsubmission', actionable: false } }), SITE);
  assert.equal(t.actionable, false);
  assert.equal(t.url, 'https://c.example/mod/assign/view.php?id=412');
  assert.equal(eventToTask(event({ action: null }), SITE).actionable, true);
  assert.equal(eventToTask(event({ action: null }), SITE).url, 'https://c.example/mod/assign/view.php?id=412');
  assert.equal(eventToTask(event({ url: 'https://evil.example/x', action: null }), SITE).url, null);
});

test('eventToTask limpia nombres multilingües, HTML y bidi', () => {
  const t = eventToTask(
    event({
      activityname: '<span lang="ca" class="multilang">Comentari</span><span lang="es" class="multilang">Comentario</span>',
      modulename: 'bigbluebuttonbn',
      instance: 'x',
      course: { id: '12', fullname: '{mlang ca}Història{mlang}{mlang es}Historia{mlang}', shortname: 'HIS‮' },
      action: { name: '<b>Entrega</b>' },
      eventtype: 'x'.repeat(80),
    }),
    SITE
  );
  assert.equal(t.title, 'Comentario');
  assert.equal(t.kind, 'other');
  assert.equal(t.courseName, 'Historia');
  assert.equal(t.courseShort, 'HIS');
  assert.equal(t.courseId, 12);
  assert.equal(t.actionName, 'Entrega');
  assert.equal(t.cmid, 0);
  assert.equal(t.eventtype.length, 40);
  assert.equal(eventToTask(event({ activityname: '', name: '' }), SITE).title, 'Actividad sin nombre');
  assert.equal(eventToTask(event({ course: null }), SITE).courseName, 'Sin asignatura');
  assert.equal(eventToTask(event({ activityname: '<span lang="ca" class="multilang">Debat</span>' }), SITE, 'ca').title, 'Debat');
});

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

test('call() pide los filtros de idioma y el token viaja en el cuerpo', async () => {
  const calls = [];
  const c = client(async (url, opts) => {
    calls.push({ url, body: opts.body.toString(), opts });
    return reply({ userid: 5 });
  });
  await c.siteInfo();
  const body = new URLSearchParams(calls[0].body);
  assert.equal(calls[0].url, 'https://c.example/webservice/rest/server.php');
  assert.equal(body.get('moodlewssettingfilter'), 'true');
  assert.equal(body.has('moodlewssettinglang'), false);
  assert.equal(body.get('wstoken'), TOKEN);
  assert.equal(body.get('wsfunction'), 'core_webservice_get_site_info');
  assert.ok(!calls[0].url.includes('wstoken'));
  assert.equal(calls[0].opts.credentials, 'omit');
  assert.ok(calls[0].opts.signal instanceof AbortSignal, 'cada petición lleva un plazo');
});

test('se pagina la línea de tiempo sin duplicados', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const p = new URLSearchParams(opts.body.toString());
    calls.push(p);
    const after = Number(p.get('aftereventid') || 0);
    const events = after ? [{ id: 51 }] : Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    return reply({ events });
  };
  const evs = await client(fetchImpl).actionEvents({ fromSeconds: 1000 });
  assert.equal(evs.length, 51);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].get('timesortfrom'), '1000');
  assert.equal(calls[1].get('aftereventid'), '50');

  // Si Moodle vuelve a empezar (repite la misma página), se para.
  let n = 0;
  const loop = async () => {
    n++;
    return reply({ events: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })) });
  };
  const again = await client(loop).actionEvents({ fromSeconds: 0 });
  assert.equal(again.length, 50);
  assert.equal(n, 2);

  // Páginas solapadas: cada evento una sola vez.
  const overlap = async (url, opts) => {
    const after = Number(new URLSearchParams(opts.body.toString()).get('aftereventid') || 0);
    const start = after ? after - 10 : 0;
    const events = Array.from({ length: after ? 20 : 50 }, (_, i) => ({ id: start + i + 1 }));
    return reply({ events });
  };
  const ids = (await client(overlap).actionEvents({ fromSeconds: 0 })).map((e) => e.id);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.length, 60);
});

test('login guarda el token y valida su formato', async () => {
  const c = new MoodleClient({ siteUrl: SITE, transport: 'direct', fetchImpl: async () => reply({ token: 'a'.repeat(32), privatetoken: 'x' }) });
  assert.equal(await c.login('pau', 'secret'), 'a'.repeat(32));
  assert.equal(c.token, 'a'.repeat(32));
  const bad = new MoodleClient({ siteUrl: SITE, transport: 'direct', fetchImpl: async () => reply({ token: 'nope' }) });
  await assert.rejects(bad.login('pau', 'secret'), (e) => e.code === 'notoken');
  const noToken = new MoodleClient({ siteUrl: SITE, transport: 'direct', fetchImpl: async () => reply({}) });
  await assert.rejects(noToken.siteInfo(), (e) => e.code === 'notoken');
});

test('los errores de Moodle se traducen y nunca muestran el texto del servidor', async () => {
  const fails = (payload, opts) => client(async () => reply(payload, opts)).siteInfo();
  await assert.rejects(fails({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }), (e) => e instanceof MoodleError && e.code === 'invalidtoken' && e.message === 'Moodle ha rechazado el acceso guardado. Vuelve a conectar.');
  await assert.rejects(fails({ exception: 'webservice_access_exception', errorcode: 'accessexception', message: 'Access control exception' }), (e) => e.code === 'accessexception' && e.message === FRIENDLY.invalidtoken);
  await assert.rejects(fails({ error: 'Invalid login, please try again', errorcode: 'invalidlogin' }), (e) => e.code === 'invalidlogin' && e.message === 'Usuario o contraseña incorrectos. ¿Entras en Moodle con Google o XTEC? Usa «Tengo un token».');
  await assert.rejects(fails({ exception: 'moodle_exception', errorcode: 'sitepolicynotagreed', message: 'Cal acceptar la política' }), (e) => e.code === 'sitepolicynotagreed' && /normas de uso/.test(e.message));
  await assert.rejects(fails({ exception: 'x', errorcode: 'weirdcode', message: '<b>Texto del servidor</b>' }), (e) => e.code === 'weirdcode' && e.message === 'Moodle ha devuelto un error (weirdcode).');
  await assert.rejects(fails({ exception: 'x', errorcode: 'constructor', message: 'x' }), (e) => e.message === 'Moodle ha devuelto un error (constructor).');
  await assert.rejects(fails({ exception: 'x', message: 'solo texto' }), (e) => e.code === 'moodle' && e.message === 'Moodle ha devuelto un error.');
  await assert.rejects(fails({ exception: 'x', errorcode: '<img src=x>' }), (e) => e.code === 'moodle');
});

test('códigos HTTP y respuestas que no son de Moodle', async () => {
  const html = { json: async () => JSON.parse('<html>') };
  const status = (s) => client(async () => ({ ok: false, status: s, headers: new Headers({ 'content-type': 'text/html' }), ...html })).siteInfo();
  await assert.rejects(status(503), (e) => e.code === 'http503' && e.message === FRIENDLY.sitemaintenance);
  await assert.rejects(status(404), (e) => e.code === 'http404' && e.message === 'No encontramos Moodle en esa dirección. En educaciodigital.cat suele acabar en /moodle.');
  await assert.rejects(status(500), (e) => e.code === 'http500' && e.message === 'Moodle ha devuelto un error (500).');
  const notJson = client(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), ...html }));
  await assert.rejects(notJson.siteInfo(), (e) => e.code === 'badjson' && e.message === FRIENDLY.http404);
  // El puente local responde 502 con un código de Moodle.
  const bridge = client(async () => reply({ exception: 'proxy', errorcode: 'network', message: 'x' }, { status: 502 }), { transport: 'proxy' });
  await assert.rejects(bridge.siteInfo(), (e) => e.code === 'network');
});

test('friendlyMessage y el mensaje del token', () => {
  assert.equal(friendlyMessage('http503'), 'Moodle está en mantenimiento. Prueba más tarde.');
  assert.equal(friendlyMessage('badjson'), 'No encontramos Moodle en esa dirección. En educaciodigital.cat suele acabar en /moodle.');
  assert.equal(friendlyMessage('network'), 'No hemos podido conectar con tu Moodle. Revisa la dirección y tu conexión a Internet.');
  assert.equal(friendlyMessage('usernotfullysetup'), 'Completa tu perfil en la web de Moodle.');
  assert.equal(friendlyMessage('wsaccessusernologin'), friendlyMessage('usernotconfirmed'));
  assert.equal(friendlyMessage('http418'), 'Moodle ha devuelto un error (418).');
  assert.equal(friendlyMessage('raro'), 'Moodle ha devuelto un error (raro).');
  assert.equal(
    tokenErrorMessage(),
    'Ese token no funciona en este Moodle. Comprueba que lo has copiado entero (32 letras y números) y que es del servicio «Moodle mobile web service».'
  );
  // Sin rayas ni emojis en los textos para la persona.
  for (const msg of [...Object.values(FRIENDLY), tokenErrorMessage()]) {
    assert.ok(!/[\u2013\u2014]/.test(msg), msg);
    assert.ok(!/\p{Extended_Pictographic}/u.test(msg), msg);
  }
});

// ---------------------------------------------------------------------------
// Red: plazo, sin conexión, puente local y cancelación
// ---------------------------------------------------------------------------

test('un Moodle lento da "timeout" sin probar el puente', async () => {
  const urls = [];
  const c = client(
    async (url) => {
      urls.push(url);
      throw named('TimeoutError');
    },
    { transport: 'auto' }
  );
  await assert.rejects(c.siteInfo(), (e) => e.code === 'timeout' && e.message === 'Moodle tarda demasiado en responder. Prueba en un momento.');
  assert.equal(urls.length, 1);
});

test('el plazo real corta la petición', async () => {
  const c = client((url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))));
  // Un plazo muy corto para no esperar 25 s. (El temporizador de
  // AbortSignal.timeout no mantiene vivo el proceso de pruebas, así que se
  // imita con uno normal.)
  c.requestSignal = () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(named('TimeoutError')), 20);
    return ctrl.signal;
  };
  await assert.rejects(c.siteInfo(), (e) => e.code === 'timeout');
});

test('cancelar la sincronización corta la petición', async () => {
  const ctrl = new AbortController();
  const c = client((url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))), { transport: 'auto', signal: ctrl.signal });
  const p = c.siteInfo();
  ctrl.abort();
  await assert.rejects(p, (e) => e.code === 'aborted');
});

test('sin conexión a Internet', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
  try {
    const c = client(
      async () => {
        throw typeError();
      },
      { transport: 'auto' }
    );
    await assert.rejects(c.siteInfo(), (e) => e.code === 'offline' && e.message === 'Sin conexión a Internet.');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
  }
});

test('el puente local cerrado da "localserver"', async () => {
  const msg = 'Tasques está cerrado en tu ordenador. Ábrelo con el icono «Tasques» (o Iniciar.cmd) y pulsa Sincronizar.';
  const viaProxy = client(
    async () => {
      throw typeError();
    },
    { transport: 'proxy' }
  );
  await assert.rejects(viaProxy.siteInfo(), (e) => e.code === 'localserver' && e.message === msg);
  const auto = client(
    async () => {
      throw typeError();
    },
    { transport: 'auto' }
  );
  await assert.rejects(auto.siteInfo(), (e) => e.code === 'localserver');
  const direct = client(async () => {
    throw typeError();
  });
  await assert.rejects(direct.siteInfo(), (e) => e.code === 'network');
});

test('en modo auto, si el navegador no llega, se usa el puente', async () => {
  const urls = [];
  const c = client(
    async (url, opts) => {
      urls.push(url);
      if (url !== '/api/proxy') throw typeError();
      const sent = JSON.parse(opts.body);
      assert.equal(sent.site, SITE);
      assert.equal(sent.path, 'webservice/rest/server.php');
      assert.match(sent.body, /moodlewssettingfilter=true/);
      assert.ok(opts.signal instanceof AbortSignal);
      return reply({ userid: 5 });
    },
    { transport: 'auto' }
  );
  assert.deepEqual(await c.siteInfo(), { userid: 5 });
  assert.equal(c.transport, 'proxy');
  assert.deepEqual(urls, ['https://c.example/webservice/rest/server.php', '/api/proxy']);

  // Puente apagado (404 en texto plano): error de red, no "no encontramos Moodle".
  const off = client(
    async (url) => {
      if (url !== '/api/proxy') throw typeError();
      return reply('Proxy desactivado', { status: 404, type: 'text/plain; charset=utf-8' });
    },
    { transport: 'auto' }
  );
  await assert.rejects(off.siteInfo(), (e) => e.code === 'network');
  assert.equal(off.transport, 'auto');
});

test('en modo puente, sus propios rechazos en texto plano son un error de red', async () => {
  const viaBridge = (status, body, type) => client(async () => reply(body, { status, type }), { transport: 'proxy' }).siteInfo();
  // Puente apagado, otro Moodle, otro origen, otro host: no es "no encontramos Moodle".
  for (const [status, text] of [
    [404, 'Proxy desactivado'],
    [403, 'Dirección de Moodle no permitida'],
    [403, 'Origen no permitido'],
    [421, 'Host no reconocido'],
    [415, 'Se esperaba JSON'],
  ]) {
    await assert.rejects(viaBridge(status, text, 'text/plain; charset=utf-8'), (e) => e.code === 'network' && e.message === FRIENDLY.network, `${status} ${text}`);
  }
  // Lo que reenvía de Moodle llega como JSON y se traduce como siempre.
  const relayed = { ok: false, status: 404, headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }), json: async () => JSON.parse('<html>') };
  await assert.rejects(client(async () => relayed, { transport: 'proxy' }).siteInfo(), (e) => e.code === 'http404' && e.message === FRIENDLY.http404);
  await assert.rejects(viaBridge(503, { exception: 'x', errorcode: 'sitemaintenance' }), (e) => e.code === 'sitemaintenance');
  // Demasiadas peticiones (texto plano del puente): su propio mensaje.
  await assert.rejects(viaBridge(429, 'Demasiadas peticiones', 'text/plain'), (e) => e.code === 'http429' && e.message === FRIENDLY.http429);
});

test('sin AbortSignal.any se respetan igualmente la cancelación y el plazo', async () => {
  const desc = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  delete AbortSignal.any;
  try {
    // Como fetch: con una señal ya cancelada falla en el acto.
    const hang = (url, opts) =>
      new Promise((resolve, reject) => {
        if (opts.signal.aborted) return reject(opts.signal.reason);
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      });
    const ctrl = new AbortController();
    const c = client(hang, { signal: ctrl.signal });
    const p = c.siteInfo();
    ctrl.abort();
    await assert.rejects(p, (e) => e.code === 'aborted');
    // Ya cancelada antes de empezar.
    await assert.rejects(client(hang, { signal: AbortSignal.abort() }).siteInfo(), (e) => e.code === 'aborted');
    // El plazo también corta aunque haya una señal de la app.
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => {
      const t = new AbortController();
      setTimeout(() => t.abort(named('TimeoutError')), 20);
      return t.signal;
    };
    try {
      await assert.rejects(client(hang, { signal: new AbortController().signal }).siteInfo(), (e) => e.code === 'timeout');
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  } finally {
    Object.defineProperty(AbortSignal, 'any', desc);
  }
});
