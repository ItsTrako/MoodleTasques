import { Vault, passphraseStrength, MIN_PASSPHRASE } from './crypto.js';
import { MoodleClient, MoodleError, eventToTask, decodeEntities } from './moodle.js';
import * as T from './store.js';
import { demoData } from './demo.js';
import { buildIcs } from './ics.js';
import { h, icon, mount, clear, $ } from './dom.js';

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

function safeStorage() {
  try {
    const k = '__mt_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
}

const storage = safeStorage();
const vault = new Vault(storage);
const root = $('#app');
const MIN = 60_000;

const S = {
  screen: null,
  data: null,
  demo: false,
  ui: { view: 'pending', course: null, query: '' },
  syncing: false,
  error: null,
  animate: true,
  lastActivity: Date.now(),
  timers: [],
  refs: {},
};

const KIND = {
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
const kindOf = (k) => KIND[k] || KIND.other;
const courseColor = (id) => `oklch(var(--course-l) var(--course-c) ${T.courseHue(id)})`;
const plural = (n, one, many) => (n === 1 ? one : many);

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

function getTheme() {
  try {
    return storage.getItem('mt.theme') || 'auto';
  } catch {
    return 'auto';
  }
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    storage.setItem('mt.theme', t);
  } catch {
    /* sin almacenamiento: solo esta sesión */
  }
}
applyTheme(getTheme());

// ---------------------------------------------------------------------------
// Utilidades de interfaz
// ---------------------------------------------------------------------------

function toast(message, { action, timeout = 5200 } = {}) {
  const host = $('#toasts');
  const close = () => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  };
  const el = h(
    'div',
    { class: 'toast' },
    h('span', { class: 'grow', text: message }),
    action ? h('button', { type: 'button', text: action.label, onclick: () => { action.fn(); close(); } }) : null
  );
  host.append(el);
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(close, timeout);
}

function passwordField({ id, label, autocomplete, hint, minlength }) {
  const input = h('input', { class: 'input', id, name: id, type: 'password', autocomplete, required: true, minlength, spellcheck: 'false', autocapitalize: 'off' });
  const btn = h('button', { type: 'button', class: 'btn btn-icon reveal', 'aria-label': 'Mostrar', 'aria-controls': id }, icon('eye'));
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Ocultar' : 'Mostrar');
    mount(btn, icon(show ? 'eye-slash' : 'eye'));
  });
  const field = h(
    'div',
    { class: 'field' },
    h('label', { for: id, text: label }),
    h('div', { class: 'input-wrap' }, input, btn),
    hint ? h('p', { class: 'hint', id: id + '-hint', text: hint }) : null
  );
  if (hint) input.setAttribute('aria-describedby', id + '-hint');
  return { field, input };
}

function textField({ id, label, type = 'text', autocomplete, placeholder, hint, inputmode }) {
  const input = h('input', { class: 'input', id, name: id, type, autocomplete, placeholder, inputmode, required: true, spellcheck: 'false', autocapitalize: 'off' });
  const field = h(
    'div',
    { class: 'field' },
    h('label', { for: id, text: label }),
    input,
    hint ? h('p', { class: 'hint', id: id + '-hint', text: hint }) : null
  );
  if (hint) input.setAttribute('aria-describedby', id + '-hint');
  return { field, input };
}

function errorBox(slot, err) {
  if (!err) return clear(slot);
  mount(slot, h('div', { class: 'alert alert-error', role: 'alert' }, icon('warning'), h('div', { class: 'alert-body', text: err.message || String(err) })));
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    mount(btn, icon('arrows-clockwise', 'icon spin'), label);
  } else if (btn.dataset.label) {
    mount(btn, btn.dataset.label);
  }
}

