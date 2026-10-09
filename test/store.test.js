import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs } from '../public/js/ics.js';

// Las fechas se prueban con la hora de Barcelona, que cambia el 25 oct 2026.
// Se fija antes de cargar store.js.
process.env.TZ = 'Europe/Madrid';
const T = await import('../public/js/store.js');

const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 10, 9, 10); // viernes 9 oct 2026, 10:00
const task = (id, due, extra = {}) => ({ id, title: id, kind: 'assign', courseId: 1, courseName: 'Física', courseShort: 'FIS', due, source: 'moodle', ...extra });

test('clasifica por fecha', () => {
  assert.equal(T.bucketOf(task('a', NOW - H), NOW), 'overdue');
  assert.equal(T.bucketOf(task('a', NOW + 2 * H), NOW), 'today');
  assert.equal(T.bucketOf(task('a', NOW + 20 * H), NOW), 'tomorrow');
  assert.equal(T.bucketOf(task('a', NOW + 4 * D), NOW), 'week');
  assert.equal(T.bucketOf(task('a', NOW + 9 * D), NOW), 'later');
  assert.equal(T.DAY, 86_400_000);
  assert.deepEqual(
    T.BUCKETS.map((b) => b.label),
    ['Atrasadas', 'Hoy', 'Mañana', 'Próximos días', 'Más adelante']
  );
});

test('resumen ignora las marcadas como hechas y da la siguiente y la de después', () => {
  const tasks = [task('a', NOW - H), task('b', NOW + H), task('c', NOW + 3 * D), task('d', NOW + 9 * D), task('e', NOW + 20 * H)];
  const s = T.summarize(tasks, { b: NOW }, NOW);
  assert.equal(s.pending, 4);
  assert.equal(s.overdue, 1);
  assert.equal(s.today, 0);
  assert.equal(s.thisWeek, 2);
  assert.equal(s.next.id, 'e');
  assert.equal(s.after.id, 'c');
  assert.deepEqual(s.by, { overdue: 1, today: 0, tomorrow: 1, week: 1, later: 1 });
  const none = T.summarize([task('a', NOW - H)], {}, NOW);
  assert.equal(none.next, null);
  assert.equal(none.after, null);
});

test('pendingTasks deja fuera las marcadas', () => {
  const tasks = [task('a', NOW), task('b', NOW)];
  assert.deepEqual(
    T.pendingTasks(tasks, { a: NOW }).map((t) => t.id),
    ['b']
  );
});

// ---------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------

test('lo que desaparece de Moodle pasa al historial como "gone" y vuelve si reaparece', () => {
  const prev = [task('a', NOW + H), task('b', NOW + 2 * H)];
  const fresh = [task('b', NOW + 2 * H)];
  const m = T.mergeSync(prev, fresh, [], NOW);
  assert.equal(m.newlyCompleted, 1);
  assert.equal(m.gone, 1);
  assert.equal(m.expired, 0);
  assert.equal(m.history[0].id, 'a');
  assert.equal(m.history[0].how, 'gone');
  assert.equal(m.history[0].completedAt, NOW);
  assert.deepEqual(m.tasks, fresh);
  // Si vuelve a aparecer (p. ej. se reabre la entrega), sale del historial.
  const m2 = T.mergeSync(fresh, prev, m.history, NOW);
  assert.equal(m2.history.length, 0);
  assert.equal(m2.newlyCompleted, 0);
});

test('un cuestionario que cierra sin hacerse queda como "expired"', () => {
  const prev = [
    task('q-cerrado', NOW - H, { kind: 'quiz' }),
    task('q-futuro', NOW + D, { kind: 'quiz' }),
    task('tarea-vencida', NOW - H),
    task('demo', NOW - H, { source: 'demo' }),
  ];
  const m = T.mergeSync(prev, [], [], NOW);
  const how = Object.fromEntries(m.history.map((h) => [h.id, h.how]));
  assert.deepEqual(how, { 'q-cerrado': 'expired', 'q-futuro': 'gone', 'tarea-vencida': 'gone' });
  assert.equal(m.expired, 1);
  assert.equal(m.gone, 2);
  assert.equal(m.newlyCompleted, 3);
});

