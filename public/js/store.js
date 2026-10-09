// Lógica pura de tareas: agrupar, filtrar, fusionar sincronizaciones y formatear
// fechas. No toca el DOM, así que se puede probar con node --test.

const DAY = 86_400_000;
const HISTORY_MAX = 300;
const HISTORY_DAYS = 120;

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function bucketOf(task, now) {
  if (task.due < now) return 'overdue';
  const today = startOfDay(now);
  const diffDays = Math.round((startOfDay(task.due) - today) / DAY);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays < 7) return 'week';
  return 'later';
}

export const BUCKETS = [
  { id: 'overdue', label: 'Atrasadas' },
  { id: 'today', label: 'Hoy' },
  { id: 'tomorrow', label: 'Mañana' },
  { id: 'week', label: 'Próximos 7 días' },
  { id: 'later', label: 'Más adelante' },
];

export function pendingTasks(tasks, done) {
  return tasks.filter((t) => !done[t.id]);
}

export function summarize(tasks, done, now) {
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
    by,
  };
}

export function filterTasks(tasks, { done = {}, view = 'pending', course = null, query = '' }, now) {
  const q = query.trim().toLocaleLowerCase('es');
  return tasks.filter((t) => {
    const isDone = Boolean(done[t.id]);
    if (view === 'pending' && isDone) return false;
    if (view === 'overdue' && (isDone || t.due >= now)) return false;
    if (view === 'week' && (isDone || t.due < now || bucketOf(t, now) === 'later')) return false;
    if (course !== null && t.courseId !== course) return false;
    if (q && !`${t.title} ${t.courseName} ${t.courseShort}`.toLocaleLowerCase('es').includes(q)) return false;
    return true;
  });
}

export function groupByBucket(tasks, now) {
  const groups = new Map(BUCKETS.map((b) => [b.id, []]));
  [...tasks].sort((a, b) => a.due - b.due).forEach((t) => groups.get(bucketOf(t, now)).push(t));
  return BUCKETS.map((b) => ({ ...b, tasks: groups.get(b.id) })).filter((g) => g.tasks.length);
}

// Tras sincronizar: lo que estaba pendiente y ya no aparece en la línea de
// tiempo de Moodle se ha entregado (o el profesorado lo ha quitado). Lo
// guardamos en el historial para que la vista "Hechas" tenga sentido.
export function mergeSync(prev, fresh, history, now) {
  const freshIds = new Set(fresh.map((t) => t.id));
  const known = new Set(history.map((h) => h.id));
  const vanished = prev
    .filter((t) => t.source === 'moodle' && !freshIds.has(t.id) && !known.has(t.id))
    .map((t) => ({ ...t, completedAt: now, how: 'moodle' }));
  const cutoff = now - HISTORY_DAYS * DAY;
  const nextHistory = [...vanished, ...history.filter((h) => !freshIds.has(h.id))]
    .filter((h) => h.completedAt >= cutoff)
    .slice(0, HISTORY_MAX);
  return { tasks: fresh, history: nextHistory, newlyCompleted: vanished.length };
}

export function pruneDone(done, tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  return Object.fromEntries(Object.entries(done).filter(([id]) => ids.has(id)));
}

export function coursesFromTasks(tasks, courses = []) {
  const map = new Map();
  courses.forEach((c) =>
    map.set(Number(c.id), {
      id: Number(c.id),
      name: String(c.fullname || c.displayname || ''),
      short: String(c.shortname || ''),
      progress: typeof c.progress === 'number' ? Math.round(c.progress) : null,
      count: 0,
    })
  );
  tasks.forEach((t) => {
    if (!map.has(t.courseId)) map.set(t.courseId, { id: t.courseId, name: t.courseName, short: t.courseShort, progress: null, count: 0 });
    map.get(t.courseId).count++;
  });
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

// Tono estable por asignatura (0-359), para la marca de color de cada fila.
export function courseHue(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const palette = [18, 48, 95, 150, 190, 222, 262, 300, 335];
  return palette[(h >>> 0) % palette.length];
}

const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const shortDayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });

export const formatTime = (ts) => timeFmt.format(ts);
export const formatDay = (ts) => dayFmt.format(ts);
export const formatShortDay = (ts) => shortDayFmt.format(ts);

export function formatDue(ts, now) {
  const b = bucketOf({ due: ts }, now);
  if (b === 'today') return `Hoy, ${formatTime(ts)}`;
  if (b === 'tomorrow') return `Mañana, ${formatTime(ts)}`;
  const s = formatShortDay(ts);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}, ${formatTime(ts)}`;
}

export function relative(ts, now) {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60_000);
  const h = Math.round(abs / 3_600_000);
  const d = Math.round(abs / DAY);
  let s;
  if (m < 1) s = 'menos de 1 min';
  else if (m < 60) s = `${m} min`;
  else if (h < 48) s = `${h} h`;
  else s = `${d} días`;
  return diff >= 0 ? `en ${s}` : `hace ${s}`;
}

export function countdown(ts, now) {
  const diff = Math.max(0, ts - now);
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return { d, h, m };
}

// Densidad de entregas para la franja de los próximos 14 días.
export function horizon(tasks, now, days = 14) {
  const start = startOfDay(now);
  const out = Array.from({ length: days }, (_, i) => ({ ts: startOfDay(start + i * DAY + DAY / 2), tasks: [] }));
  tasks.forEach((t) => {
    if (t.due < now) return;
    const i = Math.round((startOfDay(t.due) - start) / DAY);
    if (i >= 0 && i < days) out[i].tasks.push(t);
  });
  return out;
}