function openDialog(build) {
  const dlg = h('dialog', { 'aria-modal': 'true' });
  const close = () => dlg.close();
  dlg.append(build(close));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function confirmDialog({ title, body, confirm, danger }) {
  return new Promise((resolve) => {
    let answered = false;
    const dlg = openDialog((close) =>
      h(
        'div',
        { class: 'dlg' },
        h('div', { class: 'dlg-head' }, h('h2', { text: title })),
        h('p', { text: body }),
        h(
          'div',
          { class: 'dlg-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancelar', onclick: close }),
          h('button', {
            type: 'button',
            class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
            text: confirm,
            onclick: () => {
              answered = true;
              resolve(true);
              close();
            },
          })
        )
      )
    );
    dlg.addEventListener('close', () => !answered && resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Pantalla de bienvenida y conexión
// ---------------------------------------------------------------------------

function storyPanel() {
  return h(
    'section',
    { class: 'gate-story' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('check')), 'Tasques'),
    h(
      'div',
      {},
      h('h1', { text: 'Todo lo que te queda en Moodle, en una lista.' }),
      h('p', { class: 'lede', text: 'Entregas, cuestionarios y foros de todas tus asignaturas, ordenados por fecha límite.' })
    ),
    h(
      'ul',
      { class: 'promises' },
      h('li', {}, icon('shield-check'), h('div', {}, h('strong', { text: 'Cifrado en tu dispositivo' }), h('span', { text: 'AES-256-GCM con una clave que solo sale de tu frase de acceso.' }))),
      h('li', {}, icon('key'), h('div', {}, h('strong', { text: 'Tu contraseña no se guarda' }), h('span', { text: 'Se usa una vez para pedir un token a tu Moodle y se descarta.' }))),
      h('li', {}, icon('lock-simple'), h('div', {}, h('strong', { text: 'Sin intermediarios' }), h('span', { text: 'El navegador habla directamente con tu Moodle. Nada pasa por servidores ajenos.' })))
    )
  );
}

function renderOnboard() {
  S.screen = 'onboard';
  stopTimers();
  let mode = 'password';
  let pending = null; // { client, info } tras el paso 1

  const card = h('div', { class: 'gate-card' });
  mount(root, h('div', { class: 'gate' }, storyPanel(), h('main', { class: 'gate-form', id: 'main' }, card)));

  const stepOne = () => {
    const site = textField({ id: 'site', label: 'Dirección de tu Moodle', type: 'url', autocomplete: 'url', placeholder: 'campus.tuinstituto.cat', inputmode: 'url', hint: 'La que ves en el navegador al entrar en Moodle.' });
    const user = textField({ id: 'username', label: 'Usuario', autocomplete: 'username' });
    const pass = passwordField({ id: 'password', label: 'Contraseña', autocomplete: 'current-password' });
    const token = textField({ id: 'wstoken', label: 'Token de la app móvil', autocomplete: 'off', hint: 'En Moodle: Preferencias, Claves de seguridad, servicio «Moodle mobile web service».' });
    const errSlot = h('div');
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Continuar' });
    const creds = h('div', { class: 'form' });
    const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Forma de acceso' });

    const drawMode = () => {
      mount(
        tabs,
        ...[
          ['password', 'Usuario y contraseña'],
          ['token', 'Tengo un token'],
        ].map(([id, label]) =>
          h('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': String(mode === id),
            text: label,
            onclick: () => {
              mode = id;
              drawMode();
            },
          })
        )
      );
      user.input.required = pass.input.required = mode === 'password';
      token.input.required = mode === 'token';
      mount(creds, ...(mode === 'password' ? [user.field, pass.field] : [token.field]));
    };
    drawMode();

    const form = h('form', { class: 'form', novalidate: true }, tabs, site.field, creds, errSlot, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox(errSlot, null);
      busy(submit, true, 'Conectando con Moodle…');
      try {
        const client = new MoodleClient({ siteUrl: site.input.value });
        if (mode === 'password') {
          if (!user.input.value.trim() || !pass.input.value) throw new MoodleError('Escribe tu usuario y tu contraseña.', 'empty');
          await client.login(user.input.value.trim(), pass.input.value);
        } else {
          const tk = token.input.value.trim();
          if (!/^[a-f0-9]{32}$/i.test(tk)) throw new MoodleError('El token tiene 32 caracteres hexadecimales (0-9, a-f).', 'badtoken');
          client.token = tk;
        }
        pass.input.value = '';
        token.input.value = '';
        const info = await client.siteInfo();
        if (!info || !Number(info.userid)) throw new MoodleError('Moodle no ha devuelto los datos de tu cuenta.', 'noinfo');
        pending = { client, info };
        stepTwo();
      } catch (err) {
        busy(submit, false);
        errorBox(errSlot, err);
        (err.code === 'invalidlogin' ? pass.input : site.input).focus();
      }
    });

    mount(
      card,
      h(
        'header',
        {},
        h('div', { class: 'steps' }, h('span', { 'aria-current': 'step', text: 'Paso 1 de 2' })),
        h('h2', { text: 'Conecta tu Moodle' }),
        h('p', { text: 'Usaremos el mismo acceso que la app oficial de Moodle.' })
      ),
      form,
      h(
        'div',
        { class: 'gate-foot' },
        h('span', { text: '¿Solo quieres verla?' }),
        h('button', { type: 'button', class: 'link', text: 'Probar con datos de ejemplo', onclick: enterDemo })
      )
    );
    site.input.focus();
  };

  const stepTwo = () => {
    const p1 = passwordField({ id: 'pp1', label: 'Frase de acceso', autocomplete: 'new-password', minlength: MIN_PASSPHRASE, hint: `Mínimo ${MIN_PASSPHRASE} caracteres. Mejor varias palabras: «cafè lent sota la pluja».` });
    const p2 = passwordField({ id: 'pp2', label: 'Repítela', autocomplete: 'new-password' });
    const meter = h('div', { class: 'meter', 'data-level': '0', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'));
    const strength = h('span', { class: 'hint', 'aria-live': 'polite' });
    p1.field.append(meter, strength);
    p1.input.addEventListener('input', () => {
      const s = passphraseStrength(p1.input.value);
      meter.dataset.level = String(s.level);
      strength.textContent = p1.input.value ? `Seguridad: ${s.label.toLowerCase()}` : '';
    });
    const errSlot = h('div');
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Cifrar y ver mis tareas' });
    const form = h('form', { class: 'form', novalidate: true }, p1.field, p2.field, errSlot, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox(errSlot, null);
      const a = p1.input.value;
      if (a.length < MIN_PASSPHRASE) return errorBox(errSlot, new Error(`La frase necesita al menos ${MIN_PASSPHRASE} caracteres.`));
      if (passphraseStrength(a).level < 2) return errorBox(errSlot, new Error('Es demasiado fácil de adivinar. Añade otra palabra o algún número.'));
      if (a !== p2.input.value) return errorBox(errSlot, new Error('Las dos frases no coinciden.'));
      busy(submit, true, 'Generando la clave…');
      try {
        const data = newData(pending.client, pending.info);
        await vault.create(a, data);
        p1.input.value = p2.input.value = '';
        pending = null;
        S.data = data;
        S.demo = false;
        enterApp({ firstSync: true });
      } catch (err) {
        busy(submit, false);
        errorBox(errSlot, err);
      }
    });
    const name = decodeEntities(pending.info.firstname || String(pending.info.fullname || '').split(' ')[0]);
    mount(
      card,
      h(
        'header',
        {},
        h('div', { class: 'steps' }, h('span', { 'aria-current': 'step', text: 'Paso 2 de 2' })),
        h('h2', { text: name ? `Hola, ${name}. Protege tus datos` : 'Protege tus datos' }),
        h('p', { text: 'Con esta frase se cifran el token y tus tareas en este navegador. No se envía a ningún sitio y no se puede recuperar.' })
      ),
      form
    );
    p1.input.focus();
  };

  stepOne();
}

function newData(client, info) {
  return {
    v: 1,
    site: {
      url: client.siteUrl,
      name: decodeEntities(info.sitename || 'Moodle').slice(0, 120),
      userName: decodeEntities(info.fullname).slice(0, 120),
      firstName: decodeEntities(info.firstname).slice(0, 60),
      userId: Number(info.userid),
    },
    token: client.token,
    tasks: [],
    courses: [],
    done: {},
    history: [],
    lastSync: 0,
    prefs: { lockMinutes: 10, overdueDays: 60, transport: client.transport === 'proxy' ? 'proxy' : 'auto' },
  };
}

function enterDemo() {
  const d = demoData();
  S.demo = true;
  S.data = { v: 1, site: { ...d.site, firstName: 'Laia' }, token: null, tasks: d.tasks, courses: slimCourses(d.courses), done: {}, history: d.history, lastSync: Date.now(), prefs: { lockMinutes: 0, overdueDays: 60, transport: 'auto' } };
  enterApp({});
}

// ---------------------------------------------------------------------------
// Bloqueo
// ---------------------------------------------------------------------------

function failState() {
  try {
    return JSON.parse(storage.getItem('mt.fail')) || { n: 0, until: 0 };
  } catch {
    return { n: 0, until: 0 };
  }
}

function renderLock(reason) {
  S.screen = 'lock';
  stopTimers();
  const pp = passwordField({ id: 'unlock', label: 'Frase de acceso', autocomplete: 'current-password' });
  const errSlot = h('div');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Desbloquear' });
  const form = h('form', { class: 'form', novalidate: true }, pp.field, errSlot, submit);

  let wait = null;
  const throttle = () => {
    const f = failState();
    const left = Math.ceil((f.until - Date.now()) / 1000);
    if (left > 0) {
      submit.disabled = true;
      submit.textContent = `Espera ${left} s`;
      wait = setTimeout(throttle, 1000);
    } else {
      submit.disabled = false;
      submit.textContent = 'Desbloquear';
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    errorBox(errSlot, null);
    busy(submit, true, 'Descifrando…');
    try {
      const data = await vault.unlock(pp.input.value);
      pp.input.value = '';
      storage.removeItem('mt.fail');
      clearTimeout(wait);
      S.data = migrate(data);
      S.demo = false;
      enterApp({});
    } catch (err) {
      const f = failState();
      f.n += 1;
      if (f.n >= 3) f.until = Date.now() + Math.min(60, 2 ** (f.n - 2)) * 1000;
      storage.setItem('mt.fail', JSON.stringify(f));
      busy(submit, false);
      errorBox(errSlot, err);
      pp.input.select();
      throttle();
    }
  });

  mount(
    root,
    h(
      'main',
      { class: 'lock', id: 'main' },
      h(
        'div',
        { class: 'lock-card' },
        h('span', { class: 'lock-badge' }, icon('lock-simple', 'icon-lg')),
        h('div', { style: { display: 'grid', gap: '8px' } }, h('h1', { text: 'Tus tareas están cifradas' }), h('p', { text: reason || 'Escribe tu frase de acceso para descifrarlas en este navegador.' })),
        form,
        h(
          'p',
          { class: 'lock-foot' },
          '¿No la recuerdas? ',
          h('button', {
            type: 'button',
            class: 'link',
            text: 'Borrar los datos y conectar de nuevo',
            onclick: async () => {
              const ok = await confirmDialog({
                title: '¿Borrar los datos de este navegador?',
                body: 'Sin la frase no hay forma de descifrarlos. Se borrarán el token y la caché de tareas; tu Moodle no se toca.',
                confirm: 'Borrar y empezar',
                danger: true,
              });
              if (ok) {
                wipe();
                renderOnboard();
              }
            },
          })
        )
      )
    )
  );
  throttle();
  pp.input.focus();
}

function migrate(d) {
  d.prefs = { lockMinutes: 10, overdueDays: 60, transport: 'auto', ...(d.prefs || {}) };
  d.done = d.done || {};
  d.history = d.history || [];
  d.tasks = d.tasks || [];
  d.courses = d.courses || [];
  return d;
}

function lock(reason) {
  document.querySelectorAll('dialog').forEach((d) => d.close());
  if (S.demo) {
    S.demo = false;
    S.data = null;
    return boot();
  }
  vault.lock();
  S.data = null;
  S.error = null;
  renderLock(reason);
}

function wipe() {
  vault.destroy();
  storage.removeItem('mt.fail');
  S.data = null;
}

// ---------------------------------------------------------------------------
// Aplicación
// ---------------------------------------------------------------------------

function enterApp({ firstSync }) {
  S.screen = 'app';
  S.ui = { view: 'pending', course: null, query: '' };
  S.error = null;
  S.animate = true;
  S.lastActivity = Date.now();
  renderShell();
  renderDynamic();
  scrollTo(0, 0);
  startTimers();
  if (!S.demo && (firstSync || Date.now() - S.data.lastSync > 10 * MIN)) sync();
}

async function persist() {
  if (S.demo || !vault.unlocked || !S.data) return;
  try {
    await vault.save(S.data);
  } catch (err) {
    toast('No se han podido guardar los cambios: ' + err.message);
  }
}

function renderShell() {
  const r = (S.refs = {});
  const d = S.data;

  r.syncMeta = h('span', { class: 'sync-meta', 'aria-live': 'polite' });
  r.syncBtn = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => sync() });
  r.themeBtn = h('button', { type: 'button', class: 'btn btn-icon', onclick: cycleTheme });
  drawThemeBtn();

  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'left' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('check')), h('span', { text: 'Tasques' })), h('span', { class: 'site-name', text: d.site.name })),
    h(
      'div',
      { class: 'right' },
      r.syncMeta,
      r.syncBtn,
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Exportar al calendario (.ics)', title: 'Exportar al calendario (.ics)', onclick: exportIcs }, icon('download-simple')),
      r.themeBtn,
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Ajustes', title: 'Ajustes', onclick: openSettings }, icon('gear-six')),
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': S.demo ? 'Salir de la demostración' : 'Bloquear', title: S.demo ? 'Salir de la demostración' : 'Bloquear', onclick: () => lock() }, icon(S.demo ? 'sign-out' : 'lock-simple'))
    )
  );

  const demoBar = S.demo
    ? h('div', { class: 'demo-bar' }, h('span', { text: 'Estás viendo datos de ejemplo. No se guarda nada.' }), h('button', { type: 'button', class: 'link', text: 'Conectar mi Moodle', onclick: () => lock() }))
    : null;

  r.headline = h('div', { class: 'headline' });
  r.next = h('aside', { class: 'next', 'aria-label': 'Próxima entrega' });
  r.horizon = h('section', { class: 'horizon', 'aria-labelledby': 'hz-title' });
  r.side = h('nav', { class: 'side', 'aria-label': 'Filtros' });
  r.chips = h('div', { class: 'mobile-filters', role: 'toolbar', 'aria-label': 'Vista' });
  r.courseSelect = h('select', { class: 'select', 'aria-label': 'Asignatura' });
  r.courseSelect.addEventListener('change', () => {
    S.ui.course = r.courseSelect.value === '' ? null : Number(r.courseSelect.value);
    S.animate = true;
    renderDynamic();
  });
  r.search = h('input', { class: 'input', type: 'search', placeholder: 'Buscar', 'aria-label': 'Buscar', autocomplete: 'off', spellcheck: 'false' });
  r.search.addEventListener('input', () => {
    S.ui.query = r.search.value;
    renderList();
  });
  r.banner = h('div');
  r.list = h('div', { class: 'list', 'aria-live': 'polite' });

  mount(
    root,
    topbar,
    demoBar,
    h(
      'main',
      { class: 'shell', id: 'main' },
      h('section', { class: 'overview' }, r.headline, r.next),
      r.horizon,
      h(
        'div',
        { class: 'workspace' },
        r.side,
        h(
          'section',
          { 'aria-label': 'Tareas' },
          r.chips,
          h('div', { class: 'list-tools' }, h('div', { class: 'input-wrap input-icon' }, icon('magnifying-glass'), r.search), r.courseSelect),
          r.banner,
          r.list
        )
      )
    )
  );
}