test('el historial no repite entradas y se limita a 120 días y 300 elementos', () => {
  const old = { ...task('viejo', NOW - 200 * D), completedAt: NOW - 121 * D, how: 'gone' };
  const known = { ...task('ya', NOW - D), completedAt: NOW - D, how: 'gone' };
  const m = T.mergeSync([task('ya', NOW - D)], [], [known, old], NOW);
  assert.deepEqual(
    m.history.map((h) => h.id),
    ['ya']
  );
  assert.equal(m.newlyCompleted, 0);
  const many = Array.from({ length: 400 }, (_, i) => task('t' + i, NOW + D));
  assert.equal(T.mergeSync(many, [], [], NOW).history.length, 300);
});

test('pruneDone conserva marcas de tareas presentes o de menos de 120 días', () => {
  const done = { presente: NOW - 300 * D, reciente: NOW - 10 * D, vieja: NOW - 130 * D };
  const kept = T.pruneDone(done, [task('presente', NOW)], NOW);
  assert.deepEqual(Object.keys(kept).sort(), ['presente', 'reciente']);
  // Sin "now" usa la hora actual.
  assert.deepEqual(Object.keys(T.pruneDone({ x: Date.now() }, [])), ['x']);
});

// ---------------------------------------------------------------------------
// Filtros y búsqueda
// ---------------------------------------------------------------------------

test('filtra por vista, asignatura y texto', () => {
  const tasks = [task('Derivades', NOW - H), task('Informe', NOW + H, { courseId: 2, courseName: 'Química' })];
  assert.equal(T.filterTasks(tasks, { view: 'overdue' }, NOW).length, 1);
  assert.equal(T.filterTasks(tasks, { view: 'pending', course: 2 }, NOW).length, 1);
  assert.equal(T.filterTasks(tasks, { view: 'pending', query: 'químic' }, NOW).length, 1);
  assert.equal(T.filterTasks(tasks, { view: 'pending', query: '  quimica  ' }, NOW).length, 1);
  assert.equal(T.filterTasks(tasks, { view: 'pending', done: { Informe: NOW } }, NOW).length, 1);
  // El id de asignatura puede llegar como texto (valor de un select); '' no filtra.
  assert.equal(T.filterTasks(tasks, { course: '2' }, NOW).length, 1);
  assert.equal(T.filterTasks(tasks, { course: '', day: '', minDue: '' }, NOW).length, 2);
});

test('la vista "Hoy" solo trae lo pendiente que vence hoy', () => {
  const tasks = [task('ayer', NOW - D), task('hoy', NOW + 8 * H), task('hoy-hecha', NOW + 2 * H), task('manana', NOW + D)];
  const ids = T.filterTasks(tasks, { view: 'today', done: { 'hoy-hecha': NOW } }, NOW).map((t) => t.id);
  assert.deepEqual(ids, ['hoy']);
});

test('la vista "semana" trae hoy, mañana y los próximos días', () => {
  const tasks = [task('atrasada', NOW - H), task('hoy', NOW + H), task('manana', NOW + D), task('jueves', NOW + 6 * D), task('lejos', NOW + 9 * D)];
  const ids = T.filterTasks(tasks, { view: 'week' }, NOW).map((t) => t.id);
  assert.deepEqual(ids, ['hoy', 'manana', 'jueves']);
});

test('minDue descarta las atrasadas antiguas salvo en la vista "all"', () => {
  const tasks = [task('muy-vieja', NOW - 40 * D), task('vieja', NOW - 5 * D), task('futura', NOW + D)];
  const minDue = NOW - 30 * D;
  assert.deepEqual(
    T.filterTasks(tasks, { view: 'pending', minDue }, NOW).map((t) => t.id),
    ['vieja', 'futura']
  );
  assert.deepEqual(
    T.filterTasks(tasks, { view: 'overdue', minDue }, NOW).map((t) => t.id),
    ['vieja']
  );
  assert.equal(T.filterTasks(tasks, { view: 'all', minDue, done: { vieja: NOW } }, NOW).length, 3);
});

test('filtra por día, también el del cambio de hora (25 oct 2026)', () => {
  const tasks = [
    task('sab-noche', at(2026, 10, 24, 23, 30)),
    task('dom-0030', at(2026, 10, 25, 0, 30)),
    task('dom-0230', at(2026, 10, 25, 2, 30)),
    task('dom-2330', at(2026, 10, 25, 23, 30)),
    task('lun-0010', at(2026, 10, 26, 0, 10)),
  ];
  const now = at(2026, 10, 20, 9);
  const day = T.startOfDay(at(2026, 10, 25, 12));
  assert.equal(day, at(2026, 10, 25));
  assert.equal(T.startOfDay(at(2026, 10, 26, 12)) - day, 25 * H, 'el domingo dura 25 horas');
  const ids = T.filterTasks(tasks, { view: 'pending', day }, now).map((t) => t.id);
  assert.deepEqual(ids, ['dom-0030', 'dom-0230', 'dom-2330']);
  // Un día de otra vista y otra asignatura se combinan.
  assert.equal(T.filterTasks(tasks, { view: 'pending', day, course: 9 }, now).length, 0);
  assert.equal(T.filterTasks([task('hoy', NOW + H)], { view: 'today', day: T.startOfDay(NOW) }, NOW).length, 1);
});

