// Cliente mínimo de los servicios web REST de Moodle.
//
// Usa el mismo servicio que la app oficial de Moodle (moodle_mobile_app), que
// la mayoría de centros tienen activado. El token viaja siempre en el cuerpo
// del POST, nunca en la URL, para que no acabe en registros ni historiales.

const SERVICE = 'moodle_mobile_app';
const PAGE = 50;
const MAX_PAGES = 12;

export class MoodleError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'unknown';
  }
}

const FRIENDLY = {
  invalidlogin: 'Usuario o contraseña incorrectos.',
  invalidtoken: 'La sesión con Moodle ha caducado. Vuelve a conectar tu cuenta.',
  accessexception: 'Moodle ha rechazado el acceso con este token.',
  enablewsdescription: 'Tu Moodle no tiene activados los servicios web. Pide a tu centro que activen la app móvil o usa un token.',
  servicenotavailable: 'El servicio de la app móvil no está disponible en este Moodle.',
  usernotallowed: 'Tu usuario no tiene permiso para usar el servicio de la app móvil.',
  sitemaintenance: 'Moodle está en mantenimiento. Prueba más tarde.',
  forcepasswordchangenotice: 'Moodle te pide cambiar la contraseña. Entra en la web, cámbiala y vuelve.',
  restoredaccountresetpassword: 'Tienes que restablecer la contraseña desde la web de Moodle.',
};

export function normalizeSiteUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new MoodleError('Escribe la dirección de tu Moodle.', 'nourl');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MoodleError('Esa dirección no parece válida.', 'badurl');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new MoodleError('Por seguridad solo se admiten direcciones https://.', 'insecure');
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

export class MoodleClient {
  constructor({ siteUrl, token = null, transport = 'auto', fetchImpl = globalThis.fetch.bind(globalThis) }) {
    this.siteUrl = normalizeSiteUrl(siteUrl);
    this.token = token;
    this.transport = transport; // 'auto' | 'direct' | 'proxy'
    this.fetch = fetchImpl;
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
      });
    const proxy = () =>
      this.fetch('/api/proxy', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ site: this.siteUrl, path, body: body.toString() }),
      });

    let res;
    try {
      res = this.transport === 'proxy' ? await proxy() : await direct();
    } catch (err) {
      if (this.transport === 'auto') {
        try {
          res = await proxy();
          if (res.status === 404 || res.status === 403) throw new Error('proxy-off');
          this.transport = 'proxy';
        } catch {
          throw new MoodleError(
            'No se ha podido contactar con Moodle desde el navegador. Comprueba la dirección o arranca el servidor incluido con MOODLE_ALLOWED_HOSTS.',
            'network'
          );
        }
      } else {
        throw new MoodleError('No se ha podido contactar con Moodle. Revisa tu conexión.', 'network');
      }
    }
    if (!res.ok) throw new MoodleError(`Moodle ha respondido con un error (${res.status}).`, 'http' + res.status);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new MoodleError('La respuesta de Moodle no es válida. ¿Es correcta la dirección?', 'badjson');
    }
    if (data && typeof data === 'object' && !Array.isArray(data) && (data.exception || data.errorcode || data.error)) {
      const code = data.errorcode || 'moodle';
      throw new MoodleError(FRIENDLY[code] || data.message || data.error || 'Moodle ha devuelto un error.', code);
    }
    return data;
  }

  async login(username, password) {
    const data = await this.post('login/token.php', { username, password, service: SERVICE });
    if (!data || typeof data.token !== 'string' || !/^[a-f0-9]{32}$/i.test(data.token)) {
      throw new MoodleError('Moodle no ha devuelto un token válido.', 'notoken');
    }
    this.token = data.token;
    return data.token;
  }

  call(wsfunction, params = {}) {
    if (!this.token) throw new MoodleError('Falta el token de Moodle.', 'notoken');
    return this.post('webservice/rest/server.php', {
      wstoken: this.token,
      wsfunction,
      moodlewsrestformat: 'json',
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
  async actionEvents({ fromSeconds }) {
    const all = [];
    let after = undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.call('core_calendar_get_action_events_by_timesort', {
        timesortfrom: fromSeconds,
        limitnum: PAGE,
        limittononsuspendedevents: 1,
        ...(after ? { aftereventid: after } : {}),
      });
      const events = (res && res.events) || [];
      all.push(...events);
      if (events.length < PAGE) break;
      after = events[events.length - 1].id;
    }
    return all;
  }
}

// Moodle devuelve los nombres ya pasados por format_string (p. ej. "R&amp;D").
// Los decodificamos como texto plano, sin pasar nunca por el parser HTML.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const clean = (s, max) => decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, max);

const KINDS = new Set(['assign', 'quiz', 'forum', 'workshop', 'lesson', 'scorm', 'choice', 'feedback', 'data', 'glossary', 'h5pactivity', 'lti', 'wiki']);

export function eventToTask(ev, siteUrl) {
  const course = ev.course || {};
  const kind = KINDS.has(ev.modulename) ? ev.modulename : 'other';
  const action = ev.action || null;
  return {
    id: 'ev' + ev.id,
    title: clean(ev.activityname || ev.name || 'Actividad sin nombre', 300),
    kind,
    kindLabel: clean(ev.activitystr, 120),
    courseId: Number(course.id) || 0,
    courseName: clean(course.fullname || course.fullnamedisplay || 'Sin asignatura', 200),
    courseShort: clean(course.shortname, 60),
    due: Number(ev.timesort || ev.timestart || 0) * 1000,
    overdue: Boolean(ev.overdue),
    url: safeMoodleLink((action && action.url) || ev.url, siteUrl),
    actionName: action && action.name ? String(action.name).slice(0, 80) : '',
    source: 'moodle',
  };
}
