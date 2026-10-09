// Cliente mínimo de los servicios web REST de Moodle.
//
// Usa el mismo servicio que la app oficial de Moodle (moodle_mobile_app), que
// la mayoría de centros tienen activado. El token viaja siempre en el cuerpo
// del POST, nunca en la URL, para que no acabe en registros ni historiales.

const SERVICE = 'moodle_mobile_app';
const PAGE = 50;
const MAX_PAGES = 12;
export const TIMEOUT_MS = 25_000;
const MAX_DUE = Date.UTC(2100, 0, 1);

export class MoodleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MoodleError';
    this.code = code || 'unknown';
  }
}

const NOT_FOUND = 'No encontramos Moodle en esa dirección. En educaciodigital.cat suele acabar en /moodle.';
const REJECTED = 'Moodle ha rechazado el acceso guardado. Vuelve a conectar.';
const MAINTENANCE = 'Moodle está en mantenimiento. Prueba más tarde.';
const NO_LOGIN = 'Tu cuenta no puede iniciar sesión. Habla con tu centro.';

// Mensajes para la persona, por código de error. Nunca se muestra el texto libre
// que devuelve el servidor.
export const FRIENDLY = {
  // Acceso
  invalidlogin: 'Usuario o contraseña incorrectos. ¿Entras en Moodle con Google o XTEC? Usa «Tengo un token».',
  invalidtoken: REJECTED,
  accessexception: REJECTED,
  badtoken: 'El token tiene 32 letras y números (0-9, a-f).',
  otheruser: 'Esa cuenta no es la que tenías conectada. Borra los datos desde Ajustes para cambiar de usuario.',
  notoken: 'Moodle no ha devuelto un token válido.',
  noinfo: 'Moodle no ha devuelto los datos de tu cuenta.',
  empty: 'Escribe tu usuario y tu contraseña.',
  // Cuenta y centro
  enablewsdescription: 'Tu Moodle no tiene activados los servicios web. Pide a tu centro que activen la app móvil o usa un token.',
  servicenotavailable: 'El servicio de la app móvil no está disponible en este Moodle.',
  usernotallowed: 'Tu usuario no tiene permiso para usar el servicio de la app móvil.',
  sitemaintenance: MAINTENANCE,
  forcepasswordchangenotice: 'Moodle te pide cambiar la contraseña. Entra en la web, cámbiala y vuelve.',
  restoredaccountresetpassword: 'Tienes que restablecer la contraseña desde la web de Moodle.',
  sitepolicynotagreed: 'Moodle te pide aceptar sus normas de uso. Entra en Moodle, acéptalas y vuelve a sincronizar.',
  usernotfullysetup: 'Completa tu perfil en la web de Moodle.',
  wsaccessusersuspended: 'Tu cuenta de Moodle está suspendida.',
  wsaccessusernologin: NO_LOGIN,
  usernotconfirmed: NO_LOGIN,
  passwordisexpired: 'Tu contraseña de Moodle ha caducado. Cámbiala en la web.',
  requirecorrectaccess: 'Usa exactamente la dirección de tu Moodle.',
  noguest: 'Las cuentas de invitado no pueden usar Tasques.',
  // Dirección
  nourl: 'Escribe la dirección de tu Moodle.',
  badurl: 'Esa dirección no parece válida.',
  insecure: 'Por seguridad solo se admiten direcciones https://.',
  http404: NOT_FOUND,
  badjson: NOT_FOUND,
  http503: MAINTENANCE,
  http429: 'Hay demasiadas peticiones a la vez. Prueba en un momento.',
  // Conexión
  network: 'No hemos podido conectar con tu Moodle. Revisa la dirección y tu conexión a Internet.',
  timeout: 'Moodle tarda demasiado en responder. Prueba en un momento.',
  offline: 'Sin conexión a Internet.',
  localserver: 'Tasques está cerrado en tu ordenador. Ábrelo con el icono «Tasques» (o Iniciar.cmd) y pulsa Sincronizar.',
  aborted: 'Se ha cancelado la conexión con Moodle.',
};

// Mensaje para un código de error. Los códigos desconocidos solo muestran el código.
export function friendlyMessage(code) {
  const c = String(code || '');
  if (Object.hasOwn(FRIENDLY, c)) return FRIENDLY[c];
  const http = /^http(\d{3})$/.exec(c);
  if (http) return `Moodle ha devuelto un error (${http[1]}).`;
  if (!c || c === 'moodle' || c === 'unknown') return 'Moodle ha devuelto un error.';
  return `Moodle ha devuelto un error (${c}).`;
}

