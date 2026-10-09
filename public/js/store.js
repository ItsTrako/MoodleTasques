// Lógica pura de tareas: agrupar, filtrar, fusionar sincronizaciones, colores
// de asignatura y formato de fechas. No toca el DOM, así que se puede probar
// con node --test.

export const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

export const HISTORY_MAX = 300;
export const HISTORY_DAYS = 120;
// Las marcas manuales de tareas que ya no están en la caché se guardan este tiempo.
export const DONE_KEEP_DAYS = 120;

export const plural = (n, one, many) => (n === 1 ? one : many);

// ---------------------------------------------------------------------------
// Días de calendario (seguros con el cambio de hora)
// ---------------------------------------------------------------------------

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Inicio del día que cae n días de calendario después del día de ts.
export function addDays(ts, n) {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

// Días de calendario de b a a (no horas / 24).
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY);

// ---------------------------------------------------------------------------
// Grupos, resumen y filtros
// ---------------------------------------------------------------------------

export function bucketOf(task, now = Date.now()) {
  if (task.due < now) return 'overdue';
  const diffDays = dayDiff(task.due, now);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays < 7) return 'week';
  return 'later';
}

export const BUCKETS = [
  { id: 'overdue', label: 'Atrasadas' },
  { id: 'today', label: 'Hoy' },
  { id: 'tomorrow', label: 'Mañana' },
  { id: 'week', label: 'Próximos días' },
  { id: 'later', label: 'Más adelante' },
];

// Tipo de actividad de Moodle: [etiqueta, icono].
export const KIND_LABEL = {
  assign: ['Tarea', 'file-text'],
  quiz: ['Cuestionario', 'exam'],
  forum: ['Foro', 'chats-circle'],
  workshop: ['Taller', 'note-pencil'],
  lesson: ['Lección', 'books'],
  scorm: ['SCORM', 'books'],
  choice: ['Consulta', 'list-checks'],
  feedback: ['Encuesta', 'note-pencil'],
  data: ['Base de datos', 'books'],
  glossary: ['Glosario', 'books'],
  h5pactivity: ['H5P', 'play'],
  lti: ['Herramienta externa', 'link-simple'],
  wiki: ['Wiki', 'note-pencil'],
  other: ['Actividad', 'calendar-blank'],
};

export const kindOf = (kind) => (Object.hasOwn(KIND_LABEL, kind) ? KIND_LABEL[kind] : KIND_LABEL.other);

const isDone = (done, id) => Boolean(done && Object.hasOwn(done, id) && done[id]);

export function pendingTasks(tasks, done) {
  return tasks.filter((t) => !isDone(done, t.id));
}

export function summarize(tasks, done, now = Date.now()) {
  const pending = pendingTasks(tasks, done);
  const by = { overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0 };
  pending.forEach((t) => by[bucketOf(t, now)]++);
  const upcoming = pending.filter((t) => t.due >= now).sort((a, b) => a.due - b.due);
  return {
    pending: pending.length,
    overdue: by.overdue,
    today: by.today,
    thisWeek: by.today + by.tomorrow + by.week,
    next: upcoming[0] || null,
    after: upcoming[1] || null,
    by,
  };
}