test('la búsqueda ignora acentos, mayúsculas y la ela geminada', () => {
  const tasks = [
    task('platon', NOW + H, { title: 'Comentari: la República de Plató' }),
    task('celula', NOW + H, { title: 'La cèl·lula eucariota', courseName: 'Biologia' }),
    task('quiz', NOW + H, { title: 'Tema 4', kind: 'quiz', courseName: 'Física' }),
    task('lengua', NOW + H, { title: 'Comentari de text', courseName: 'Llengua Castellana i Literatura', courseShort: '2BAT-LCL-2526' }),
    task('mates', NOW + H, { title: 'Derivades', courseName: 'Matemàtiques II', courseShort: '2BAT_MAT_B_2526' }),
  ];
  const find = (query) => T.filterTasks(tasks, { query }, NOW).map((t) => t.id);
  assert.deepEqual(find('platon'), ['platon']);
  assert.deepEqual(find('PLATÓ'), ['platon']);
  assert.deepEqual(find('republica'), ['platon']);
  assert.equal(T.filterTasks([task('es', NOW + H, { title: 'Platón y la caverna' })], { query: 'plato' }, NOW).length, 1);
  assert.equal(T.filterTasks([task('ca', NOW + H, { title: 'Sistemes d\'informació' })], { query: 'informacion' }, NOW).length, 1);
  assert.deepEqual(find('celula'), ['celula']);
  assert.deepEqual(find('cel·lula'), ['celula']);
  assert.deepEqual(find('cel.lula'), ['celula']);
  assert.deepEqual(find('cuestionario'), ['quiz']);
  assert.deepEqual(find('lengua'), ['lengua']);
  assert.deepEqual(find('lcl'), ['lengua']);
  assert.deepEqual(find('mat2'), ['mates']);
  assert.deepEqual(find('matematiques derivades'), ['mates']);
  assert.deepEqual(find('matematiques platon'), []);
  assert.equal(find('   ').length, tasks.length);
});

test('la búsqueda no encuentra "undefined" en campos que faltan', () => {
  const bare = { id: 'x', title: 'Hola', kind: 'assign', courseId: 1, courseName: 'Física', due: NOW + H, source: 'moodle' };
  assert.equal(T.filterTasks([bare], { query: 'undefined' }, NOW).length, 0);
  assert.equal(T.filterTasks([{ ...bare, courseShort: null }], { query: 'null' }, NOW).length, 0);
  assert.equal(T.filterTasks([{ ...bare, kind: undefined }], { query: 'actividad' }, NOW).length, 1);
  assert.equal(T.filterTasks([bare], { query: null }, NOW).length, 1);
  assert.equal(T.filterTasks([bare]).length, 1, 'sin opciones ni now');
});

test('fold quita acentos y puntuación', () => {
  assert.equal(T.fold('Cèl·lula, Ñandú!'), 'celula nandu');
  assert.equal(T.fold("L'Àgora"), 'lagora');
  assert.equal(T.fold(null), '');
});

test('agrupa en orden y ordena por fecha', () => {
  const tasks = [task('c', NOW + 9 * D), task('b', NOW + 2 * H), task('a', NOW - H), task('b0', NOW + H)];
  const groups = T.groupByBucket(tasks, NOW);
  assert.deepEqual(
    groups.map((g) => g.id),
    ['overdue', 'today', 'later']
  );
  assert.deepEqual(
    groups[1].tasks.map((t) => t.id),
    ['b0', 'b']
  );
  assert.equal(groups[1].label, 'Hoy');
});

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

