import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../public/js/store.js';
import { normalizeSiteUrl, safeMoodleLink, eventToTask, MoodleClient } from '../public/js/moodle.js';
import { buildIcs } from '../public/js/ics.js';

const H = 3_600_000;
const NOW = new Date(2026, 9, 9, 10, 0, 0).getTime(); // viernes 9 oct 2026, 10:00
const task = (id, due, extra = {}) => ({ id, title: id, courseId: 1, courseName: 'Física', courseShort: 'FIS', due, source: 'moodle', ...extra });

test('clasifica por fecha', () => {
  assert.equal(T.bucketOf(task('a', NOW - H), NOW), 'overdue');
  assert.equal(T.bucketOf(task('a', NOW + 2 * H), NOW), 'today');
  assert.equal(T.bucketOf(task('a', NOW + 20 * H), NOW), 'tomorrow');
  assert.equal(T.bucketOf(task('a', NOW + 4 * 24 * H), NOW), 'week');
  assert.equal(T.bucketOf(task('a', NOW + 9 * 24 * H), NOW), 'later');
});

test('resumen ignora las marcadas como hechas', () => {
  const tasks = [task('a', NOW - H), task('b', NOW + H), task('c', NOW + 3 * 24 * H)];
  const s = T.summarize(tasks, { b: NOW }, NOW);
  assert.equal(s.pending, 2);
  assert.equal(s.overdue, 1);
  assert.equal(s.next.id, 'c');
});

test('lo que desaparece de Moodle pasa al historial', () => {
  const prev = [task('a', NOW + H), task('b', NOW + 2 * H)];
  const fresh = [task('b', NOW + 2 * H)];
  const m = T.mergeSync(prev, fresh, [], NOW);
  assert.equal(m.newlyCompleted, 1);
  assert.equal(m.history[0].id, 'a');
  assert.equal(m.history[0].how, 'moodle');
  // Si vuelve a aparecer (p. ej. se reabre la entrega), sale del historial.
  const m2 = T.mergeSync(fresh, prev, m.history, NOW);
  assert.equal(m2.history.length, 0);
});

test('filtra por vista, asignatura y texto', () => {
  const tasks = [task('Derivades', NOW - H), task('Informe', NOW + H, { courseId: 2, courseName: 'Química' })];
  assert.equal(T.filterTasks(tasks, { view: 'overdue' }, NOW).length, 1);
  assert.equal(T.filterTasks(tasks, { view: 'pending', course: 2 }, NOW).length, 1);
  assert.equal(T.filterTasks(tasks, { view: 'pending', query: 'químic' }, NOW).length, 1);
});

test('franja de 14 días', () => {
  const days = T.horizon([task('a', NOW + H), task('b', NOW + 3 * 24 * H), task('c', NOW - H)], NOW);
  assert.equal(days.length, 14);
  assert.equal(days[0].tasks.length, 1);
  assert.equal(days[3].tasks.length, 1);
});

test('normaliza la dirección de Moodle', () => {
  assert.equal(normalizeSiteUrl('campus.example.cat'), 'https://campus.example.cat');
  assert.equal(normalizeSiteUrl('https://example.cat/moodle/my/'), 'https://example.cat/moodle');
  assert.equal(normalizeSiteUrl('https://example.cat/login/index.php'), 'https://example.cat');
  assert.throws(() => normalizeSiteUrl('http://example.cat'), /https/);
  assert.throws(() => normalizeSiteUrl('https://user:pw@example.cat'), /credenciales/);
  assert.equal(normalizeSiteUrl('http://localhost:8000'), 'http://localhost:8000');
});

test('solo se aceptan enlaces del propio Moodle', () => {
  const site = 'https://campus.example.cat';
  assert.equal(safeMoodleLink('https://campus.example.cat/mod/assign/view.php?id=4', site), 'https://campus.example.cat/mod/assign/view.php?id=4');
  assert.equal(safeMoodleLink('javascript:alert(1)', site), null);
  assert.equal(safeMoodleLink('https://evil.example/phish', site), null);
});

test('convierte eventos de Moodle', () => {
  const t = eventToTask(
    { id: 9, name: 'X vence', activityname: 'Pràctica 3', modulename: 'assign', timesort: NOW / 1000, overdue: false, course: { id: 7, fullname: 'Programació', shortname: 'PWEB' }, action: { name: 'Entregar', url: 'https://c.example/mod/assign/view.php?id=1' }, url: 'https://evil.example' },
    'https://c.example'
  );
  assert.equal(t.title, 'Pràctica 3');
  assert.equal(t.kind, 'assign');
  assert.equal(t.due, NOW);
  assert.equal(t.url, 'https://c.example/mod/assign/view.php?id=1');
});

test('el token viaja en el cuerpo y se pagina la línea de tiempo', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts.body.toString() });
    const p = new URLSearchParams(opts.body.toString());
    const after = Number(p.get('aftereventid') || 0);
    const events = after ? [{ id: 51 }] : Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    return { ok: true, json: async () => ({ events }) };
  };
  const c = new MoodleClient({ siteUrl: 'https://c.example', token: 'f'.repeat(32), transport: 'direct', fetchImpl });
  const evs = await c.actionEvents({ fromSeconds: 0 });
  assert.equal(evs.length, 51);
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].url.includes('wstoken'));
  assert.ok(calls[0].body.includes('wstoken=' + 'f'.repeat(32)));
});

test('los errores de Moodle se traducen', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }) });
  const c = new MoodleClient({ siteUrl: 'https://c.example', token: 'f'.repeat(32), transport: 'direct', fetchImpl });
  await assert.rejects(c.siteInfo(), (e) => e.code === 'invalidtoken' && /caducado/.test(e.message));
});

test('exporta .ics válido', () => {
  const ics = buildIcs([task('ev1', NOW + H, { title: 'Comentari; de text, part 1' })], NOW);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Comentari\\; de text\\, part 1/);
  assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
});

test('decodifica entidades sin interpretar HTML', async () => {
  const { decodeEntities } = await import('../public/js/moodle.js');
  assert.equal(decodeEntities('R&amp;D &lt;b&gt; Matem&#224;tiques &#x27;x&#x27;'), "R&D <b> Matemàtiques 'x'");
  assert.equal(decodeEntities('&bogus; &#0;'), '&bogus; &#0;');
});