// Texto plegado para buscar: minúsculas, sin acentos ni puntuación. "cèl·lula",
// "cel.lula" y "célula" quedan igual, y la ll catalana se reduce a l para que
// también encuentre "Llengua" quien escribe "lengua".
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[·‧•.'’`´]/g, '')
    .replace(/ll/g, 'l')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Los campos que faltan cuentan como vacíos (nunca como el texto "undefined").
const haystack = (t) =>
  fold([t.title, t.courseName, t.courseShort, courseCode(t.courseShort, t.courseName), kindOf(t.kind)[0]].map((v) => v ?? '').join(' '));

// view: 'pending' | 'overdue' | 'today' | 'week' | 'all'. 'all' no mira ni las
// marcas ni la fecha (sirve para la vista Hechas). day es el inicio de un día
// (startOfDay) y minDue descarta lo que venció antes de esa fecha.
//
// Búsqueda: cada palabra tiene que aparecer. Una palabra en castellano acabada
// en n también encuentra la catalana que la pierde al final ("platon" ->
// "Plató", "informacion" -> "Informació").
export function filterTasks(tasks, { done = {}, view = 'pending', course = null, query = '', day = null, minDue = null } = {}, now = Date.now()) {
  const words = fold(String(query ?? '').trim()).split(' ').filter(Boolean);
  const all = view === 'all';
  // null, undefined o '' (la opción "Todas" de un select) no filtran.
  const isSet = (v) => v !== null && v !== undefined && v !== '';
  const dayStart = isSet(day) ? startOfDay(Number(day)) : null;
  const hasCourse = isSet(course);
  const hasMin = isSet(minDue) && Number.isFinite(Number(minDue));
  return tasks.filter((t) => {
    if (!all) {
      if (isDone(done, t.id)) return false;
      if (hasMin && t.due < Number(minDue)) return false;
      const b = bucketOf(t, now);
      if (view === 'overdue' && b !== 'overdue') return false;
      if (view === 'today' && b !== 'today') return false;
      if (view === 'week' && b !== 'today' && b !== 'tomorrow' && b !== 'week') return false;
    }
    if (hasCourse && String(t.courseId) !== String(course)) return false;
    if (dayStart !== null && startOfDay(t.due) !== dayStart) return false;
    if (words.length) {
      const hay = haystack(t) + ' ';
      if (!words.every((w) => hay.includes(w) || (w.length >= 5 && w.endsWith('n') && hay.includes(w.slice(0, -1) + ' ')))) return false;
    }
    return true;
  });
}

export function groupByBucket(tasks, now = Date.now()) {
  const groups = new Map(BUCKETS.map((b) => [b.id, []]));
  [...tasks].sort((a, b) => a.due - b.due).forEach((t) => groups.get(bucketOf(t, now)).push(t));
  return BUCKETS.map((b) => ({ ...b, tasks: groups.get(b.id) })).filter((g) => g.tasks.length);
}

// ---------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------

// Tras sincronizar, lo que estaba pendiente y ya no aparece en la línea de
// tiempo de Moodle pasa al historial. No sabemos si se entregó: Moodle también
// quita un cuestionario cuando cierra aunque no se haya hecho. Por eso se
// guarda como 'gone' (ya no aparece) o 'expired' (cuestionario cerrado).
export function mergeSync(prev = [], fresh = [], history = [], now = Date.now()) {
  const freshIds = new Set(fresh.map((t) => t.id));
  const known = new Set(history.map((h) => h.id));
  const vanished = prev
    .filter((t) => t.source === 'moodle' && !freshIds.has(t.id) && !known.has(t.id))
    .map((t) => ({ ...t, completedAt: now, how: t.kind === 'quiz' && t.due <= now ? 'expired' : 'gone' }));
  const expired = vanished.filter((t) => t.how === 'expired').length;
  const gone = vanished.length - expired;
  const cutoff = now - HISTORY_DAYS * DAY;
  const nextHistory = [...vanished, ...history.filter((h) => !freshIds.has(h.id))]
    .filter((h) => Number.isFinite(h.completedAt) && h.completedAt >= cutoff)
    .slice(0, HISTORY_MAX);
  return { tasks: fresh, history: nextHistory, gone, expired, newlyCompleted: gone + expired };
}

// Conserva la marca si la tarea sigue en la caché o si se puso hace menos de
// 120 días (así acortar "Mostrar atrasadas de" no borra marcas).
export function pruneDone(done, tasks, now = Date.now()) {
  const ids = new Set(tasks.map((t) => t.id));
  const keep = DONE_KEEP_DAYS * DAY;
  return Object.fromEntries(Object.entries(done || {}).filter(([id, ts]) => ids.has(id) || now - Number(ts) < keep));
}

// ---------------------------------------------------------------------------
// Asignaturas: lista, código corto y color
// ---------------------------------------------------------------------------

export function coursesFromTasks(tasks, courses = []) {
  const map = new Map();
  (courses || []).forEach((c) => {
    const id = Number(c.id);
    const name = String(c.fullname || c.displayname || c.name || '');
    const short = String(c.shortname || c.short || '');
    map.set(id, {
      id,
      name,
      short,
      code: courseCode(short, name),
      progress: typeof c.progress === 'number' && Number.isFinite(c.progress) ? Math.round(c.progress) : null,
      hidden: Boolean(c.hidden),
      enddate: Number(c.enddate) > 0 ? Number(c.enddate) : 0,
      count: 0,
    });
  });
  tasks.forEach((t) => {
    if (!map.has(t.courseId)) {
      const name = String(t.courseName || '');
      const short = String(t.courseShort || '');
      map.set(t.courseId, { id: t.courseId, name, short, code: courseCode(short, name), progress: null, hidden: false, enddate: 0, count: 0 });
    }
    map.get(t.courseId).count++;
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'es') || String(a.id).localeCompare(String(b.id)));
}

// Código corto de la asignatura ('MAT2', 'LCL', 'FIS'): el nombre corto de
// Moodle si ya es corto; si no, las iniciales del nombre más su número.
const STOP = new Set(['i', 'de', 'del', 'la', 'el', 'les', 'els', 'los', 'las', 'y', 'e', 'a', 'en', 'of', 'and', 'the', 'per', 'amb']);
export function courseCode(short, name) {
  const s = String(short || '').trim();
  if (s && s.length <= 6 && !/\s/.test(s) && !/\d{3,}/.test(s)) return s.toUpperCase();
  const words = String(name || s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\b[ldLD]['’]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const last = words.at(-1) || '';
  const n = /^\d{1,2}$/.test(last) ? last : { I: '1', II: '2', III: '3', IV: '4' }[last] || '';
  const sig = words.filter((w, i) => !STOP.has(w.toLowerCase()) && !(n && i === words.length - 1));
  const code = sig.length >= 3 ? sig.slice(0, 3).map((w) => w[0]).join('') : (sig[0] || 'CUR').slice(0, 3);
  return (code + n).toUpperCase().slice(0, 5);
}

// Ocho tonos separados de los colores de estado (rojo, ámbar, verde).
export const COURSE_HUES = [295, 195, 345, 228, 125, 320, 210, 105];

function hash(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const validIndex = (v) => Number.isInteger(v) && v >= 0 && v < COURSE_HUES.length;
const byIdAsc = (a, b) => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
};

// Asigna a cada asignatura un índice de COURSE_HUES. Las que ya tenían color lo
// conservan. Las nuevas, en orden ascendente de id, reciben el índice libre más
// bajo y, cuando ya están los 8 en uso, el menos usado.
export function assignCourseColors(prev = {}, ids = []) {
  const map = {};
  Object.entries(prev || {}).forEach(([k, v]) => {
    if (validIndex(v)) map[k] = v;
  });
  const current = [...new Set((ids || []).map(String))];
  const uses = new Array(COURSE_HUES.length).fill(0);
  current.forEach((id) => {
    if (Object.hasOwn(map, id)) uses[map[id]]++;
  });
  current
    .filter((id) => !Object.hasOwn(map, id))
    .sort(byIdAsc)
    .forEach((id) => {
      let best = 0;
      for (let i = 1; i < uses.length; i++) if (uses[i] < uses[best]) best = i;
      map[id] = best;
      uses[best]++;
    });
  return map;
}

export function courseHueOf(map, id) {
  const v = map && Object.hasOwn(map, String(id)) ? map[String(id)] : undefined;
  return COURSE_HUES[validIndex(v) ? v : hash(id) % COURSE_HUES.length];
}

/** @deprecated Usa courseHueOf(map, id). */
export const courseHue = (id) => courseHueOf({}, id);

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

// Nombres fijos para no depender de los datos de idioma del navegador.
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const WEEKDAYS_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sameYear = (a, b) => new Date(a).getFullYear() === new Date(b).getFullYear();

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 'sáb 17 oct'
export function formatShortDay(ts) {
  const d = new Date(ts);
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

// 'viernes, 9 de octubre'
export function formatDay(ts) {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

// 'sábado 17 de octubre'
export function formatWeekdayDate(ts) {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

// 'sábado, 10 de octubre, 14:00' (con el año si no es el actual)
export function formatLongDate(ts, now = Date.now()) {
  const year = sameYear(ts, now) ? '' : ` de ${new Date(ts).getFullYear()}`;
  return `${formatDay(ts)}${year}, ${formatTime(ts)}`;
}

// { day: 'Hoy' | 'Mañana' | 'Ayer' | 'mié 7 oct', time: '23:59' }
export function formatDueParts(ts, now = Date.now()) {
  const diff = dayDiff(ts, now);
  let day;
  if (diff === 0) day = 'Hoy';
  else if (diff === 1) day = 'Mañana';
  else if (diff === -1) day = 'Ayer';
  else day = formatShortDay(ts) + (sameYear(ts, now) ? '' : ` ${new Date(ts).getFullYear()}`);
  return { day, time: formatTime(ts) };
}

// 'Hoy, 18:00', 'Mié 7 oct, 23:59'
export function formatDue(ts, now = Date.now()) {
  const { day, time } = formatDueParts(ts, now);
  return cap(`${day}, ${time}`);
}

// 'ahora', 'en 5 min', 'hace 36 h', 'en 2 días'. Más allá de 48 h cuenta días
// de calendario: el domingo visto desde el viernes está 'en 2 días'.
export function relative(ts, now = Date.now()) {
  const diff = ts - now;
  if (!Number.isFinite(diff)) return '';
  const abs = Math.abs(diff);
  if (abs < MIN) return 'ahora';
  let s;
  if (abs < HOUR) s = `${Math.floor(abs / MIN)} min`;
  else if (abs < 48 * HOUR) s = `${Math.floor(abs / HOUR)} h`;
  else s = `${Math.max(2, Math.abs(dayDiff(ts, now)))} días`;
  return diff > 0 ? `en ${s}` : `hace ${s}`;
}

// Línea corta para el móvil: 'hace 36 h', '18:00 · en 6 h', '23:59',
// 'dom 22:00' o 'sáb 17 oct'.
export function formatDueCompact(ts, now = Date.now()) {
  const b = bucketOf({ due: ts }, now);
  if (b === 'overdue') return relative(ts, now);
  if (b === 'today') return `${formatTime(ts)} · ${relative(ts, now)}`;
  if (b === 'tomorrow') return formatTime(ts);
  if (b === 'week') return `${WEEKDAYS_SHORT[new Date(ts).getDay()]} ${formatTime(ts)}`;
  return formatDueParts(ts, now).day;
}

const UNIT_WORDS = { d: ['día', 'días'], h: ['hora', 'horas'], min: ['minuto', 'minutos'] };

// Cuenta atrás con las dos unidades más significativas, sin ceros:
// [[2,'d'],[4,'h']], [[5,'h'],[56,'min']], [[42,'min']] o [['menos de 1','min']].
export function countdownParts(ts, now = Date.now()) {
  const diff = ts - now;
  if (diff <= 0) return { parts: [[0, 'min']], aria: 'El plazo ha vencido', urgent: true, past: true };
  if (diff < MIN) return { parts: [['menos de 1', 'min']], aria: 'Falta menos de 1 minuto', urgent: true, past: false };
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / HOUR);
  const m = Math.floor((diff % HOUR) / MIN);
  let parts;
  if (d > 0) parts = h > 0 ? [[d, 'd'], [h, 'h']] : [[d, 'd']];
  else if (h > 0) parts = m > 0 ? [[h, 'h'], [m, 'min']] : [[h, 'h']];
  else parts = [[m, 'min']];
  const words = parts.map(([n, u]) => `${n} ${plural(n, ...UNIT_WORDS[u])}`);
  const verb = parts.length === 1 && parts[0][0] === 1 ? 'Falta' : 'Faltan';
  return { parts, aria: `${verb} ${words.join(' y ')}`, urgent: diff < HOUR, past: false };
}

/** @deprecated Usa countdownParts(ts, now). */
export function countdown(ts, now = Date.now()) {
  const diff = Math.max(0, ts - now);
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / HOUR);
  const m = Math.floor((diff % HOUR) / MIN);
  return { d, h, m };
}

// Duración legible para "Queda" y "Venció hace": '1 día 2 h', '5 h 3 min', '42 min'.
export function durationText(ms) {
  const a = Math.abs(ms);
  if (a < MIN) return 'menos de 1 min';
  const d = Math.floor(a / DAY);
  const h = Math.floor((a % DAY) / HOUR);
  const m = Math.floor((a % HOUR) / MIN);
  if (d > 0) return `${d} ${plural(d, 'día', 'días')}${h ? ` ${h} h` : ''}`;
  if (h > 0) return `${h} h${m ? ` ${m} min` : ''}`;
  return `${m} min`;
}

// Entregas de los próximos días, un elemento por día de calendario (el primero
// es hoy). ts es el inicio de cada día, también en los días de cambio de hora.
export function horizon(tasks, now = Date.now(), days = 14) {
  const out = [];
  const index = new Map();
  for (let i = 0; i < days; i++) {
    const ts = addDays(now, i);
    index.set(ts, out.length);
    out.push({ ts, tasks: [] });
  }
  [...tasks]
    .sort((a, b) => a.due - b.due)
    .forEach((t) => {
      if (!(t.due >= now)) return;
      const i = index.get(startOfDay(t.due));
      if (i !== undefined) out[i].tasks.push(t);
    });
  return out;
}