function drawThemeBtn() {
  const t = getTheme();
  const label = { auto: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: oscuro' }[t];
  const btn = S.refs.themeBtn;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  mount(btn, icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'circle-half'));
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  applyTheme(order[(order.indexOf(getTheme()) + 1) % order.length]);
  drawThemeBtn();
}

function setView(view, course = S.ui.course) {
  S.ui.view = view;
  S.ui.course = course;
  S.animate = true;
  renderDynamic();
}

function renderDynamic() {
  if (S.screen !== 'app' || !S.data) return;
  const now = Date.now();
  const d = S.data;
  const sum = T.summarize(d.tasks, d.done, now);
  const r = S.refs;

  // Estado de sincronización
  mount(r.syncBtn, icon('arrows-clockwise', S.syncing ? 'icon spin' : 'icon'), h('span', { class: 'sync-label', text: S.syncing ? 'Sincronizando' : 'Sincronizar' }));
  r.syncBtn.disabled = S.syncing;
  r.syncBtn.setAttribute('aria-label', S.syncing ? 'Sincronizando con Moodle' : 'Sincronizar con Moodle');
  r.syncMeta.textContent = S.demo ? '' : d.lastSync ? `Actualizado ${T.relative(d.lastSync, now)}` : 'Sin sincronizar';

  // Titular
  const first = d.site.firstName || d.site.userName.split(' ')[0];
  const h1 =
    sum.pending === 0
      ? h('h1', { text: 'No te queda nada pendiente.' })
      : h('h1', {}, plural(sum.pending, 'Te queda ', 'Te quedan '), h('span', { class: 'num', text: String(sum.pending) }), plural(sum.pending, ' tarea', ' tareas'));
  const tallies = h('div', { class: 'tallies' });
  if (sum.overdue) tallies.append(h('button', { type: 'button', class: 'tally tally-danger', onclick: () => setView('overdue') }, icon('warning', 'icon-sm'), h('span', { class: 'num', text: String(sum.overdue) }), plural(sum.overdue, 'atrasada', 'atrasadas')));
  if (sum.today) tallies.append(h('span', { class: 'tally tally-warn' }, icon('hourglass-medium', 'icon-sm'), h('span', { class: 'num', text: String(sum.today) }), 'para hoy'));
  if (sum.thisWeek) tallies.append(h('button', { type: 'button', class: 'tally', onclick: () => setView('week') }, h('span', { class: 'num', text: String(sum.thisWeek) }), 'en 7 días'));
  const doneCount = Object.keys(d.done).length + d.history.length;
  if (doneCount) tallies.append(h('button', { type: 'button', class: 'tally', onclick: () => setView('done') }, icon('check-circle', 'icon-sm'), h('span', { class: 'num', text: String(doneCount) }), plural(doneCount, 'hecha', 'hechas')));
  mount(r.headline, first ? h('p', { class: 'greet', text: `Hola, ${first}.` }) : null, h1, tallies);

  // Próxima entrega
  renderNext(sum.next, now);

  // Franja
  renderHorizon(T.pendingTasks(d.tasks, d.done), now);

  // Navegación
  renderNav(sum, doneCount);

  // Lista
  renderBanner();
  renderList();
  S.animate = false;
}