test('relative', () => {
  assert.equal(T.relative(NOW + 30_000, NOW), 'ahora');
  assert.equal(T.relative(NOW - 30_000, NOW), 'ahora');
  assert.equal(T.relative(NOW + 5 * MIN, NOW), 'en 5 min');
  assert.equal(T.relative(NOW + 5 * MIN + 59_000, NOW), 'en 5 min');
  assert.equal(T.relative(NOW - 36 * H, NOW), 'hace 36 h');
  assert.equal(T.relative(NOW + 47 * H + 59 * MIN, NOW), 'en 47 h');
  // Viernes 10:00 a domingo 23:59: dos días de calendario, no tres.
  assert.equal(T.relative(at(2026, 10, 11, 23, 59), NOW), 'en 2 días');
  assert.equal(T.relative(at(2026, 10, 6, 9), NOW), 'hace 3 días');
  // 48 h en el fin de semana del cambio de hora: nunca "1 días".
  assert.equal(T.relative(at(2026, 10, 24) + 48 * H, at(2026, 10, 24)), 'en 2 días');
  // Una fecha que falta no da "hace NaN días".
  assert.equal(T.relative(undefined, NOW), '');
  assert.equal(T.relative(NaN, NOW), '');
  // Sin now usa la hora actual.
  assert.equal(T.relative(Date.now() + 5 * MIN + 2000), 'en 5 min');
});

test('formatDueParts y formatDue', () => {
  assert.deepEqual(T.formatDueParts(at(2026, 10, 9, 18), NOW), { day: 'Hoy', time: '18:00' });
  assert.deepEqual(T.formatDueParts(at(2026, 10, 10, 9, 5), NOW), { day: 'Mañana', time: '09:05' });
  assert.deepEqual(T.formatDueParts(at(2026, 10, 8, 23, 59), NOW), { day: 'Ayer', time: '23:59' });
  assert.deepEqual(T.formatDueParts(at(2026, 10, 7, 23, 59), NOW), { day: 'mié 7 oct', time: '23:59' });
  assert.deepEqual(T.formatDueParts(at(2027, 1, 8, 12), NOW), { day: 'vie 8 ene 2027', time: '12:00' });
  assert.equal(T.formatDue(at(2026, 10, 9, 18), NOW), 'Hoy, 18:00');
  assert.equal(T.formatDue(at(2026, 10, 7, 23, 59), NOW), 'Mié 7 oct, 23:59');
  assert.equal(T.formatDue(at(2026, 10, 17, 8), NOW), 'Sáb 17 oct, 08:00');
});

test('formatDueCompact en cada grupo', () => {
  assert.equal(T.formatDueCompact(NOW - 36 * H, NOW), 'hace 36 h');
  assert.equal(T.formatDueCompact(at(2026, 10, 9, 18), NOW), '18:00 · en 8 h');
  assert.equal(T.formatDueCompact(at(2026, 10, 10, 14), NOW), '14:00');
  assert.equal(T.formatDueCompact(at(2026, 10, 11, 22), NOW), 'dom 22:00');
  assert.equal(T.formatDueCompact(at(2026, 10, 17, 9), NOW), 'sáb 17 oct');
});

test('fechas largas y cortas', () => {
  assert.equal(T.formatLongDate(at(2026, 10, 10, 14), NOW), 'sábado, 10 de octubre, 14:00');
  assert.equal(T.formatLongDate(at(2027, 1, 4, 9), NOW), 'lunes, 4 de enero de 2027, 09:00');
  assert.equal(T.formatDay(NOW), 'viernes, 9 de octubre');
  assert.equal(T.formatWeekdayDate(at(2026, 10, 17)), 'sábado 17 de octubre');
  assert.equal(T.formatShortDay(at(2026, 10, 17)), 'sáb 17 oct');
  assert.equal(T.formatShortDay(at(2026, 9, 2)), 'mié 2 sept');
  assert.equal(T.formatTime(at(2026, 10, 9, 7, 3)), '07:03');
});

