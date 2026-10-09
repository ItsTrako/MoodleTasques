import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../public/js/details.js';
import { MoodleClient } from '../public/js/moodle.js';

const NOW = 1_791_500_000_000;

test('num entiende comas, puntos y rechaza lo demás', () => {
  assert.equal(G.num('7,50'), 7.5);
  assert.equal(G.num('8.25000'), 8.25);
  assert.equal(G.num(9), 9);
  assert.equal(G.num('-'), null);
  assert.equal(G.num('Notable'), null);
  assert.equal(G.num(null), null);
});

test('resumen de notas por asignatura', () => {
  const o = G.slimOverview({ grades: [{ courseid: 3, grade: '6,80', rawgrade: '6.80000' }, { courseid: 4, grade: '-', rawgrade: null }, { foo: 1 }] });
  assert.deepEqual(o[3], { formatted: '6,80', raw: 6.8 });
  assert.deepEqual(o[4], { formatted: '', raw: null });
  assert.equal(Object.keys(o).length, 2);
});

test('calificaciones: total, sin categorías ni notas ocultas, comentarios en texto', () => {
  const res = {
    usergrades: [
      {
        gradeitems: [
          { id: 1, itemtype: 'course', graderaw: 6.8, grademin: 0, grademax: 10, gradeformatted: '6,80' },
          { id: 2, itemtype: 'category', itemname: 'Trimestre 1', graderaw: 7, grademax: 10, gradeformatted: '7,00' },
          { id: 3, itemtype: 'mod', itemmodule: 'assign', itemname: 'Pràctica 1', iteminstance: 11, cmid: 51, graderaw: 85, grademin: 0, grademax: 100, gradeformatted: '85,00', gradedategraded: 1_700_000_000, feedback: '<p>Molt <b>bé</b></p><script>x()</script>', weightformatted: '20,00 %' },
          { id: 4, itemtype: 'mod', itemmodule: 'quiz', itemname: 'Test', graderaw: null, grademax: 10, gradeformatted: '-' },
          { id: 5, itemtype: 'mod', itemname: 'Oculta', graderaw: 9, grademax: 10, gradeformatted: '9', gradeishidden: true },
          { id: 6, itemtype: 'manual', itemname: '', graderaw: 5, grademax: 10 },
        ],
      },
    ],
  };
  const s = G.slimGradeItems(res);
  assert.equal(s.total.formatted, '6,80');
  assert.ok(Math.abs(s.total.pct - 0.68) < 1e-9);
  assert.equal(s.items.length, 2);
  const [a, b] = s.items;
  assert.equal(a.name, 'Pràctica 1');
  assert.equal(a.pct, 0.85);
  assert.equal(a.feedback, 'Molt bé');
  assert.equal(a.graded, 1_700_000_000_000);
  assert.equal(a.instance, 11);
  assert.equal(b.formatted, '');
  assert.equal(b.pct, null);
  assert.deepEqual(G.slimGradeItems(null), { total: null, items: [] });
});

test('detalles de tareas y cuestionarios', () => {
  const a = G.assignDetails({ courses: [{ assignments: [{ id: 7, grade: 10, cutoffdate: 1_700_000_100, allowsubmissionsfromdate: 0, introattachments: [{}, {}] }, { id: 8, grade: -3 }] }] });
  assert.deepEqual(a[7], { maxGrade: 10, scale: false, cutoff: 1_700_000_100_000, opens: 0, files: 2, attempts: null });
  assert.equal(a[8].maxGrade, null);
  assert.equal(a[8].scale, true);
  const q = G.quizDetails({ quizzes: [{ id: 2, timelimit: 1800, attempts: 0, timeopen: 0, timeclose: 1_700_000_000, grade: '10.00000' }] });
  assert.deepEqual(q[2], { timeLimit: 1800, attempts: 0, opens: 0, closes: 1_700_000_000_000, maxGrade: 10 });
});

test('estado de la entrega', () => {
  const draft = G.submissionInfo({ lastattempt: { submission: { status: 'draft', timemodified: 1_700_000_000 }, gradingstatus: 'notgraded', extensionduedate: 1_700_100_000 } });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.graded, false);
  assert.equal(draft.extension, 1_700_100_000_000);
  const graded = G.submissionInfo({
    lastattempt: { submission: { status: 'submitted' }, gradingstatus: 'graded' },
    feedback: { gradefordisplay: '<span>8,50&nbsp;/&nbsp;10,00</span>', gradeddate: 1_700_000_000, plugins: [{ type: 'comments', editorfields: [{ text: '<p>Bona feina</p>' }] }] },
  });
  assert.equal(graded.graded, true);
  assert.equal(graded.grade, '8,50 / 10,00');
  assert.equal(graded.feedback, 'Bona feina');
  assert.equal(G.submissionInfo({ lastattempt: { submission: { status: 'raro' } } }).status, null);
  assert.equal(G.submissionInfo(null), null);
});

test('resúmenes: media, recientes, tono y escala sobre 10', () => {
  const grades = {
    courses: {
      1: { total: { formatted: '6,80', pct: 0.68, max: 10 }, items: [{ id: 1, name: 'A', formatted: '7', graded: NOW - 1000 }, { id: 2, name: 'B', formatted: '', graded: 0 }] },
      2: { total: { formatted: '9,00', pct: 0.9, max: 10 }, items: [{ id: 3, name: 'C', formatted: '9', graded: NOW - 10 * 86_400_000 }] },
      3: { total: null, items: [] },
    },
  };
  const sums = G.courseSummaries(grades, [{ id: 1, fullname: 'Biologia' }]);
  assert.equal(sums.length, 2);
  assert.equal(sums[0].id, 1);
  assert.equal(sums[0].gradedCount, 1);
  assert.equal(G.averagePct(sums).toFixed(2), '0.79');
  assert.deepEqual(G.recentGrades(grades, NOW - 2 * 86_400_000).map((i) => i.id), [1]);
  assert.equal(G.outOfTen(0.79), '7,9');
  assert.equal(G.gradeTone(0.4), 'low');
  assert.equal(G.gradeTone(0.6), 'mid');
  assert.equal(G.gradeTone(0.95), 'high');
  assert.equal(G.gradeTone(null), '');
});

test('pool limita las peticiones simultáneas y no se rompe con errores', async () => {
  let live = 0;
  let peak = 0;
  const out = await G.pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (x === 4) throw new Error('falla');
    return x * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, [2, 4, 6, null, 10, 12, 14]);
});

test('el cliente pide las funciones de notas con los parámetros de Moodle', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(new URLSearchParams(opts.body.toString()));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' };
  };
  const c = new MoodleClient({ siteUrl: 'https://c.example', token: 'f'.repeat(32), transport: 'direct', fetchImpl });
  await c.courseGrades();
  await c.gradeItems(5, 42);
  await c.assignments([1, 2]);
  await c.submissionStatus(9);
  await c.quizzes([1]);
  assert.deepEqual(calls.map((p) => p.get('wsfunction')), ['gradereport_overview_get_course_grades', 'gradereport_user_get_grade_items', 'mod_assign_get_assignments', 'mod_assign_get_submission_status', 'mod_quiz_get_quizzes_by_courses']);
  assert.equal(calls[1].get('courseid'), '5');
  assert.equal(calls[1].get('userid'), '42');
  assert.equal(calls[2].get('courseids[0]'), '1');
  assert.equal(calls[2].get('courseids[1]'), '2');
  assert.equal(calls[3].get('assignid'), '9');
});