function renderNext(t, now) {
  const el = S.refs.next;
  if (!t) {
    el.style.setProperty('--course', 'var(--ok)');
    return mount(el, h('div', { class: 'next-empty' }, icon('check-circle', 'icon-lg'), h('p', { class: 'next-title', text: 'Nada a la vista' }), h('p', { text: 'No hay entregas futuras en tu línea de tiempo.' })));
  }
  const c = T.countdown(t.due, now);
  el.style.setProperty('--course', courseColor(t.courseId));
  const unit = (n, u, label) => h('div', { 'aria-hidden': 'true' }, h('b', { text: String(n).padStart(2, '0') }), h('span', { text: u, title: label }));
  const title = t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', text: t.title, style: { color: 'inherit', 'text-decoration': 'none' } }) : t.title;
  mount(
    el,
    h('p', { class: 'next-label' }, icon('clock', 'icon-sm'), 'Próxima entrega'),
    h(
      'div',
      { class: 'clock', role: 'timer', 'aria-label': `Faltan ${c.d} días, ${c.h} horas y ${c.m} minutos` },
      unit(c.d, 'd', 'días'),
      unit(c.h, 'h', 'horas'),
      unit(c.m, 'min', 'minutos')
    ),
    h(
      'div',
      { style: { display: 'grid', gap: '6px' } },
      h('p', { class: 'next-title' }, title),
      h('p', { class: 'next-meta' }, h('span', { class: 'course-tag' }, h('i', { class: 'swatch', style: { '--course': courseColor(t.courseId) } }), h('span', { text: t.courseShort || t.courseName })), h('time', { datetime: new Date(t.due).toISOString(), text: T.formatDue(t.due, now) }))
    )
  );
}