test('countdownParts: dos unidades como mucho y nunca un cero', () => {
  const c = (ms) => T.countdownParts(NOW + ms, NOW);
  assert.deepEqual(c(2 * D + 4 * H + 10 * MIN).parts, [
    [2, 'd'],
    [4, 'h'],
  ]);
  const five = c(5 * H + 56 * MIN + 30_000);
  assert.deepEqual(five.parts, [
    [5, 'h'],
    [56, 'min'],
  ]);
  assert.equal(five.aria, 'Faltan 5 horas y 56 minutos');
  assert.equal(five.urgent, false);
  const late = c(42 * MIN);
  assert.deepEqual(late.parts, [[42, 'min']]);
  assert.equal(late.urgent, true);
  assert.equal(late.aria, 'Faltan 42 minutos');
  assert.deepEqual(c(30_000).parts, [['menos de 1', 'min']]);
  assert.equal(c(30_000).aria, 'Falta menos de 1 minuto');
  assert.deepEqual(c(H).parts, [[1, 'h']]);
  assert.equal(c(H).aria, 'Falta 1 hora');
  assert.equal(c(D + H).aria, 'Faltan 1 día y 1 hora');
  assert.deepEqual(c(2 * D + 5 * MIN).parts, [[2, 'd']]);
  assert.equal(c(-MIN).past, true);
  assert.equal(c(MIN).past, false);
  for (let ms = 1000; ms < 4 * D; ms += 7 * MIN + 13_000) {
    const { parts } = c(ms);
    assert.ok(parts.length >= 1 && parts.length <= 2, `partes para ${ms}`);
    assert.ok(
      parts.every(([n]) => n !== 0 && n !== '0'),
      `sin ceros para ${ms}: ${JSON.stringify(parts)}`
    );
  }
});

test('durationText', () => {
  assert.equal(T.durationText(D + 2 * H + 5 * MIN), '1 día 2 h');
  assert.equal(T.durationText(3 * D), '3 días');
  assert.equal(T.durationText(5 * H + 3 * MIN), '5 h 3 min');
  assert.equal(T.durationText(5 * H), '5 h');
  assert.equal(T.durationText(42 * MIN), '42 min');
  assert.equal(T.durationText(-(42 * MIN)), '42 min');
  assert.equal(T.durationText(10_000), 'menos de 1 min');
});

test('franja de 14 días', () => {
  const days = T.horizon([task('a', NOW + H), task('b', NOW + 3 * D), task('c', NOW - H)], NOW);
  assert.equal(days.length, 14);
  assert.equal(days[0].ts, T.startOfDay(NOW));
  assert.equal(days[0].tasks.length, 1);
  assert.equal(days[3].tasks.length, 1);
});

test('la franja cuenta días de calendario en el cambio de hora', () => {
  const now = at(2026, 10, 20, 9);
  const days = T.horizon([task('dom', at(2026, 10, 25, 23, 30)), task('lun', at(2026, 10, 26, 0, 30)), task('lejos', at(2026, 11, 3, 10))], now);
  assert.equal(days.length, 14);
  days.forEach((d, i) => {
    const date = new Date(d.ts);
    assert.equal(date.getHours(), 0);
    assert.equal(date.getDate(), new Date(2026, 9, 20 + i).getDate());
  });
  assert.deepEqual(
    days[5].tasks.map((t) => t.id),
    ['dom']
  );
  assert.deepEqual(
    days[6].tasks.map((t) => t.id),
    ['lun']
  );
  assert.ok(days.every((d) => !d.tasks.some((t) => t.id === 'lejos')));
});

test('plural', () => {
  assert.equal(T.plural(1, 'tarea', 'tareas'), 'tarea');
  assert.equal(T.plural(0, 'tarea', 'tareas'), 'tareas');
  assert.equal(T.plural(3, 'tarea', 'tareas'), 'tareas');
});

// ---------------------------------------------------------------------------
// Asignaturas
// ---------------------------------------------------------------------------

test('courseCode', () => {
  assert.equal(T.courseCode('4ESO_MAT_B_2526', 'Matemàtiques II'), 'MAT2');
  assert.equal(T.courseCode('', 'Llengua Castellana i Literatura'), 'LCL');
  assert.equal(T.courseCode('FIS', 'Física'), 'FIS');
  assert.equal(T.courseCode('1BAT-MAT-2526', 'Matemàtiques I'), 'MAT1');
  assert.equal(T.courseCode('2BAT-LCL-2526', 'Llengua Castellana i Literatura'), 'LCL');
  assert.equal(T.courseCode('pweb', 'Programació Web'), 'PWEB');
  assert.equal(T.courseCode('', "Història de l'Art"), 'HIS');
  assert.equal(T.courseCode('', 'Física i Química 3'), 'FIS3');
  assert.equal(T.courseCode('', ''), 'CUR');
  assert.equal(T.courseCode(null, undefined), 'CUR');
});