// Al conectar con un token que Moodle rechaza. invalidtoken: no existe (mal
// copiado, o es la clave RSS, que también tiene 32 letras). accessexception:
// existía pero ha caducado o se ha anulado.
export const tokenErrorMessage = (code) =>
  code === 'accessexception'
    ? 'Ese token ha caducado o ya no vale. Entra otra vez en la app oficial de Moodle del móvil y copia el token nuevo de Claus de seguretat.'
    : 'Moodle no reconoce ese token. Copia el de la fila «Moodle mobile web service» (la clave RSS no sirve). Si no tienes esa fila, entra una vez en la app oficial de Moodle del móvil y vuelve a mirar.';

const safeCode = (c) => (typeof c === 'string' && /^[a-z0-9_]{1,60}$/i.test(c) ? c.toLowerCase() : 'moodle');

export function normalizeSiteUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new MoodleError(FRIENDLY.nourl, 'nourl');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MoodleError(FRIENDLY.badurl, 'badurl');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new MoodleError(FRIENDLY.insecure, 'insecure');
  }
  if (url.username || url.password) throw new MoodleError('La dirección no puede incluir credenciales.', 'badurl');
  // Recorta páginas típicas que la gente copia de la barra del navegador.
  const parts = url.pathname.split('/').filter(Boolean);
  const stop = ['my', 'login', 'course', 'mod', 'user', 'admin', 'calendar', 'grade', 'message'];
  const idx = parts.findIndex((p) => stop.includes(p) || p.endsWith('.php'));
  const base = idx === -1 ? parts : parts.slice(0, idx);
  return url.origin + (base.length ? '/' + base.join('/') : '');
}

// Solo deja pasar enlaces https del propio Moodle. Cualquier otra cosa se descarta.
export function safeMoodleLink(link, siteUrl) {
  if (!link || !siteUrl) return null;
  try {
    const u = new URL(link, siteUrl + '/');
    const site = new URL(siteUrl);
    if (u.origin !== site.origin) return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.href;
  } catch {
    return null;
  }
}