function renderHorizon(pending, now) {
  const days = T.horizon(pending, now, 14);
  const total = days.reduce((n, x) => n + x.tasks.length, 0);
  const weekday = new Intl.DateTimeFormat('es-ES', { weekday: 'narrow' });
  const longDay = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  let k = 0;
  mount(
    S.refs.horizon,
    h('div', { class: 'horizon-head' }, h('h2', { id: 'hz-title', text: 'Próximas dos semanas' }), h('p', { text: `${total} ${plural(total, 'entrega', 'entregas')} en 14 días` })),
    h(
      'ol',
      { class: 'days', style: { 'list-style': 'none', margin: '0', padding: '0' } },
      ...days.map((day, i) => {
        const dt = new Date(day.ts);
        const wd = dt.getDay();
        const n = day.tasks.length;
        const shown = day.tasks.slice(0, n > 5 ? 4 : 5);
        const label = `${longDay.format(day.ts)}: ${n ? `${n} ${plural(n, 'entrega', 'entregas')}` : 'sin entregas'}`;
        return h(
          'li',
          { class: 'day' + (i === 0 ? ' is-today' : '') + (wd === 0 || wd === 6 ? ' is-weekend' : ''), title: n ? `${label}\n${day.tasks.map((t) => '· ' + t.title).join('\n')}` : label },
          h('span', { class: 'sr', text: label }),
          h(
            'div',
            { class: 'day-bar', 'aria-hidden': 'true' },
            ...shown.map((t) => h('i', { style: { '--course': courseColor(t.courseId), '--d': String(S.animate ? k++ : 0) }, class: S.animate ? '' : 'still' })),
            n > shown.length ? h('span', { class: 'more', text: `+${n - shown.length}` }) : null
          ),
          h('span', { class: 'day-label', 'aria-hidden': 'true' }, i === 0 ? 'hoy' : weekday.format(day.ts), h('b', { text: String(dt.getDate()) }))
        );
      })
    )
  );
}

function renderNav(sum, doneCount) {
  const d = S.data;
  const r = S.refs;
  const views = [
    ['pending', 'Pendientes', sum.pending, 'list-checks'],
    ['overdue', 'Atrasadas', sum.overdue, 'warning'],
    ['week', 'Próximos 7 días', sum.thisWeek, 'calendar-blank'],
    ['done', 'Hechas', doneCount, 'check-circle'],
  ];
  const pending = T.pendingTasks(d.tasks, d.done);
  const courses = T.coursesFromTasks(pending, d.courses).filter((c) => c.count > 0 || c.progress !== null);

  const viewBtn = ([id, label, count, ic]) =>
    h('li', {}, h('button', { type: 'button', 'aria-pressed': String(S.ui.view === id), onclick: () => setView(id) }, icon(ic), h('span', { class: 'label', text: label }), h('span', { class: 'count', text: String(count) })));
  const courseBtn = (c) =>
    h(
      'li',
      {},
      h(
        'button',
        { type: 'button', class: 'course-btn', 'aria-pressed': String(S.ui.course === c.id), onclick: () => setView(S.ui.view, S.ui.course === c.id ? null : c.id), title: c.name },
        h('i', { class: 'swatch', style: { '--course': courseColor(c.id) } }),
        h('span', { class: 'stack' }, h('span', { class: 'label', text: c.name }), c.progress !== null ? h('span', { class: 'progress' }, h('span', { class: 'num', text: `${c.progress}%` }), ' completado') : null),
        h('span', { class: 'count', text: String(c.count) })
      )
    );

  mount(
    r.side,
    h('div', {}, h('h2', { text: 'Vista' }), h('ul', { class: 'nav' }, ...views.map(viewBtn))),
    courses.length
      ? h(
          'div',
          {},
          h('h2', { text: 'Asignaturas' }),
          h(
            'ul',
            { class: 'nav' },
            h('li', {}, h('button', { type: 'button', 'aria-pressed': String(S.ui.course === null), onclick: () => setView(S.ui.view, null) }, icon('books'), h('span', { class: 'label', text: 'Todas' }), h('span', { class: 'count', text: String(pending.length) }))),
            ...courses.map(courseBtn)
          )
        )
      : null
  );

  mount(
    r.chips,
    ...views.map(([id, label, count]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(S.ui.view === id), onclick: () => setView(id) }, label, h('span', { class: 'num', text: String(count) })))
  );

  const sig = courses.map((c) => c.id + ':' + c.count).join('|') + '#' + S.ui.course;
  if (r.courseSelect.dataset.sig !== sig) {
    r.courseSelect.dataset.sig = sig;
    mount(r.courseSelect, h('option', { value: '', text: 'Todas las asignaturas' }), ...courses.map((c) => h('option', { value: String(c.id), text: `${c.short || c.name} (${c.count})` })));
    r.courseSelect.value = S.ui.course === null ? '' : String(S.ui.course);
  }
}

function renderBanner() {
  const e = S.error;
  if (!e) return clear(S.refs.banner);
  const expired = e.code === 'invalidtoken' || e.code === 'accessexception';
  mount(
    S.refs.banner,
    h(
      'div',
      { class: 'alert alert-error', role: 'alert', style: { 'margin-top': '12px' } },
      icon('warning'),
      h(
        'div',
        { class: 'alert-body' },
        h('p', { text: e.message }),
        h('p', { style: { opacity: '.85', 'font-size': '13px' }, text: 'Mientras tanto ves la última copia guardada.' }),
        h(
          'div',
          { class: 'alert-actions' },
          expired
            ? h('button', { type: 'button', class: 'btn btn-outline', onclick: openReconnect }, icon('key', 'icon-sm'), 'Reconectar')
            : h('button', { type: 'button', class: 'btn btn-outline', onclick: () => sync() }, icon('arrow-counter-clockwise', 'icon-sm'), 'Reintentar')
        )
      )
    )
  );
}

