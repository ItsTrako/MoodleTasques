// Notas y detalles de las tareas: convierte las respuestas de Moodle en datos
// pequeños y limpios que se guardan cifrados en la bóveda. Sin DOM: se prueba
// con node --test.
//
// Funciones de Moodle (todas del servicio de la app móvil):
//   gradereport_overview_get_course_grades   nota final de cada asignatura
//   gradereport_user_get_grade_items         cada calificación de una asignatura
//   mod_assign_get_assignments               nota máxima, fecha de corte, adjuntos
//   mod_assign_get_submission_status         estado de tu entrega, nota y comentarios
//   mod_quiz_get_quizzes_by_courses          tiempo límite, intentos, apertura

import { textOf, plainText } from './moodle.js';

const ms = (s) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
};

// "7,50" o "7.5" o 7.5 -> 7.5 ; cualquier otra cosa -> null
export function num(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  const s = String(x ?? '').trim().replace(/\s/g, '');
  if (!/^-?\d+(?:[.,]\d+)?$/.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Texto de una nota tal como lo muestra Moodle, sin HTML ni rangos raros.
const gradeText = (s) => textOf(s, 40).replace(/^-$/, '');

function pctOf(raw, min, max) {
  if (raw === null || max === null) return null;
  const lo = min ?? 0;
  if (!(max > lo)) return null;
  return Math.max(0, Math.min(1, (raw - lo) / (max - lo)));
}

// Nota final de cada asignatura: { [courseId]: { formatted, raw } }
export function slimOverview(res) {
  const out = {};
  const list = Array.isArray(res?.grades) ? res.grades : [];
  list.forEach((g) => {
    const id = Number(g?.courseid);
    if (!id) return;
    out[id] = { formatted: gradeText(g.grade), raw: num(g.rawgrade) };
  });
  return out;
}

// Calificaciones de una asignatura.
// Devuelve { total: {formatted, raw, min, max, pct} | null, items: [...] }
export function slimGradeItems(res, pref = 'es') {
  const ug = Array.isArray(res?.usergrades) ? res.usergrades[0] : null;
  const list = Array.isArray(ug?.gradeitems) ? ug.gradeitems : [];
  let total = null;
  const items = [];
  list.forEach((it) => {
    if (!it || typeof it !== 'object') return;
    if (it.gradeishidden || it.gradehiddenbydate) return;
    const raw = num(it.graderaw);
    const min = num(it.grademin);
    const max = num(it.grademax);
    const formatted = gradeText(it.gradeformatted);
    const entry = {
      formatted,
      raw,
      min,
      max,
      pct: pctOf(raw, min, max),
    };
    if (it.itemtype === 'course') {
      total = entry;
      return;
    }
    if (it.itemtype === 'category') return;
    const name = textOf(it.itemname, 160, pref);
    if (!name) return;
    items.push({
      id: Number(it.id) || items.length + 1,
      name,
      module: String(it.itemmodule || '').slice(0, 30),
      instance: Number(it.iteminstance) || 0,
      cmid: Number(it.cmid) || 0,
      ...entry,
      feedback: plainText(it.feedback, 800, pref),
      graded: ms(it.gradedategraded),
      submitted: ms(it.gradedatesubmitted),
      weight: textOf(it.weightformatted, 20),
    });
  });
  return { total, items: items.slice(0, 120) };
}

// Datos de las tareas (assign) por id de instancia.
export function assignDetails(res) {
  const out = {};
  (Array.isArray(res?.courses) ? res.courses : []).forEach((c) => {
    (Array.isArray(c?.assignments) ? c.assignments : []).forEach((a) => {
      const id = Number(a?.id);
      if (!id) return;
      const g = Number(a.grade);
      out[id] = {
        maxGrade: g > 0 ? g : null,
        scale: g < 0,
        cutoff: ms(a.cutoffdate),
        opens: ms(a.allowsubmissionsfromdate),
        files: Array.isArray(a.introattachments) ? a.introattachments.length : 0,
        attempts: Number(a.maxattempts) > 0 ? Number(a.maxattempts) : null,
      };
    });
  });
  return out;
}

// Datos de los cuestionarios por id de instancia.
export function quizDetails(res) {
  const out = {};
  (Array.isArray(res?.quizzes) ? res.quizzes : []).forEach((q) => {
    const id = Number(q?.id);
    if (!id) return;
    const limit = Number(q.timelimit);
    const att = Number(q.attempts);
    const g = num(q.grade);
    out[id] = {
      timeLimit: limit > 0 ? limit : 0,
      attempts: Number.isFinite(att) ? att : null, // 0 = sin límite
      opens: ms(q.timeopen),
      closes: ms(q.timeclose),
      maxGrade: g && g > 0 ? g : null,
    };
  });
  return out;
}

const SUB_STATUS = new Set(['new', 'draft', 'submitted', 'reopened']);

// Estado de tu entrega en una tarea.
export function submissionInfo(res, pref = 'es') {
  if (!res || typeof res !== 'object') return null;
  const last = res.lastattempt && typeof res.lastattempt === 'object' ? res.lastattempt : {};
  const sub = last.submission || last.teamsubmission || null;
  const status = SUB_STATUS.has(sub?.status) ? sub.status : null;
  const fb = res.feedback && typeof res.feedback === 'object' ? res.feedback : null;
  let comments = '';
  if (fb && Array.isArray(fb.plugins)) {
    fb.plugins.forEach((p) => {
      (Array.isArray(p?.editorfields) ? p.editorfields : []).forEach((f) => {
        if (!comments && f?.text) comments = plainText(f.text, 800, pref);
      });
    });
  }
  return {
    status,
    modified: ms(sub?.timemodified),
    graded: last.gradingstatus === 'graded' || Boolean(fb && fb.gradeddate),
    grade: fb ? plainText(fb.gradefordisplay, 40, pref) : '',
    gradedAt: fb ? ms(fb.gradeddate) : 0,
    feedback: comments,
    extension: ms(last.extensionduedate),
  };
}

// ---------------------------------------------------------------------------
// Resúmenes para la pantalla de notas
// ---------------------------------------------------------------------------

// Una entrada por asignatura con nota: { id, formatted, pct, items, last }
export function courseSummaries(grades, courses = []) {
  const map = (grades && grades.courses) || {};
  const names = new Map(courses.map((c) => [Number(c.id), c]));
  return Object.entries(map)
    .map(([id, g]) => {
      const cid = Number(id);
      const items = Array.isArray(g.items) ? g.items : [];
      const graded = items.filter((i) => i.formatted);
      const last = graded.reduce((m, i) => Math.max(m, i.graded || 0), 0);
      const total = g.total || null;
      const formatted = (total && total.formatted) || g.formatted || '';
      const pct = total && total.pct !== null ? total.pct : null;
      return { id: cid, course: names.get(cid) || null, formatted, pct, max: total ? total.max : null, items, gradedCount: graded.length, last };
    })
    .filter((c) => c.formatted || c.gradedCount)
    .sort((a, b) => (b.last || 0) - (a.last || 0) || String(a.course?.fullname || '').localeCompare(String(b.course?.fullname || ''), 'es'));
}

// Media de los porcentajes de las asignaturas con nota numérica (0..1) o null.
export function averagePct(summaries) {
  const vals = summaries.map((s) => s.pct).filter((p) => typeof p === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Calificaciones recientes de todas las asignaturas, las más nuevas primero.
export function recentGrades(grades, since, limit = 8) {
  const out = [];
  Object.entries((grades && grades.courses) || {}).forEach(([cid, g]) => {
    (g.items || []).forEach((i) => {
      if (i.formatted && i.graded && i.graded >= since) out.push({ ...i, courseId: Number(cid) });
    });
  });
  return out.sort((a, b) => b.graded - a.graded).slice(0, limit);
}

// Escala de 0 a 10 a partir de un porcentaje, con una decimal y coma.
export function outOfTen(pct) {
  if (typeof pct !== 'number') return '';
  return (Math.round(pct * 100) / 10).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// Tono de una nota: 'low' (< 50 %), 'mid' (50-69 %), 'high' (>= 70 %) o '' si no es numérica.
export function gradeTone(pct) {
  if (typeof pct !== 'number') return '';
  if (pct < 0.5) return 'low';
  if (pct < 0.7) return 'mid';
  return 'high';
}

// Ejecuta tareas asíncronas con un máximo de N a la vez (para no saturar Moodle).
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      try {
        out[k] = await fn(items[k], k);
      } catch {
        out[k] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