function form(params) {
  const body = new URLSearchParams();
  const add = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${prefix}[${i}]`, v));
    else if (typeof value === 'object') Object.entries(value).forEach(([k, v]) => add(`${prefix}[${k}]`, v));
    else body.append(prefix, String(value));
  };
  Object.entries(params).forEach(([k, v]) => add(k, v));
  return body;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException('Tiempo agotado', 'TimeoutError')), ms);
  return ctrl.signal;
}

const BRIDGE_REFUSALS = new Set([400, 403, 404, 405, 415, 421]);
const isOffline = () => globalThis.navigator?.onLine === false;
const headerOf = (res, name) => {
  try {
    return String(res.headers?.get?.(name) || '');
  } catch {
    return '';
  }
};

export class MoodleClient {
  constructor({ siteUrl, token = null, transport = 'auto', fetchImpl = globalThis.fetch?.bind(globalThis), signal = null } = {}) {
    this.siteUrl = normalizeSiteUrl(siteUrl);
    this.token = token;
    this.transport = transport; // 'auto' | 'direct' | 'proxy'
    this.fetch = fetchImpl;
    this.signal = signal || null;
  }

  // Cada petición tiene su propio plazo de 25 s, y se corta también si se
  // cancela la sincronización (this.signal).
  requestSignal() {
    const timeout = timeoutSignal(TIMEOUT_MS);
    if (!this.signal) return timeout;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([this.signal, timeout]);
    // Navegadores sin AbortSignal.any (Safari < 17.4): se combinan a mano.
    const ctrl = new AbortController();
    for (const s of [this.signal, timeout]) {
      if (s.aborted) {
        ctrl.abort(s.reason);
        break;
      }
      s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
    }
    return ctrl.signal;
  }

  // Traduce el fallo de fetch (o de leer la respuesta) a un MoodleError, o
  // devuelve null si merece la pena probar otra vía.
  fetchFailure(err, via) {
    if (this.signal?.aborted) return new MoodleError(FRIENDLY.aborted, 'aborted');
    if (err && err.name === 'TimeoutError') return new MoodleError(FRIENDLY.timeout, 'timeout');
    if (isOffline()) return new MoodleError(FRIENDLY.offline, 'offline');
    if (via === 'proxy') return new MoodleError(FRIENDLY.localserver, 'localserver');
    return null;
  }

  async post(path, params) {
    const body = form(params);
    const direct = () =>
      this.fetch(`${this.siteUrl}/${path}`, {
        method: 'POST',
        body,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: this.requestSignal(),
      });
    const proxy = () =>
      this.fetch('/api/proxy', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ site: this.siteUrl, path, body: body.toString() }),
        signal: this.requestSignal(),
      });

    const viaProxy = async () => {
      let r;
      try {
        r = await proxy();
      } catch (err) {
        throw this.fetchFailure(err, 'proxy');
      }
      // Estos errores en texto plano los da el propio puente (apagado, sitio
      // no permitido, otro origen...); lo que viene de Moodle llega como JSON.
      // No son un "no encontramos Moodle en esa dirección".
      if (BRIDGE_REFUSALS.has(r.status) && !/json/i.test(headerOf(r, 'content-type'))) {
        throw new MoodleError(FRIENDLY.network, 'network');
      }
      return r;
    };

    let res;
    if (this.transport === 'proxy') {
      res = await viaProxy();
    } else {
      try {
        res = await direct();
      } catch (err) {
        const fatal = this.fetchFailure(err, 'direct');
        if (fatal) throw fatal;
        if (this.transport !== 'auto') throw new MoodleError(FRIENDLY.network, 'network');
        // El navegador no ha podido (CORS o red): probamos el puente local.
        res = await viaProxy();
        this.transport = 'proxy';
      }
    }

    if (!res.ok) {
      let code = 'http' + res.status;
      try {
        const j = await res.json();
        if (j && typeof j === 'object' && j.errorcode) code = safeCode(j.errorcode);
      } catch {
        // HTML de error: nos quedamos con el código HTTP.
      }
      throw new MoodleError(friendlyMessage(code), code);
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw this.fetchFailure(err, 'direct') || new MoodleError(FRIENDLY.badjson, 'badjson');
    }
    if (data && typeof data === 'object' && !Array.isArray(data) && (data.exception || data.errorcode || data.error)) {
      const code = safeCode(data.errorcode);
      throw new MoodleError(friendlyMessage(code), code);
    }
    return data;
  }

  async login(username, password) {
    const data = await this.post('login/token.php', { username, password, service: SERVICE });
    if (!data || typeof data.token !== 'string' || !/^[a-f0-9]{32}$/i.test(data.token)) {
      throw new MoodleError(FRIENDLY.notoken, 'notoken');
    }
    this.token = data.token;
    return data.token;
  }

  call(wsfunction, params = {}) {
    if (!this.token) return Promise.reject(new MoodleError('Falta el token de Moodle.', 'notoken'));
    return this.post('webservice/rest/server.php', {
      wstoken: this.token,
      wsfunction,
      moodlewsrestformat: 'json',
      // Aplica los filtros de idioma de Moodle (multilang) a nombres y textos.
      moodlewssettingfilter: 'true',
      ...params,
    });
  }

  siteInfo() {
    return this.call('core_webservice_get_site_info');
  }

  async courses(userid) {
    const list = await this.call('core_enrol_get_users_courses', { userid, returnusercount: 0 });
    return Array.isArray(list) ? list : [];
  }

  // Eventos de "acción" del calendario: exactamente lo que muestra el bloque
  // Línea de tiempo. Solo aparecen actividades que aún requieren algo de ti.
  // Sin duplicados: si Moodle reinicia la paginación, se para.
  async actionEvents({ fromSeconds }) {
    const all = [];
    const seen = new Set();
    let after;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.call('core_calendar_get_action_events_by_timesort', {
        timesortfrom: fromSeconds,
        limitnum: PAGE,
        limittononsuspendedevents: 1,
        ...(after ? { aftereventid: after } : {}),
      });
      const events = Array.isArray(res?.events) ? res.events.filter((e) => e && typeof e === 'object') : [];
      let added = 0;
      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        all.push(e);
        added++;
      }
      if (events.length < PAGE || !added) break;
      after = events[events.length - 1].id;
    }
    return all;
  }

  // --- Notas y detalles (ver details.js para el formato) ---
  courseGrades() {
    return this.call('gradereport_overview_get_course_grades');
  }

  gradeItems(courseid, userid) {
    return this.call('gradereport_user_get_grade_items', { courseid, userid });
  }

  assignments(courseids) {
    return this.call('mod_assign_get_assignments', { courseids });
  }

  submissionStatus(assignid) {
    return this.call('mod_assign_get_submission_status', { assignid });
  }

  quizzes(courseids) {
    return this.call('mod_quiz_get_quizzes_by_courses', { courseids });
  }
}

// ---------------------------------------------------------------------------
// Texto que llega de Moodle
// ---------------------------------------------------------------------------

// Moodle devuelve los nombres ya pasados por format_string (p. ej. "R&amp;D").
// Los decodificamos como texto plano, sin pasar nunca por el parser HTML.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Sin sustitutos sueltos (D800-DFFF): no son caracteres válidos.
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Controles de dirección (LRE, RLO, aislamientos...) que pueden cambiar cómo se lee un texto.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

const SPAN_ML = /<span\b(?=[^>]*\bclass=["']?[^"'>]*\bmultilang\b)(?=[^>]*\blang=["']?([\w-]+))[^>]*>([\s\S]*?)<\/span>/gi;
const MLANG = /\{mlang\s+([\w,-]+)\s*\}([\s\S]*?)\{mlang\}/gi;

const langKey = (l) => {
  const s = String(l || '').toLowerCase();
  return s === 'other' ? 'other' : s.slice(0, 2);
};

function chooseLang(entries, pref) {
  const by = new Map();
  entries.forEach(([l, t]) => by.has(l) || by.set(l, t));
  return by.get(pref) ?? by.get('es') ?? by.get('ca') ?? by.get('other') ?? entries[0][1];
}

// Sustituye cada grupo de bloques de idioma seguidos por el texto elegido y
// deja intacto lo que hay alrededor.
function replaceLangGroups(s, re, pref) {
  const matches = [...s.matchAll(re)];
  if (!matches.length) return s;
  let out = '';
  let pos = 0;
  let group = [];
  let start = 0;
  let end = 0;
  const flush = () => {
    if (!group.length) return;
    out += s.slice(pos, start) + chooseLang(group, pref);
    pos = end;
    group = [];
  };
  for (const m of matches) {
    const entries = m[1].split(',').filter(Boolean).map((l) => [langKey(l), m[2]]);
    if (group.length && /^\s*$/.test(s.slice(end, m.index))) {
      group.push(...entries);
    } else {
      flush();
      group = entries;
      start = m.index;
    }
    end = m.index + m[0].length;
  }
  flush();
  return out + s.slice(pos);
}

// Elige un idioma en textos multilingües de Moodle: <span lang="ca"
// class="multilang"> y {mlang ca}...{mlang}. Prefiere pref, luego es y ca.
export function pickLang(s, pref = 'es') {
  const p = langKey(pref || 'es');
  return replaceLangGroups(replaceLangGroups(String(s ?? ''), SPAN_ML, p), MLANG, p);
}

// Las etiquetas en línea desaparecen sin dejar espacio ("Matem<b>à</b>tiques");
// el resto se cambian por un espacio.
const INLINE_TAG = /<\/?(?:a|abbr|b|bdi|bdo|code|del|em|font|i|ins|mark|q|s|small|span|strong|sub|sup|u)\b[^>]*>/gi;
// El contenido de <script> y <style> nunca es texto para la persona.
const CODE_BLOCK = /<(script|style)\b[\s\S]*?<\/\1\s*>/gi;

// Texto plano de una sola línea a partir de un nombre de Moodle.
export const textOf = (s, max, pref = 'es') =>
  decodeEntities(
    pickLang(String(s ?? ''), pref)
      .replace(CODE_BLOCK, ' ')
      .replace(INLINE_TAG, '')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(BIDI, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// Texto plano con saltos de línea a partir de HTML (descripción de la actividad).
// Se muestra siempre como textContent.
export function plainText(html, max = 600, pref = 'es') {
  return decodeEntities(
    pickLang(String(html ?? ''), pref)
      .replace(CODE_BLOCK, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
      .replace(INLINE_TAG, '')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(BIDI, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, max)
    .trim();
}

const KINDS = new Set(['assign', 'quiz', 'forum', 'workshop', 'lesson', 'scorm', 'choice', 'feedback', 'data', 'glossary', 'h5pactivity', 'lti', 'wiki']);

// Convierte un evento de la línea de tiempo en una tarea, o null si el evento
// no sirve (sin id o con una fecha imposible).
export function eventToTask(ev, siteUrl, pref = 'es') {
  if (!ev || typeof ev !== 'object' || ev.id === undefined || ev.id === null || String(ev.id) === '') return null;
  const due = Number(ev.timesort ?? ev.timestart) * 1000;
  if (!Number.isFinite(due) || due <= 0 || due > MAX_DUE) return null;
  const course = ev.course && typeof ev.course === 'object' ? ev.course : {};
  const kind = KINDS.has(ev.modulename) ? ev.modulename : 'other';
  const action = ev.action && typeof ev.action === 'object' ? ev.action : null;
  const actionable = !(action && action.actionable === false);
  return {
    id: 'ev' + String(ev.id).slice(0, 40),
    title: textOf(ev.activityname || ev.name, 300, pref) || 'Actividad sin nombre',
    kind,
    kindLabel: textOf(ev.activitystr, 120, pref),
    courseId: Number(course.id) || 0,
    courseName: textOf(course.fullname || course.fullnamedisplay, 200, pref) || 'Sin asignatura',
    courseShort: textOf(course.shortname, 60, pref),
    due,
    overdue: Boolean(ev.overdue),
    url: safeMoodleLink(actionable ? (action && action.url) || ev.url : ev.url, siteUrl),
    actionName: action && action.name ? textOf(action.name, 80, pref) : '',
    actionable,
    cmid: Number(ev.instance) || 0,
    instance: Number(ev.instance) || 0,
    eventtype: String(ev.eventtype || '').slice(0, 40),
    description: plainText(ev.description, 600, pref),
    source: 'moodle',
  };
}