function taskRow(t, now, i, { doneView = false, anim = false } = {}) {
  const bucket = doneView ? 'done' : T.bucketOf(t, now);
  const [kindLabel, kindIcon] = kindOf(t.kind);
  const fromMoodle = doneView && t.how === 'moodle';
  const isDone = doneView;
  const li = h('li', { class: 'row' + (anim ? ' anim' : '') + (isDone ? ' is-done' : ''), dataset: { bucket }, style: { '--i': String(i) } });

  const check = fromMoodle
    ? h('span', { class: 'check', 'aria-hidden': 'true', style: { background: 'var(--ok-soft)', 'border-color': 'transparent', color: 'var(--ok)' } }, icon('check', 'icon-sm'))
    : h('input', { type: 'checkbox', class: 'check', 'aria-label': isDone ? `Volver a marcar «${t.title}» como pendiente` : `Marcar «${t.title}» como hecha`, title: 'Solo en este dispositivo. No entrega nada en Moodle.' });
  if (!fromMoodle) {
    check.checked = isDone;
    check.addEventListener('change', () => toggleDone(t, check.checked, li));
  }

  const title = t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', text: t.title }) : t.title;
  const meta = h(
    'div',
    { class: 'row-meta' },
    h('span', { class: 'course-tag', title: t.courseName }, h('i', { class: 'swatch', style: { '--course': courseColor(t.courseId) } }), h('span', { text: t.courseShort || t.courseName })),
    h('span', { class: 'kind' }, icon(kindIcon, 'icon-sm'), t.kindLabel || kindLabel),
    fromMoodle ? h('span', { class: 'badge' }, 'Ya no está pendiente en Moodle') : null,
    doneView && !fromMoodle ? h('span', { class: 'badge badge-muted' }, 'Marcada a mano') : null
  );

  const due = doneView
    ? h('div', { class: 'row-due' }, h('time', { datetime: new Date(t.completedAt || t.due).toISOString(), text: T.formatDue(t.completedAt || t.due, now) }), h('span', { class: 'rel', text: t.completedAt ? 'completada' : 'fecha límite' }))
    : h('div', { class: 'row-due' }, h('time', { datetime: new Date(t.due).toISOString(), text: T.formatDue(t.due, now) }), h('span', { class: 'rel', text: T.relative(t.due, now) }));

  const open = t.url ? h('a', { class: 'btn btn-icon', href: t.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Abrir «${t.title}» en Moodle`, title: t.actionName ? `${t.actionName} en Moodle` : 'Abrir en Moodle' }, icon('arrow-square-out')) : null;

  li.append(check, h('div', { class: 'row-main' }, h('p', { class: 'row-title' }, title), meta), h('div', { class: 'row-end' }, due, open));
  return li;
}

function renderList() {
  const d = S.data;
  const r = S.refs;
  const now = Date.now();
  const anim = S.animate;
  const { view, course, query } = S.ui;

  if (S.syncing && !d.lastSync && !S.demo) {
    return mount(r.list, h('div', { class: 'skeleton', 'aria-label': 'Cargando tareas' }, ...Array.from({ length: 6 }, () => h('div', {}, h('i'), h('i', { style: { width: `${40 + Math.random() * 45}%` } }), h('i')))));
  }

  if (view === 'done') {
    const manual = d.tasks.filter((t) => d.done[t.id]).map((t) => ({ ...t, completedAt: d.done[t.id], how: 'manual' }));
    let items = [...manual, ...d.history].sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    items = T.filterTasks(items, { view: 'all', course, query }, now);
    if (!items.length) return mount(r.list, emptyState('Todavía no hay nada aquí', 'Cuando marques una tarea o la entregues en Moodle, aparecerá en esta lista.', 'check-circle'));
    return mount(r.list, h('div', { class: 'group' }, h('div', { class: 'group-head' }, h('h3', { text: 'Hechas' }), h('span', { class: 'num', text: String(items.length) }), h('span', { class: 'sub', text: 'Últimos 120 días' })), h('ul', { class: 'rows' }, ...items.map((t, i) => taskRow(t, now, i, { doneView: true, anim })))));
  }

  const items = T.filterTasks(d.tasks, { done: d.done, view, course, query }, now);
  if (!items.length) {
    if (query) return mount(r.list, emptyState('Sin resultados', `Nada coincide con «${query}».`, 'magnifying-glass'));
    if (view === 'overdue') return mount(r.list, emptyState('Nada atrasado', 'Vas al día. Sigue así.', 'check-circle'));
    if (!d.lastSync && !S.demo) return mount(r.list, emptyState('Aún no hay datos', 'Sincroniza para traer tus tareas de Moodle.', 'arrows-clockwise'));
    return mount(r.list, emptyState('No te queda nada pendiente', course !== null ? 'En esta asignatura no tienes entregas abiertas.' : 'Tu línea de tiempo de Moodle está vacía. Buen momento para descansar.', 'check-circle'));
  }
  let k = 0;
  const groups = T.groupByBucket(items, now);
  mount(
    r.list,
    ...groups.map((g) =>
      h(
        'section',
        { class: 'group', dataset: { bucket: g.id }, 'aria-label': g.label },
        h('div', { class: 'group-head' }, h('h3', { text: g.label }), h('span', { class: 'num', text: String(g.tasks.length) }), g.id === 'today' ? h('span', { class: 'sub', text: T.formatDay(now) }) : null),
        h('ul', { class: 'rows' }, ...g.tasks.map((t) => taskRow(t, now, k++, { anim })))
      )
    )
  );
}

function emptyState(title, body, ic) {
  return h('div', { class: 'empty' }, h('span', { class: 'lock-badge' }, icon(ic, 'icon-lg')), h('h3', { text: title }), h('p', { text: body }));
}

function toggleDone(t, done, li) {
  const d = S.data;
  const apply = () => {
    if (done) d.done[t.id] = Date.now();
    else delete d.done[t.id];
    persist();
    renderDynamic();
  };
  li.classList.add('is-leaving');
  setTimeout(apply, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280);
  if (done) {
    toast('Marcada como hecha en este dispositivo.', {
      action: {
        label: 'Deshacer',
        fn: () => {
          delete d.done[t.id];
          persist();
          renderDynamic();
        },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------

function slimCourses(list) {
  return (list || []).map((c) => ({ id: Number(c.id), fullname: decodeEntities(c.fullname || c.displayname).slice(0, 200), shortname: decodeEntities(c.shortname).slice(0, 60), progress: typeof c.progress === 'number' ? c.progress : null }));
}

async function sync() {
  if (S.syncing || !S.data) return;
  if (S.demo) {
    S.syncing = true;
    renderDynamic();
    await new Promise((r) => setTimeout(r, 700));
    S.syncing = false;
    S.animate = true;
    renderDynamic();
    toast('Los datos de ejemplo no cambian. Conecta tu Moodle para ver los tuyos.');
    return;
  }
  const d = S.data;
  S.syncing = true;
  S.error = null;
  renderDynamic();
  try {
    const client = new MoodleClient({ siteUrl: d.site.url, token: d.token, transport: d.prefs.transport });
    const fromMs = Date.now() - d.prefs.overdueDays * 86_400_000;
    const [events, courses] = await Promise.all([client.actionEvents({ fromSeconds: Math.floor(fromMs / 1000) }), client.courses(d.site.userId).catch(() => null)]);
    if (S.data !== d) return; // se bloqueó mientras tanto
    const fresh = events.map((e) => eventToTask(e, d.site.url)).filter((t) => t.due > 0);
    const merged = T.mergeSync(d.tasks.filter((t) => t.due >= fromMs), fresh, d.history, Date.now());
    d.tasks = merged.tasks;
    d.history = merged.history;
    if (courses) d.courses = slimCourses(courses);
    d.done = T.pruneDone(d.done, d.tasks);
    d.lastSync = Date.now();
    await persist();
    if (merged.newlyCompleted) {
      const n = merged.newlyCompleted;
      toast(`${n} ${plural(n, 'tarea ya no está pendiente', 'tareas ya no están pendientes')} en Moodle.`, { action: { label: 'Ver', fn: () => setView('done') } });
    }
  } catch (err) {
    S.error = err instanceof MoodleError ? err : new MoodleError('Algo ha fallado al sincronizar: ' + err.message);
  } finally {
    S.syncing = false;
    S.animate = true;
    renderDynamic();
  }
}

function openReconnect() {
  const d = S.data;
  openDialog((close) => {
    const user = textField({ id: 'rc-user', label: 'Usuario', autocomplete: 'username' });
    const pass = passwordField({ id: 'rc-pass', label: 'Contraseña', autocomplete: 'current-password' });
    const errSlot = h('div');
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Reconectar' });
    const form = h('form', { class: 'form', novalidate: true }, user.field, pass.field, errSlot, h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancelar', onclick: close }), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox(errSlot, null);
      busy(submit, true, 'Conectando…');
      try {
        const client = new MoodleClient({ siteUrl: d.site.url, transport: d.prefs.transport });
        await client.login(user.input.value.trim(), pass.input.value);
        pass.input.value = '';
        const info = await client.siteInfo();
        if (Number(info.userid) !== d.site.userId) throw new MoodleError('Esa cuenta no es la que tenías conectada. Borra los datos desde Ajustes para cambiar de usuario.', 'otheruser');
        d.token = client.token;
        await persist();
        close();
        S.error = null;
        sync();
      } catch (err) {
        busy(submit, false);
        errorBox(errSlot, err);
      }
    });
    setTimeout(() => user.input.focus(), 30);
    return h(
      'div',
      { class: 'dlg' },
      h('div', { class: 'dlg-head' }, h('h2', { text: 'Vuelve a conectar Moodle' }), h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Cerrar', onclick: close }, icon('x'))),
      h('p', { style: { color: 'var(--ink-2)' }, text: `El token de ${d.site.name} ha caducado. Tu contraseña solo se usa para pedir uno nuevo.` }),
      form
    );
  });
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

function selectRow(label, value, options, onChange) {
  const sel = h('select', { class: 'select', 'aria-label': label }, ...options.map(([v, l]) => h('option', { value: String(v), text: l })));
  sel.value = String(value);
  sel.addEventListener('change', () => onChange(sel.value));
  return h('div', { class: 'dlg-row' }, h('span', { class: 'label', text: label }), sel);
}

function openSettings() {
  const d = S.data;
  openDialog((close) => {
    const sections = [];
    sections.push(
      h(
        'div',
        { class: 'dlg-section' },
        h('h3', { text: 'Cuenta' }),
        h('p', { text: `${d.site.userName || 'Sin nombre'} en ${d.site.name}` }),
        h('p', { class: 'mono', style: { 'font-size': '12.5px', color: 'var(--ink-3)', 'overflow-wrap': 'anywhere' }, text: d.site.url })
      )
    );
    if (!S.demo) {
      sections.push(
        h(
          'div',
          { class: 'dlg-section' },
          h('h3', { text: 'Seguridad' }),
          selectRow('Bloquear tras', d.prefs.lockMinutes, [[5, '5 min sin uso'], [10, '10 min sin uso'], [30, '30 min sin uso'], [60, '1 h sin uso']], (v) => {
            d.prefs.lockMinutes = Number(v);
            persist();
          }),
          h('p', { text: 'Cifrado AES-256-GCM. Clave derivada con PBKDF2-SHA-256 y 600 000 iteraciones. La clave solo existe en memoria mientras la app está desbloqueada.' }),
          h('div', { class: 'dlg-actions', style: { 'justify-content': 'flex-start' } }, h('button', { type: 'button', class: 'btn btn-outline', onclick: () => { close(); openChangePassphrase(); } }, icon('key', 'icon-sm'), 'Cambiar frase de acceso'))
        ),
        h(
          'div',
          { class: 'dlg-section' },
          h('h3', { text: 'Sincronización' }),
          selectRow('Mostrar atrasadas de', d.prefs.overdueDays, [[14, 'las últimas 2 semanas'], [30, 'los últimos 30 días'], [60, 'los últimos 60 días'], [120, 'los últimos 120 días']], (v) => {
            d.prefs.overdueDays = Number(v);
            persist();
          }),
          selectRow('Conexión', d.prefs.transport, [['auto', 'Automática'], ['direct', 'Directa con Moodle'], ['proxy', 'A través del servidor']], (v) => {
            d.prefs.transport = v;
            persist();
          })
        )
      );
    }
    sections.push(
      h(
        'div',
        { class: 'dlg-section' },
        h('h3', { text: 'Datos' }),
        h('p', { text: 'Exporta tus pendientes a un calendario o borra todo lo guardado en este navegador.' }),
        h(
          'div',
          { class: 'dlg-actions', style: { 'justify-content': 'flex-start' } },
          h('button', { type: 'button', class: 'btn btn-outline', onclick: exportIcs }, icon('download-simple', 'icon-sm'), 'Exportar .ics'),
          S.demo
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-danger',
                  onclick: async () => {
                    const ok = await confirmDialog({ title: '¿Desconectar y borrar?', body: 'Se borran el token y todas las tareas guardadas en este navegador. En Moodle no cambia nada.', confirm: 'Borrar todo', danger: true });
                    if (ok) {
                      close();
                      wipe();
                      renderOnboard();
                      toast('Datos borrados de este navegador.');
                    }
                  },
                },
                icon('trash', 'icon-sm'),
                'Desconectar y borrar'
              )
        )
      )
    );
    return h('div', { class: 'dlg' }, h('div', { class: 'dlg-head' }, h('h2', { text: 'Ajustes' }), h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Cerrar', onclick: close }, icon('x'))), ...sections);
  });
}

function openChangePassphrase() {
  const d = S.data;
  openDialog((close) => {
    const cur = passwordField({ id: 'cp-cur', label: 'Frase actual', autocomplete: 'current-password' });
    const p1 = passwordField({ id: 'cp-new', label: 'Nueva frase', autocomplete: 'new-password', minlength: MIN_PASSPHRASE });
    const p2 = passwordField({ id: 'cp-rep', label: 'Repite la nueva', autocomplete: 'new-password' });
    const errSlot = h('div');
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Cambiar' });
    const form = h('form', { class: 'form', novalidate: true }, cur.field, p1.field, p2.field, errSlot, h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancelar', onclick: close }), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox(errSlot, null);
      const a = p1.input.value;
      if (a.length < MIN_PASSPHRASE || passphraseStrength(a).level < 2) return errorBox(errSlot, new Error(`Usa al menos ${MIN_PASSPHRASE} caracteres y algo difícil de adivinar.`));
      if (a !== p2.input.value) return errorBox(errSlot, new Error('Las dos frases nuevas no coinciden.'));
      busy(submit, true, 'Cifrando…');
      try {
        await new Vault(storage).unlock(cur.input.value);
        await vault.create(a, d);
        cur.input.value = p1.input.value = p2.input.value = '';
        close();
        toast('Frase de acceso cambiada. Los datos se han vuelto a cifrar con una clave nueva.');
      } catch (err) {
        busy(submit, false);
        errorBox(errSlot, err);
      }
    });
    setTimeout(() => cur.input.focus(), 30);
    return h('div', { class: 'dlg' }, h('div', { class: 'dlg-head' }, h('h2', { text: 'Cambiar frase de acceso' }), h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Cerrar', onclick: close }, icon('x'))), form);
  });
}

function exportIcs() {
  const d = S.data;
  const now = Date.now();
  const items = T.pendingTasks(d.tasks, d.done).filter((t) => t.due >= now);
  if (!items.length) return toast('No hay entregas futuras que exportar.');
  const blob = new Blob([buildIcs(items, now)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: 'tasques.ics' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`${items.length} ${plural(items.length, 'entrega exportada', 'entregas exportadas')}. Ábrelo con tu calendario.`);
}

// ---------------------------------------------------------------------------
// Temporizadores: reloj, autobloqueo y sincronización periódica
// ---------------------------------------------------------------------------

function touch() {
  S.lastActivity = Date.now();
}
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => addEventListener(ev, touch, { passive: true }));

function idleCheck() {
  if (S.screen !== 'app' || S.demo || !S.data) return;
  const limit = (S.data.prefs.lockMinutes || 10) * MIN;
  if (Date.now() - S.lastActivity > limit) lock('Se ha bloqueado por inactividad. Escribe tu frase para seguir.');
}

function startTimers() {
  stopTimers();
  S.timers.push(
    setInterval(() => {
      idleCheck();
      if (S.screen !== 'app') return;
      if (!document.hidden) renderDynamic();
      if (!S.demo && !document.hidden && !S.syncing && !S.error && Date.now() - S.data.lastSync > 15 * MIN) sync();
    }, 30_000)
  );
}

function stopTimers() {
  S.timers.forEach(clearInterval);
  S.timers = [];
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    idleCheck();
    if (S.screen === 'app') renderDynamic();
  }
});

// Otra pestaña ha borrado o cambiado la bóveda: no seguimos con datos viejos.
addEventListener('storage', (e) => {
  if (e.key === vault.storageKey && S.screen === 'app' && !S.demo) lock('Los datos han cambiado en otra pestaña. Vuelve a desbloquear.');
});

// ---------------------------------------------------------------------------

function boot() {
  if (!globalThis.crypto || !crypto.subtle) {
    return mount(root, h('main', { class: 'lock', id: 'main' }, h('div', { class: 'lock-card' }, h('h1', { text: 'Abre Tasques con HTTPS' }), h('p', { text: 'El cifrado del navegador (Web Crypto) solo funciona en páginas seguras: https:// o localhost.' }))));
  }
  if (vault.exists()) renderLock();
  else renderOnboard();
}

boot();