test('assignCourseColors: sin repetir con 8 asignaturas y estable con una novena', () => {
  const ids = [108, 101, 105, 102, 107, 103, 104, 106];
  const map = T.assignCourseColors({}, ids);
  const used = ids.map((id) => map[id]);
  assert.equal(new Set(used).size, 8);
  assert.ok(used.every((i) => Number.isInteger(i) && i >= 0 && i < 8));
  // En orden ascendente: la 101 recibe el 0, la 102 el 1...
  assert.equal(map[101], 0);
  assert.equal(map[108], 7);
  const next = T.assignCourseColors(map, [...ids, 109]);
  ids.forEach((id) => assert.equal(next[id], map[id]));
  assert.ok(Number.isInteger(next[109]));
  // Se conservan las que ya no están y no se modifica el mapa anterior.
  const later = T.assignCourseColors(next, [200]);
  assert.equal(later[101], 0);
  assert.equal(Object.hasOwn(map, '109'), false);
  // Con huecos libres, la nueva toma el índice libre más bajo.
  const gap = T.assignCourseColors({ 1: 0, 2: 2 }, [1, 2, 3]);
  assert.equal(gap[3], 1);
});

test('courseHueOf usa el índice guardado o un tono estable', () => {
  const map = T.assignCourseColors({}, [5, 6]);
  assert.equal(T.courseHueOf(map, 5), T.COURSE_HUES[0]);
  assert.equal(T.courseHueOf(map, 6), T.COURSE_HUES[1]);
  const free = T.courseHueOf({}, 999);
  assert.ok(T.COURSE_HUES.includes(free));
  assert.equal(T.courseHueOf({}, 999), free);
  assert.equal(T.courseHueOf({ 999: 42 }, 999), free, 'un índice inválido se ignora');
  assert.deepEqual(T.COURSE_HUES, [295, 195, 345, 228, 125, 320, 210, 105]);
  // Alias antiguo mientras app.js cambia.
  assert.ok(T.COURSE_HUES.includes(T.courseHue(7)));
});

test('coursesFromTasks junta asignaturas de Moodle y de las tareas', () => {
  const courses = [
    { id: 2, fullname: 'Química', shortname: 'QUI', progress: 48.6, hidden: 0, enddate: 1780000000 },
    { id: 3, fullname: 'Àmbit científic', shortname: '3ESO_ACT_2526', progress: null, hidden: 1 },
  ];
  const tasks = [task('a', NOW, { courseId: 2 }), task('b', NOW, { courseId: 2 }), task('c', NOW, { courseId: 7, courseName: 'Biologia', courseShort: 'BIO' })];
  const list = T.coursesFromTasks(tasks, courses);
  assert.deepEqual(
    list.map((c) => c.name),
    ['Àmbit científic', 'Biologia', 'Química']
  );
  const qui = list.find((c) => c.id === 2);
  assert.deepEqual(qui, { id: 2, name: 'Química', short: 'QUI', code: 'QUI', progress: 49, hidden: false, enddate: 1780000000, count: 2 });
  const act = list.find((c) => c.id === 3);
  assert.equal(act.hidden, true);
  assert.equal(act.progress, null);
  assert.equal(act.enddate, 0);
  assert.equal(act.count, 0);
  assert.equal(act.code, 'AMB');
  assert.equal(list.find((c) => c.id === 7).count, 1);
});

test('KIND_LABEL y kindOf', () => {
  assert.deepEqual(T.kindOf('quiz'), ['Cuestionario', 'exam']);
  assert.deepEqual(T.kindOf('nuevo'), ['Actividad', 'calendar-blank']);
  assert.deepEqual(T.kindOf('constructor'), ['Actividad', 'calendar-blank']);
  assert.equal(Object.keys(T.KIND_LABEL).length, 14);
});

test('alias antiguos', () => {
  assert.deepEqual(T.countdown(NOW + D + 2 * H + 3 * MIN, NOW), { d: 1, h: 2, m: 3 });
});

test('exporta .ics válido', () => {
  const ics = buildIcs([task('ev1', NOW + H, { title: 'Comentari; de text, part 1' })], NOW);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Comentari\\; de text\\, part 1/);
  assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
});

test('.ics: pliega líneas largas con acentos y salta fechas imposibles', () => {
  const long = task('ev2', NOW + D, { title: 'Comentari de text: '.repeat(4) + 'cèl·lula, història i àmbit científic\nsegona línia', courseShort: '' });
  const ics = buildIcs([long, task('ev3', NaN), task('ev4', undefined)], NOW);
  const lines = ics.split('\r\n');
  assert.ok(lines.every((l) => new TextEncoder().encode(l).length <= 75));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 1);
  // Al desplegar (quitar CRLF + espacio) queda el texto entero, sin romper caracteres.
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('cèl·lula\\, història i àmbit científic\\nsegona línia (Física)'));
  assert.ok(!unfolded.includes('�'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});
