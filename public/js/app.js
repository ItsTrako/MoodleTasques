import { Vault, passphraseStrength, MIN_PASSPHRASE } from './crypto.js';
import { MoodleClient, MoodleError, eventToTask, textOf, normalizeSiteUrl, tokenErrorMessage } from './moodle.js';
import * as T from './store.js';
import { demoData } from './demo.js';
import { buildIcs } from './ics.js';
import * as G from './details.js';
import { h, icon, mount, clear, $ } from './dom.js';

// ---------------------------------------------------------------------------
// Estado y utilidades
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

document.querySelector('.boot-hint')?.remove();
const storage = safeStorage();
const vault = new Vault(storage);
const root = $('#app');
const MIN = 60_000;
const DAY = 86_400_000;
const TOKEN_RE = /^[a-f0-9]{32}$/i;
const NO_RETRY = ['invalidtoken', 'accessexception', 'sitepolicynotagreed', 'usernotfullysetup', 'otheruser'];

let SITE_CFG = null;

const S = {
  screen: null,
  data: null,
  demo: false,
  ui: { view: 'pending', course: null, query: '', day: null },
  syncing: false,
  error: null,
  errorAt: 0,
  animate: true,
  lastActivity: Date.now(),
  timers: [],
  refs: {},
  sig: '',
  syncGen: 0,
  abort: null,
  focusNext: null,
  previewColors: {},
};

const VIEWS = [
  ['pending', 'Pendientes', 'tray'],
  ['overdue', 'Atrasadas', 'warning-circle'],
  ['today', 'Hoy', 'hourglass-medium'],
  ['week', 'Próximos 7 días', 'calendar-dots'],
  ['done', 'Hechas', 'check-circle'],
  ['grades', 'Notas', 'chart-bar'],
];
const VIEW_LABEL = Object.fromEntries(VIEWS.map(([id, l]) => [id, l]));

const plural = (n, one, many) => (n === 1 ? one : many);
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = () => matchMedia('(pointer: coarse)').matches;
const isMobile = () => matchMedia('(max-width: 720px)').matches;
let uidN = 0;
const uid = (p) => `${p}-${++uidN}`;
const firstName = (site) => (site.firstName || String(site.userName || '').split(' ')[0] || '').trim();
const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
const contentLang = () => {
  const l = S.data?.site?.lang;
  return l === 'ca' ? 'ca' : null;
};

function announce(msg) {
  const el = $('#sr-status');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = msg;
  }, 50);
}

function withTransition(fn) {
  if (document.startViewTransition && !reduced() && S.screen) {
    try {
      document.startViewTransition(fn);
      return;
    } catch {
      /* sin transición */
    }
  }
  fn();
}

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
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function resolvedTheme(t = getTheme()) {
  return t === 'auto' ? (darkMq.matches ? 'dark' : 'light') : t;
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    storage.setItem('mt.theme', t);
  } catch {
    /* solo esta sesión */
  }
  const color = resolvedTheme(t) === 'dark' ? '#0b0d11' : '#f8f9fb';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color));
  if (S.refs.themeBtn) drawThemeBtn();
}
applyTheme(getTheme());
darkMq.addEventListener?.('change', () => applyTheme(getTheme()));

const THEME_LABEL = { auto: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: oscuro' };
function drawThemeBtn() {
  const t = getTheme();
  const btn = S.refs.themeBtn;
  if (!btn) return;
  btn.setAttribute('aria-label', THEME_LABEL[t]);
  btn.title = THEME_LABEL[t];
  mount(btn, icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'circle-half', 'icon-sm'));
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(getTheme()) + 1) % order.length];
  applyTheme(next);
  announce(THEME_LABEL[next]);
}

// ---------------------------------------------------------------------------
// Avisos flotantes (uno o dos a la vez, fusionables, con temporizador visible)
// ---------------------------------------------------------------------------

const TOASTS = [];
const toastHost = () => $('#toasts');

function showHost() {
  const host = toastHost();
  try {
    if (!host.showPopover) return;
    // Si hay un diálogo abierto, se vuelve a abrir para quedar por encima en la capa superior.
    if (host.matches(':popover-open') && document.querySelector('dialog[open]')) host.hidePopover();
    if (!host.matches(':popover-open')) host.showPopover();
  } catch {
    /* sin popover: se ve igual con posición fija */
  }
}
function hideHostIfEmpty() {
  const host = toastHost();
  if (host.children.length) return;
  try {
    if (host.hidePopover && host.matches(':popover-open')) host.hidePopover();
  } catch {
    /* nada */
  }
}

function removeToast(entry, animate = true) {
  const i = TOASTS.indexOf(entry);
  if (i === -1) return;
  TOASTS.splice(i, 1);
  clearTimeout(entry.timer);
  const hadFocus = entry.el.contains(document.activeElement);
  const done = () => {
    entry.el.remove();
    hideHostIfEmpty();
  };
  if (animate && !reduced()) {
    entry.el.classList.add('is-out');
    setTimeout(done, 160);
  } else done();
  if (hadFocus) restoreFocus(null);
}

function clearToasts() {
  [...TOASTS].forEach((t) => removeToast(t, false));
}

function buildToastEl(entry) {
  const btn = entry.fns.length
    ? h('button', {
        type: 'button',
        text: entry.actionLabel,
        onclick: () => {
          const fns = entry.fns.slice();
          removeToast(entry);
          fns.forEach((fn) => fn && fn());
        },
      })
    : null;
  const el = h('div', { class: 'toast' }, icon(entry.icon, 'icon-sm'), h('span', { class: 'grow', text: entry.text }), btn);
  el.style.setProperty('--life', entry.life + 'ms');
  const pause = () => {
    if (entry.paused) return;
    entry.paused = true;
    clearTimeout(entry.timer);
    entry.remaining -= Date.now() - entry.started;
  };
  const resume = () => {
    if (!entry.paused) return;
    entry.paused = false;
    entry.started = Date.now();
    entry.timer = setTimeout(() => removeToast(entry), Math.max(800, entry.remaining));
  };
  el.addEventListener('mouseenter', pause);
  el.addEventListener('focusin', pause);
  el.addEventListener('mouseleave', resume);
  el.addEventListener('focusout', (e) => {
    if (!el.contains(e.relatedTarget)) resume();
  });
  return el;
}

function toast(message, { key = null, merge = null, action = null, icon: ic = 'info', timeout } = {}) {
  const host = toastHost();
  const life = timeout || (action ? 8000 : 5000);
  const last = TOASTS[TOASTS.length - 1];
  if (key && last && last.key === key && merge) {
    last.count += 1;
    last.text = merge(last.count);
    if (action) last.fns.push(action.fn);
    clearTimeout(last.timer);
    last.life = life;
    last.remaining = life;
    last.started = Date.now();
    last.paused = false;
    const fresh = buildToastEl(last);
    last.el.replaceWith(fresh);
    last.el = fresh;
    last.timer = setTimeout(() => removeToast(last), life);
    return;
  }
  const entry = { key, count: 1, text: message, icon: ic, fns: action ? [action.fn] : [], actionLabel: action ? action.label : '', life, remaining: life, started: Date.now(), paused: false };
  entry.el = buildToastEl(entry);
  showHost();
  host.append(entry.el);
  TOASTS.push(entry);
  entry.timer = setTimeout(() => removeToast(entry), life);
  const max = matchMedia('(max-width: 640px)').matches ? 1 : 2;
  while (TOASTS.length > max) removeToast(TOASTS[0], false);
}

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------

function passwordField({ id, label, autocomplete, hint, minlength, revealLabel, mono = false, aside = null, mask = false }) {
  const input = h('input', {
    class: 'input' + (mono ? ' mono' : '') + (mask ? ' masked' : ''),
    id,
    name: id,
    type: mask ? 'text' : 'password',
    autocomplete,
    required: true,
    minlength,
    spellcheck: 'false',
    autocapitalize: 'off',
    autocorrect: 'off',
  });
  const reveal = revealLabel || `Mostrar ${label.toLowerCase()}`;
  const btn = h('button', { type: 'button', class: 'btn btn-icon reveal', 'aria-label': reveal, 'aria-pressed': 'false', 'aria-controls': id }, icon('eye', 'icon-sm'));
  btn.addEventListener('click', () => {
    const show = mask ? input.classList.contains('masked') : input.type === 'password';
    if (mask) input.classList.toggle('masked', !show);
    else input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    mount(btn, icon(show ? 'eye-slash' : 'eye', 'icon-sm'));
  });
  const hintEl = hint ? h('p', { class: 'hint', id: id + '-hint', text: hint }) : null;
  const field = h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-head' }, h('label', { for: id, text: label }), aside),
    h('div', { class: 'input-wrap' }, input, btn),
    hintEl
  );
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return { field, input, hintEl };
}

function textField({ id, label, type = 'text', autocomplete, placeholder, inputmode, value }) {
  const input = h('input', { class: 'input', id, name: id, type, autocomplete, placeholder, inputmode, required: true, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' });
  if (value) input.value = value;
  const field = h('div', { class: 'field' }, h('label', { for: id, text: label }), input);
  return { field, input };
}

function pmUser(host) {
  return h('input', { type: 'text', name: 'username', autocomplete: 'username', value: `Tasques · ${host || 'este navegador'}`, readonly: true, tabindex: '-1', 'aria-hidden': 'true', class: 'pm-user' });
}

// Error accesible: va enlazado al campo con aria-invalid y aria-describedby.
function showError(slot, err, input) {
  const id = uid('err');
  mount(slot, h('div', { class: 'alert alert-error', role: 'alert', id }, icon('warning-circle', 'icon-sm'), h('div', { class: 'alert-body' }, h('p', { class: 'msg', text: err?.message || String(err) }))));
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    const prev = (input.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && !x.startsWith('err-'));
    input.setAttribute('aria-describedby', [...prev, id].join(' '));
    input.focus();
    const reset = () => {
      clearError(slot, input);
      input.removeEventListener('input', reset);
    };
    input.addEventListener('input', reset);
  }
}
function clearError(slot, input) {
  clear(slot);
  const inputs = input ? [input] : [];
  inputs.forEach((el) => {
    el.removeAttribute('aria-invalid');
    const rest = (el.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && !x.startsWith('err-'));
    if (rest.length) el.setAttribute('aria-describedby', rest.join(' '));
    else el.removeAttribute('aria-describedby');
  });
}

function busy(btn, on, label, ic = 'arrows-clockwise') {
  if (on) {
    btn.dataset.idle = btn.dataset.idle || '1';
    btn._idle = [...btn.childNodes];
    btn.setAttribute('aria-disabled', 'true');
    mount(btn, icon(ic, 'icon-sm spin'), label);
  } else {
    btn.removeAttribute('aria-disabled');
    if (btn._idle) mount(btn, ...btn._idle);
  }
}

function strengthUi(input, contextFn) {
  const fill = h('i');
  const meter = h('div', { class: 'meter', 'data-level': '0', 'aria-hidden': 'true' }, fill);
  const aside = h('span', { class: 'aside', 'aria-live': 'polite' });
  const update = () => {
    const v = input.value;
    const s = passphraseStrength(v, contextFn());
    meter.dataset.level = String(s.level);
    fill.style.setProperty('--lvl', String(v ? Math.max(0.08, s.level / 4) : 0));
    aside.textContent = v ? `Seguridad: ${s.label.toLowerCase()}` : '';
  };
  input.addEventListener('input', update);
  return { meter, aside, update };
}

function matchUi(a, b) {
  const line = h('p', { class: 'match', 'aria-live': 'polite' });
  const update = () => {
    if (!b.value) return mount(line);
    if (a.value === b.value) {
      line.className = 'match is-ok';
      mount(line, icon('check-circle', 'icon-xs'), 'Coinciden');
    } else {
      line.className = 'match';
      mount(line, 'Aún no coinciden');
    }
  };
  a.addEventListener('input', update);
  b.addEventListener('input', update);
  return line;
}

function passContext(extra = []) {
  const words = [];
  const add = (s) =>
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9à-ÿ]+/i)
      .filter((w) => w.length >= 3)
      .forEach((w) => words.push(w));
  extra.forEach(add);
  if (SITE_CFG) {
    add(SITE_CFG.schoolName);
    try {
      new URL(SITE_CFG.moodleUrl).pathname.split('/').forEach(add);
    } catch {
      /* nada */
    }
  }
  return [...new Set(words)];
}

// Selector "usuario y contraseña" / "token" con los campos de cada modo.
function credsBlock({ mode = 'password', siteUrl = () => '', idPrefix = '' } = {}) {
  let current = mode;
  const name = uid('mode');
  const user = textField({ id: idPrefix + 'username', label: 'Usuario', autocomplete: 'username' });
  const pass = passwordField({ id: idPrefix + 'password', label: 'Contraseña', autocomplete: 'current-password', revealLabel: 'Mostrar la contraseña' });
  const counter = h('span', { class: 'aside', 'aria-live': 'off' }, '0/32');
  const token = passwordField({ id: idPrefix + 'wstoken', label: 'Token de la app móvil', autocomplete: 'off', revealLabel: 'Mostrar el token', mono: true, aside: counter, mask: true });
  token.input.setAttribute('inputmode', 'text');
  token.input.setAttribute('maxlength', '64');
  const tokLink = h('a', { target: '_blank', rel: 'noopener noreferrer', class: 'link', hidden: true }, 'Abrir esa página', h('span', { class: 'sr', text: ' (se abre en otra pestaña)' }));
  const tokHint = h(
    'div',
    { class: 'hint', id: token.input.id + '-hint' },
    h('p', {}, 'En tu Moodle: Preferències › Claus de seguretat › «Moodle mobile web service». ', tokLink),
    h('p', { text: 'Si no ves ningún token, usa tu usuario y contraseña.' })
  );
  token.field.append(tokHint);
  token.input.setAttribute('aria-describedby', tokHint.id);
  const countTok = () => {
    const v = token.input.value.trim();
    const ok = TOKEN_RE.test(v);
    counter.className = 'aside' + (ok ? ' is-ok' : '');
    mount(counter, ok ? icon('check-circle', 'icon-xs') : null, `${Math.min(v.length, 99)}/32`);
  };
  token.input.addEventListener('input', countTok);
  token.input.addEventListener('paste', () => setTimeout(() => {
    token.input.value = token.input.value.replace(/\s+/g, '');
    countTok();
  }));
  const refreshLink = () => {
    let base = '';
    try {
      base = normalizeSiteUrl(siteUrl());
    } catch {
      base = '';
    }
    if (base) {
      tokLink.setAttribute('href', `${base}/user/managetoken.php`);
      tokLink.hidden = false;
    } else tokLink.hidden = true;
  };

  const opt = (value, label) => {
    const input = h('input', { type: 'radio', name, value });
    input.checked = value === current;
    input.addEventListener('change', () => {
      if (input.checked) setMode(value);
    });
    return h('label', {}, input, h('span', { text: label }));
  };
  const seg = h('fieldset', { class: 'seg' }, h('legend', { class: 'sr', text: 'Forma de acceso' }), opt('password', 'Usuario y contraseña'), opt('token', 'Tengo un token'));
  const pwBox = h('div', { class: 'form' }, user.field, pass.field);
  const onChange = [];
  const setMode = (m) => {
    current = m;
    pwBox.hidden = m !== 'password';
    token.field.hidden = m !== 'token';
    user.input.required = pass.input.required = m === 'password';
    token.input.required = m === 'token';
    refreshLink();
    onChange.forEach((fn) => fn(m));
  };
  setMode(current);
  return {
    seg,
    fields: h('div', { class: 'form' }, pwBox, token.field),
    user,
    pass,
    token,
    get mode() {
      return current;
    },
    onChange: (fn) => onChange.push(fn),
    refreshLink,
  };
}

// ---------------------------------------------------------------------------
// Diálogos
// ---------------------------------------------------------------------------

function openDialog(build, { cls = '' } = {}) {
  const dlg = h('dialog', { class: cls });
  let closing = false;
  const close = () => {
    if (closing || !dlg.open) return;
    closing = true;
    if (reduced()) return dlg.close();
    dlg.dataset.closing = '';
    setTimeout(() => dlg.close(), 160);
  };
  dlg.append(build(close, dlg));
  const title = dlg.querySelector('h2');
  if (title) {
    title.id = title.id || uid('dlg');
    dlg.setAttribute('aria-labelledby', title.id);
  }
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener('close', () => dlg.remove());
  let down = false;
  dlg.addEventListener('pointerdown', (e) => {
    down = e.target === dlg;
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && down && e.detail <= 1 && !dlg.querySelector('form')) close();
    down = false;
  });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

function dialogHead(title, close) {
  return h('div', { class: 'dlg-head' }, h('h2', { text: title }), h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Cerrar', onclick: close }, icon('x', 'icon-sm')));
}

function confirmDialog({ title, body, confirm }) {
  return new Promise((resolve) => {
    let answered = false;
    const bodyId = uid('cbody');
    const { dlg } = openDialog(
      (close) => {
        const cancel = h('button', { type: 'button', class: 'btn btn-outline', text: 'Cancelar', onclick: close });
        setTimeout(() => cancel.focus(), 0);
        return h(
          'div',
          { class: 'dlg-body' },
          h('span', { class: 'confirm-icon' }, icon('warning', 'icon')),
          h('h2', { text: title }),
          h('p', { id: bodyId, text: body }),
          h(
            'div',
            { class: 'dlg-actions' },
            cancel,
            h('button', {
              type: 'button',
              class: 'btn btn-danger-solid',
              text: confirm,
              onclick: () => {
                answered = true;
                resolve(true);
                close();
              },
            })
          )
        );
      },
      { cls: 'confirm' }
    );
    dlg.setAttribute('aria-describedby', bodyId);
    dlg.addEventListener('close', () => !answered && resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Etiquetas de asignatura y filas de tarea
// ---------------------------------------------------------------------------

const colorMap = () => (S.data && S.data.colors) || S.previewColors || {};
const hueOf = (id) => T.courseHueOf(colorMap(), id);

function tag(t) {
  return h('span', { class: 'tag', title: t.courseName, lang: contentLang(), style: { '--h': String(hueOf(t.courseId)) }, text: T.courseCode(t.courseShort, t.courseName) });
}

function goLink(t, cls = 'btn btn-icon go') {
  if (!t.url) return null;
  return h(
    'a',
    { class: cls, href: t.url, target: '_blank', rel: 'noopener noreferrer', title: t.actionName ? `${t.actionName} en Moodle` : 'Abrir en Moodle', dataset: { key: 'open:' + t.id } },
    icon('arrow-up-right', 'icon-sm'),
    h('span', { class: 'sr', text: `Abrir «${t.title}» en Moodle (se abre en otra pestaña)` })
  );
}

function mobileDue(t, now, bucket) {
  if (bucket === 'overdue') return h('span', { class: 'meta-due' }, h('span', { dataset: { due: String(t.due) }, text: T.relative(t.due, now) }));
  if (bucket === 'today') {
    const { time } = T.formatDueParts(t.due, now);
    return h('span', { class: 'meta-due' }, `${time} · `, h('span', { class: 'r', dataset: { due: String(t.due) }, text: T.relative(t.due, now) }));
  }
  return h('span', { class: 'meta-due', text: T.formatDueCompact(t.due, now) });
}

function taskRow(t, now, i, ctx = {}) {
  const how = ctx.how || null; // en Hechas: 'manual' | 'gone' | 'expired'
  const inDone = Boolean(how);
  const bucket = inDone ? 'done' : T.bucketOf(t, now);
  const [kindLabel, kindIcon] = T.kindOf(t.kind);
  const closed = !inDone && t.actionable === false;
  const cls = ['row', ctx.anim && 'anim', how === 'manual' && 'is-done', inDone && how !== 'manual' && 'is-gone', closed && 'is-closed'].filter(Boolean).join(' ');
  const li = h('li', { class: cls, dataset: { bucket, id: t.id }, style: { '--i': String(i) } });

  let lead;
  if (inDone && how !== 'manual') {
    lead = h('span', { class: 'state-glyph' + (how === 'expired' ? ' is-expired' : ''), 'aria-hidden': 'true' }, h('span', {}, icon(how === 'expired' ? 'x-circle' : 'info', 'icon-xs')));
  } else {
    const input = h('input', {
      type: 'checkbox',
      class: 'check',
      'aria-label': inDone ? `Volver a poner «${t.title}» como pendiente` : `Marcar «${t.title}» como hecha`,
      dataset: { key: 'check:' + t.id },
    });
    input.checked = inDone;
    if (ctx.preview) input.tabIndex = -1;
    input.addEventListener('change', () => toggleDone(t, input.checked, li));
    lead = h('label', { class: 'check-hit' }, input);
  }

  const title = h(
    'button',
    { type: 'button', class: 'row-title', lang: contentLang(), dataset: { key: 'title:' + t.id }, onclick: (e) => openTask(t, e.currentTarget, how) },
    h('span', { class: 'strike', text: t.title })
  );

  const badges = [];
  const det = taskDetails(t);
  if (!inDone && det.sub?.status === 'draft') badges.push(h('span', { class: 'badge is-warn', title: 'Tienes un borrador guardado que aún no has enviado' }, icon('pencil-simple-line', 'icon-xs'), 'Borrador'));
  if (!inDone && det.sub?.extension > now) badges.push(h('span', { class: 'badge is-ok', title: `Prórroga hasta ${T.formatLongDate(det.sub.extension)}` }, 'Prórroga'));
  if (!inDone && det.q?.timeLimit) badges.push(h('span', { class: 'badge' }, icon('timer', 'icon-xs'), `${Math.round(det.q.timeLimit / 60)} min`));
  if (closed && bucket === 'overdue') badges.push(h('span', { class: 'badge', text: 'Ya no admite entregas' }));
  else if (closed) badges.push(h('span', { class: 'badge', text: 'Aún no está abierto' }));
  if (how === 'manual' && S.data?.tasks.some((x) => x.id === t.id && x.due < now)) badges.push(h('span', { class: 'badge is-warn', text: 'Moodle aún la ve pendiente' }));

  const meta = h(
    'div',
    { class: 'row-meta' },
    inDone ? null : mobileDue(t, now, bucket),
    tag(t),
    h('span', { class: 'kind' }, icon(kindIcon, 'icon-xs'), t.kindLabel || kindLabel),
    ...badges
  );

  let end;
  if (inDone) {
    const [word, abs] =
      how === 'manual'
        ? ['hecha', h('span', { class: 'abs', dataset: { due: String(t.completedAt) }, text: T.relative(t.completedAt, now) })]
        : [how === 'expired' ? 'cerró' : 'vencía', h('time', { class: 'abs', datetime: new Date(t.due).toISOString(), text: T.formatShortDay(t.due) })];
    end = h('div', { class: 'row-end' }, h('span', { class: 'rel', text: word }), abs);
  } else {
    const { day, time } = T.formatDueParts(t.due, now);
    const absText = bucket === 'today' || bucket === 'tomorrow' ? time : `${day}, ${time}`;
    end = h(
      'div',
      { class: 'row-end' },
      h('span', { class: 'rel', dataset: { due: String(t.due) }, text: T.relative(t.due, now) }),
      h('time', { class: 'abs', datetime: new Date(t.due).toISOString(), text: absText })
    );
  }

  li.append(lead, h('div', { class: 'row-main' }, title, meta), end, ctx.preview ? h('span') : goLink(t) || h('span'));
  return li;
}

// ---------------------------------------------------------------------------
// Pantalla de acceso
// ---------------------------------------------------------------------------

function storyPanel() {
  const demo = demoData();
  S.previewColors = T.assignCourseColors({}, demo.courses.map((c) => c.id));
  const now = Date.now();
  const sample = demo.tasks.filter((t) => t.due >= now).slice(0, 3);
  const frame = h(
    'div',
    { class: 'preview-frame force-dark', 'aria-hidden': 'true', inert: true },
    h('div', { class: 'group-head' }, h('h3', { text: 'Próximas entregas' }), h('span', { class: 'cnt', text: String(sample.length) })),
    h('ul', { class: 'rows' }, ...sample.map((t, i) => taskRow(t, now, i, { preview: true })))
  );
  return h(
    'aside',
    { class: 'gate-story', 'aria-label': 'Qué es Tasques' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('brand', 'icon')), h('span', { text: 'Tasques' })),
    h('p', { class: 'tagline-m', text: 'Tus entregas de Moodle, en una lista.' }),
    h('h1', { text: 'Todo lo que te queda en Moodle, en una lista.' }),
    h('p', { class: 'lede', text: 'Entregas, cuestionarios y foros de todas tus asignaturas, ordenados por fecha límite.' }),
    h('p', { class: 'trust' }, icon('shield-check', 'icon-sm'), 'Cifrado en tu navegador · Tu contraseña no se guarda · Directo a tu Moodle'),
    h('div', { class: 'preview' }, h('p', { class: 'preview-cap' }, icon('eye', 'icon-xs'), 'Vista previa con datos de ejemplo'), frame)
  );
}

function stepper(step) {
  return h(
    'div',
    { class: 'stepper' },
    h('ol', { 'aria-hidden': 'true' }, h('li', { class: 'is-on' }), h('li', { class: step === 2 ? 'is-on' : '' })),
    h('span', { text: `Paso ${step} de 2` })
  );
}

function renderOnboard(prefill = {}) {
  clearToasts();
  stopTimers();
  S.data = null;
  S.demo = false;
  S.refs = {};
  let pending = null;
  const card = h('div', { class: 'gate-card' });
  const gate = h('div', { class: 'gate' }, storyPanel(), h('main', { class: 'gate-form', id: 'main' }, card));

  const stepOne = () => {
    gate.classList.remove('is-step2');
    document.title = 'Conecta tu Moodle · Tasques';
    const cfgUrl = SITE_CFG?.moodleUrl || '';
    const site = textField({ id: 'site', label: 'Dirección de tu Moodle', type: 'url', autocomplete: 'url', placeholder: 'educaciodigital.cat/tuinstituto/moodle', inputmode: 'url', value: prefill.site || cfgUrl });
    const siteHint = h('div', { class: 'hint', id: 'site-hint' });
    site.input.setAttribute('aria-describedby', 'site-hint');
    site.field.append(siteHint);
    let t = null;
    const drawSiteHint = () => {
      const v = site.input.value.trim();
      if (cfgUrl && v && v === cfgUrl) {
        siteHint.className = 'hint is-ok';
        return mount(siteHint, icon('check-circle', 'icon-xs'), h('span', { text: `Moodle de ${SITE_CFG.schoolName || 'tu centro'}. Cámbiala si usas otro.` }));
      }
      siteHint.className = 'hint';
      let norm = '';
      try {
        norm = v ? normalizeSiteUrl(v) : '';
      } catch {
        norm = '';
      }
      if (norm) {
        const parts = norm.split('/');
        const nodes = [];
        parts.forEach((p, i) => {
          nodes.push(p);
          if (i < parts.length - 1) nodes.push('/', h('wbr'));
        });
        mount(siteHint, 'Se conectará a ', h('span', { class: 'mono' }, ...nodes));
      } else mount(siteHint, 'La que ves en el navegador al entrar en Moodle.');
    };
    drawSiteHint();
    const creds = credsBlock({ mode: prefill.mode || (SITE_CFG?.loginMode === 'token' ? 'token' : 'password'), siteUrl: () => site.input.value });
    site.input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        drawSiteHint();
        creds.refreshLink();
      }, 300);
    });
    const errSlot = h('div');
    creds.onChange(() => clearError(errSlot, null));
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block', text: 'Continuar' });
    const form = h('form', { class: 'form', novalidate: true }, site.field, creds.seg, creds.fields, errSlot, submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.getAttribute('aria-disabled') === 'true') return;
      [site.input, creds.pass.input, creds.token.input, creds.user.input].forEach((i) => clearError(errSlot, i));
      busy(submit, true, 'Conectando con Moodle…');
      let focusEl = site.input;
      try {
        const client = new MoodleClient({ siteUrl: site.input.value });
        if (creds.mode === 'password') {
          if (!creds.user.input.value.trim()) {
            focusEl = creds.user.input;
            throw new MoodleError('Escribe tu usuario de Moodle.', 'empty');
          }
          if (!creds.pass.input.value) {
            focusEl = creds.pass.input;
            throw new MoodleError('Escribe tu contraseña de Moodle.', 'empty');
          }
          await client.login(creds.user.input.value.trim(), creds.pass.input.value);
        } else {
          const tk = creds.token.input.value.trim();
          if (!TOKEN_RE.test(tk)) {
            focusEl = creds.token.input;
            throw new MoodleError('El token tiene 32 letras y números (0-9, a-f). Revisa que lo hayas copiado entero.', 'badtoken');
          }
          client.token = tk;
        }
        let info;
        try {
          info = await client.siteInfo();
        } catch (err) {
          if (creds.mode === 'token' && (err.code === 'invalidtoken' || err.code === 'accessexception')) {
            focusEl = creds.token.input;
            throw new MoodleError(tokenErrorMessage(), err.code);
          }
          throw err;
        }
        if (!info || !Number(info.userid)) throw new MoodleError('Moodle no ha devuelto los datos de tu cuenta.', 'noinfo');
        pending = { client, info, mode: creds.mode, site: site.input.value };
        creds.pass.input.value = '';
        creds.token.input.value = '';
        stepTwo();
      } catch (err) {
        busy(submit, false);
        if (err.code === 'invalidlogin') focusEl = creds.pass.input;
        showError(errSlot, err, focusEl);
      }
    });

    const demoBtn = h('button', { type: 'button', class: 'btn btn-outline btn-lg btn-block', onclick: enterDemo }, icon('play', 'icon-sm'), 'Probar con datos de ejemplo');
    const notes = [];
    if (location.hostname === 'localhost' && !vault.exists()) {
      notes.push(h('p', { class: 'gate-note' }, icon('info', 'icon-sm'), h('span', {}, '¿Ya usabas Tasques? Tus datos se guardan por dirección: prueba en ', h('a', { href: `http://127.0.0.1:${location.port || 8080}/`, class: 'link', text: `http://127.0.0.1:${location.port || 8080}` }), '.')));
    }
    const head = h('h2', { text: 'Conecta tu Moodle', tabindex: '-1' });
    mount(
      card,
      h('header', {}, stepper(1), head, h('p', { text: 'Usaremos el mismo acceso que la app oficial de Moodle.' })),
      form,
      h('div', { class: 'or', text: 'o' }),
      demoBtn,
      h('p', { class: 'gate-note gate-trust-m' }, icon('shield-check', 'icon-sm'), h('span', { text: 'Cifrado en tu navegador. Tu contraseña no se guarda.' })),
      ...notes
    );
    if (!coarse()) {
      const firstEmpty = !site.input.value ? site.input : creds.mode === 'token' ? creds.token.input : creds.user.input;
      firstEmpty.focus();
    }
  };

  const stepTwo = () => {
    gate.classList.add('is-step2');
    document.title = 'Protege tus datos · Tasques';
    const host = pending.client.siteUrl ? hostOf(pending.client.siteUrl) : '';
    const name = textOf(pending.info.firstname || String(pending.info.fullname || '').split(' ')[0], 60);
    const ctx = () => passContext([name, pending.info.username, pending.info.sitename, host, ...String(pending.client.siteUrl).split('/')]);
    const p1 = passwordField({ id: 'pp1', label: 'Frase de acceso', autocomplete: 'new-password', minlength: MIN_PASSPHRASE, revealLabel: 'Mostrar la frase' });
    const p2 = passwordField({ id: 'pp2', label: 'Repítela', autocomplete: 'new-password', revealLabel: 'Mostrar la repetición' });
    const st = strengthUi(p1.input, ctx);
    p1.field.querySelector('.field-head').append(st.aside);
    const hint = h('p', { class: 'hint', id: 'pp1-hint', text: `Mínimo ${MIN_PASSPHRASE} caracteres. Mejor varias palabras: «cafè lent sota la pluja».` });
    p1.field.insertBefore(hint, p1.field.querySelector('.input-wrap'));
    p1.input.setAttribute('aria-describedby', 'pp1-hint');
    p1.field.append(st.meter);
    const match = matchUi(p1.input, p2.input);
    p2.field.append(match);
    const errSlot = h('div');
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, icon('lock-key', 'icon-sm'), 'Cifrar y ver mis tareas');
    const form = h('form', { class: 'form', novalidate: true }, pmUser(host), p1.field, p2.field, errSlot, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.getAttribute('aria-disabled') === 'true') return;
      clearError(errSlot, p1.input);
      clearError(errSlot, p2.input);
      const a = p1.input.value;
      const s = passphraseStrength(a, ctx());
      if (a.length < MIN_PASSPHRASE) return showError(errSlot, new Error(`La frase necesita al menos ${MIN_PASSPHRASE} caracteres.`), p1.input);
      if (s.level === 0) return showError(errSlot, new Error('Esa frase es de las más usadas. Elige otra, por ejemplo tres o cuatro palabras al azar.'), p1.input);
      if (s.level < 2) return showError(errSlot, new Error('Es demasiado fácil de adivinar. Añade otra palabra o algún número.'), p1.input);
      if (a !== p2.input.value) return showError(errSlot, new Error('Las dos frases no coinciden.'), p2.input);
      busy(submit, true, 'Generando la clave…');
      try {
        const data = newData(pending.client, pending.info, pending.mode);
        await vault.create(a, data);
        p1.input.value = p2.input.value = '';
        scrubRegExp();
        writeHint(data);
        pending = null;
        S.data = data;
        S.demo = false;
        withTransition(() => enterApp({ firstSync: true }));
      } catch (err) {
        busy(submit, false);
        showError(errSlot, err, p1.input);
      }
    });
    const back = h('button', { type: 'button', class: 'back', onclick: () => {
      const site = pending?.site;
      const mode = pending?.mode;
      pending = null;
      prefill.site = site;
      prefill.mode = mode;
      stepOne();
    } }, icon('arrow-left', 'icon-sm'), 'Usar otra cuenta');
    const head = h('h2', { text: name ? `Hola, ${name}. Protege tus datos` : 'Protege tus datos', tabindex: '-1' });
    mount(
      card,
      h(
        'header',
        {},
        back,
        stepper(2),
        head,
        h('p', { text: 'Te la pediremos cada vez que abras Tasques. Si la olvidas no pierdes nada importante: borras los datos de este navegador y vuelves a conectar Moodle.' })
      ),
      form
    );
    if (!coarse()) p1.input.focus();
    else head.focus();
  };

  withTransition(() => {
    S.screen = 'onboard';
    mount(root, gate);
    stepOne();
  });
}

function newData(client, info, mode) {
  return {
    v: 2,
    site: {
      url: client.siteUrl,
      name: textOf(info.sitename || 'Moodle', 120),
      userName: textOf(info.fullname, 120),
      firstName: textOf(info.firstname, 60),
      userId: Number(info.userid),
      lang: String(info.lang || '').slice(0, 2),
      auth: mode === 'token' ? 'token' : 'password',
    },
    token: client.token,
    tasks: [],
    courses: [],
    colors: {},
    done: {},
    history: [],
    grades: null,
    details: { assign: {}, quiz: {}, sub: {} },
    gradesSeenAt: 0,
    lastSync: 0,
    prefs: { lockMinutes: 10, overdueDays: 30, transport: client.transport === 'proxy' ? 'proxy' : 'auto' },
  };
}

function writeHint(d) {
  try {
    storage.setItem('mt.hint', JSON.stringify({ site: d.site.name, host: hostOf(d.site.url) }));
  } catch {
    /* nada */
  }
}
function readHint() {
  try {
    return JSON.parse(storage.getItem('mt.hint')) || {};
  } catch {
    return {};
  }
}

function enterDemo() {
  const d = demoData();
  S.demo = true;
  S.data = {
    v: 2,
    site: d.site,
    token: null,
    tasks: d.tasks,
    courses: slimCourses(d.courses),
    colors: T.assignCourseColors({}, d.courses.map((c) => c.id)),
    done: {},
    history: d.history,
    grades: d.grades,
    details: d.details,
    gradesSeenAt: Date.now() - 4 * DAY,
    lastSync: Date.now(),
    prefs: { lockMinutes: 0, overdueDays: 30, transport: 'auto' },
  };
  withTransition(() => enterApp({}));
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
  clearToasts();
  stopTimers();
  document.title = 'Desbloquear · Tasques';
  const hint = readHint();
  const pp = passwordField({ id: 'unlock', label: 'Frase de acceso', autocomplete: 'current-password', revealLabel: 'Mostrar la frase' });
  const errSlot = h('div');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block btn-wait' }, icon('lock-key-open', 'icon-sm'), 'Desbloquear');
  const idle = [...submit.childNodes];
  const form = h('form', { class: 'form', novalidate: true }, pmUser(hint.host), pp.field, errSlot, submit);

  let wait = null;
  let announced = false;
  const throttle = () => {
    const left = Math.ceil((failState().until - Date.now()) / 1000);
    if (left > 0) {
      if (submit.getAttribute('aria-disabled') !== 'true') {
        submit.setAttribute('aria-disabled', 'true');
        submit.style.setProperty('--wait', left + 's');
      }
      mount(submit, `Espera ${left} s`);
      if (!announced) {
        announce(`Espera ${left} segundos antes de volver a intentarlo.`);
        announced = true;
      }
      wait = setTimeout(throttle, 1000);
    } else {
      submit.removeAttribute('aria-disabled');
      mount(submit, ...idle);
      announced = false;
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.getAttribute('aria-disabled') === 'true') return;
    clearError(errSlot, pp.input);
    busy(submit, true, 'Descifrando…');
    let data;
    try {
      data = await vault.unlock(pp.input.value);
    } catch (err) {
      const f = failState();
      f.n += 1;
      if (f.n >= 3) f.until = Date.now() + Math.min(60, 2 ** (f.n - 2)) * 1000;
      storage.setItem('mt.fail', JSON.stringify(f));
      busy(submit, false);
      const msg = /incorrecta/i.test(err.message) ? 'Esa frase no abre tus datos. Inténtalo otra vez.' : err.message;
      mount(errSlot, h('p', { class: 'field-error', id: 'unlock-err', role: 'alert' }, icon('warning-circle', 'icon-sm'), msg));
      pp.input.setAttribute('aria-invalid', 'true');
      pp.input.setAttribute('aria-describedby', 'unlock-err');
      pp.input.classList.remove('shake');
      void pp.input.offsetWidth;
      pp.input.classList.add('shake');
      pp.input.select();
      throttle();
      return;
    }
    pp.input.value = '';
    storage.removeItem('mt.fail');
    clearTimeout(wait);
    S.data = migrate(data);
    S.demo = false;
    writeHint(S.data);
    withTransition(() => enterApp({}));
  });
  pp.input.addEventListener('input', () => {
    if (pp.input.getAttribute('aria-invalid')) {
      pp.input.removeAttribute('aria-invalid');
      pp.input.removeAttribute('aria-describedby');
      clear(errSlot);
    }
  });

  const forget = h('button', {
    type: 'button',
    class: 'link',
    text: 'Borrar los datos y conectar de nuevo',
    onclick: async () => {
      const ok = await confirmDialog({
        title: '¿Borrar los datos de este navegador?',
        body: 'Sin la frase no hay forma de descifrarlos. Se borran el token y la copia de tus tareas. En Moodle no cambia nada.',
        confirm: 'Borrar y empezar',
      });
      if (ok) {
        wipe();
        renderOnboard();
      }
    },
  });

  withTransition(() => {
    S.screen = 'lock';
    mount(
      root,
      h(
        'main',
        { class: 'lock', id: 'main' },
        h('div', { class: 'lock-top' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('brand', 'icon')), h('span', { text: 'Tasques' })), hint.site ? h('span', { class: 'site', text: hint.site }) : null),
        h(
          'div',
          { class: 'lock-card' },
          h('span', { class: 'glyph' }, icon('lock-key', 'icon')),
          h('div', {}, h('h1', { text: 'Tus tareas están cifradas', tabindex: '-1' }), h('p', { class: 'sub', text: 'Escribe tu frase para verlas.' })),
          reason ? h('p', { class: 'reason' }, icon('clock-countdown', 'icon-xs'), h('span', { text: reason })) : null,
          form
        ),
        h('p', { class: 'lock-foot' }, '¿No la recuerdas? ', forget)
      )
    );
    throttle();
    pp.input.focus();
  });
}

function migrate(d) {
  d.prefs = { lockMinutes: 10, overdueDays: 60, transport: 'auto', ...(d.prefs || {}) };
  d.done = d.done || {};
  d.history = (d.history || []).map((x) => (x.how === 'moodle' ? { ...x, how: 'gone' } : x));
  d.tasks = d.tasks || [];
  d.courses = d.courses || [];
  d.colors = d.colors || {};
  d.grades = d.grades || null;
  d.details = d.details || { assign: {}, quiz: {}, sub: {} };
  d.gradesSeenAt = d.gradesSeenAt || 0;
  d.site = d.site || {};
  d.site.name = textOf(d.site.name || 'Moodle', 120);
  if (!Object.keys(d.colors).length) {
    d.colors = T.assignCourseColors({}, [...new Set([...d.courses.map((c) => c.id), ...d.tasks.map((t) => t.courseId)])]);
  }
  return d;
}

// Las expresiones regulares guardan la última cadena evaluada (RegExp.input); la sustituimos.
function scrubRegExp() {
  /x/.test('x');
}

function lock(reason) {
  scrubRegExp();
  S.syncGen++;
  S.syncing = false;
  try {
    S.abort?.abort();
  } catch {
    /* nada */
  }
  stopTimers();
  clearToasts();
  document.querySelectorAll('dialog').forEach((d) => d.close());
  S.refs = {};
  S.error = null;
  S.abort = null;
  if (S.demo) {
    S.demo = false;
    S.data = null;
    return boot();
  }
  vault.lock();
  S.data = null;
  renderLock(reason);
}

function wipe() {
  vault.destroy();
  storage.removeItem('mt.fail');
  storage.removeItem('mt.hint');
  S.data = null;
}

// ---------------------------------------------------------------------------
// Aplicación
// ---------------------------------------------------------------------------

function enterApp({ firstSync }) {
  S.screen = 'app';
  S.ui = { view: 'pending', course: null, query: '', day: null };
  S.error = null;
  S.animate = true;
  S.lastActivity = Date.now();
  S.sig = '';
  startTimers();
  try {
    renderShell();
    renderDynamic();
    scrollTo(0, 0);
    S.refs.h1?.focus({ preventScroll: true });
  } catch (err) {
    console.error(err);
    lock('Algo ha fallado al mostrar tus tareas. Vuelve a desbloquear.');
    return;
  }
  if (!S.demo && (firstSync || Date.now() - S.data.lastSync > 10 * MIN)) sync();
}

async function persist() {
  if (S.demo || !vault.unlocked || !S.data) return;
  try {
    await vault.save(S.data);
  } catch (err) {
    toast('No se han podido guardar los cambios: ' + err.message, { icon: 'warning' });
  }
}

function brandEl() {
  return h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('brand', 'icon')), h('span', { text: 'Tasques' }));
}

function renderShell() {
  const r = (S.refs = {});
  const d = S.data;

  // Barra lateral
  r.navViews = h('ul', { class: 'nav' });
  r.navCourses = h('div');
  const lockLabel = S.demo ? 'Salir de la demostración' : 'Bloquear';
  r.side = h(
    'nav',
    { class: 'side', 'aria-label': 'Filtros' },
    h('div', { class: 'side-brand' }, brandEl()),
    h('p', { class: 'side-label', text: 'Vista' }),
    r.navViews,
    r.navCourses,
    h('div', { class: 'side-spacer' }),
    h(
      'div',
      { class: 'account' },
      h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(d.site.userName) }),
      h('div', { class: 'who' }, h('span', { class: 'name', text: d.site.userName || 'Sin nombre' }), h('span', { class: 'host', text: S.demo ? 'Modo demostración' : hostOf(d.site.url) })),
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': lockLabel, title: lockLabel, onclick: () => lock() }, icon(S.demo ? 'sign-out' : 'lock-key', 'icon-sm'))
    )
  );

  // Barra superior
  r.crumb = h('div', { class: 'crumb' });
  r.search = h('input', { type: 'search', placeholder: 'Buscar tareas', 'aria-label': 'Buscar tareas', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  let searchT = null;
  let annT = null;
  r.search.addEventListener('input', () => {
    clearTimeout(searchT);
    clearTimeout(annT);
    searchT = setTimeout(() => {
      S.ui.query = r.search.value;
      S.animate = false;
      renderList();
    }, 120);
    annT = setTimeout(() => {
      const q = r.search.value.trim();
      if (q) announce(`${r.list.querySelectorAll('.row').length} resultados para «${q}»`);
    }, 400);
  });
  const clearSearch = h('button', { type: 'button', class: 'btn btn-icon clear', 'aria-label': 'Borrar búsqueda', onclick: () => setQuery('') }, icon('x', 'icon-xs'));
  r.searchBox = h('div', { class: 'search', role: 'search' }, icon('magnifying-glass', 'icon-sm'), r.search, h('kbd', { text: '/', 'aria-hidden': 'true' }), clearSearch);
  r.searchSlot = h('div', { class: 'd-only' }, r.searchBox);
  r.sync = h('button', { type: 'button', class: 'sync', onclick: () => sync() });
  r.themeBtn = h('button', { type: 'button', class: 'btn btn-icon d-only', onclick: cycleTheme });
  drawThemeBtn();
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'topbar-brand' }, brandEl()),
    r.crumb,
    h(
      'div',
      { class: 'tools' },
      r.searchSlot,
      h('button', { type: 'button', class: 'btn btn-icon m-only', 'aria-label': 'Buscar', 'aria-expanded': 'false', onclick: (e) => toggleSearchRow(e.currentTarget) }, icon('magnifying-glass', 'icon-sm')),
      r.sync,
      h('span', { class: 'vsep d-only', 'aria-hidden': 'true' }),
      h('button', { type: 'button', class: 'btn btn-icon d-only', 'aria-label': 'Exportar al calendario (.ics)', title: 'Exportar al calendario (.ics)', onclick: () => exportIcs() }, icon('calendar-plus', 'icon-sm')),
      r.themeBtn,
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Ajustes', title: 'Ajustes', onclick: openSettings }, icon('gear-six', 'icon-sm')),
      h('button', { type: 'button', class: 'btn btn-icon lt-only', 'aria-label': lockLabel, title: lockLabel, onclick: () => lock() }, icon(S.demo ? 'sign-out' : 'lock-key', 'icon-sm'))
    )
  );
  const demoBar = S.demo
    ? h(
        'div',
        { class: 'demo-bar' },
        h('span', { class: 'grow' }, h('strong', { text: 'Demostración' }), h('span', { class: 'd-only', text: ' · Datos de ejemplo. No se guarda nada.' }), h('span', { class: 'm-only', text: ' · Datos de ejemplo' })),
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => lock() }, h('span', { class: 'd-only', text: 'Conectar mi Moodle' }), h('span', { class: 'm-only', text: 'Conectar' }))
      )
    : null;

  // Contenido
  r.banner = h('div', { id: 'banner' });
  r.title = h('div', { class: 'title' });
  r.next = h('section', { class: 'next', 'aria-labelledby': 'next-h' });
  r.horizon = h('section', { class: 'horizon', 'aria-labelledby': 'hz-title' });
  r.head = h('section', { class: 'head' }, r.title, r.next, r.horizon);
  r.chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Vista' });
  r.courseSelect = h('select', { class: 'select', 'aria-label': 'Asignatura', dataset: { key: 'course-select' } });
  r.courseSelect.addEventListener('change', () => {
    setCourse(r.courseSelect.value === '' ? null : Number(r.courseSelect.value));
  });
  r.searchRow = h('div', { class: 'searchrow' }, h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Cerrar búsqueda', onclick: () => closeSearchRow() }, icon('x', 'icon-sm')));
  r.tasksH = h('h2', { class: 'sr', id: 'tasks-h', tabindex: '-1', text: 'Tareas' });
  r.list = h('div', { class: 'list' });
  r.content = h('main', { class: 'content', id: 'main' }, r.banner, r.head, r.chips, r.searchRow, h('section', { class: 'tasks', 'aria-labelledby': 'tasks-h' }, r.tasksH, r.list));

  mount(root, h('div', { class: 'app' }, r.side, h('div', { class: 'main-col' }, topbar, demoBar, r.content)));
  placeSearch();
}

const mq720 = matchMedia('(max-width: 720px)');
function placeSearch() {
  const r = S.refs;
  if (!r.searchBox) return;
  if (mq720.matches) r.searchRow.prepend(r.searchBox);
  else r.searchSlot.append(r.searchBox);
}
mq720.addEventListener?.('change', placeSearch);

function toggleSearchRow(btn) {
  const c = S.refs.content;
  const open = !c.classList.contains('is-searching');
  c.classList.toggle('is-searching', open);
  btn?.setAttribute('aria-expanded', String(open));
  if (open) S.refs.search.focus();
  else closeSearchRow();
}
function closeSearchRow() {
  setQuery('');
  S.refs.content?.classList.remove('is-searching');
  root.querySelector('.tools .m-only[aria-expanded]')?.setAttribute('aria-expanded', 'false');
}
function setQuery(q) {
  if (!S.refs.search) return;
  S.refs.search.value = q;
  S.ui.query = q;
  S.animate = false;
  renderList();
}

function setView(view, { course = S.ui.course, keepDay = false } = {}) {
  if (view === 'grades' && S.data && S.ui.view !== 'grades') {
    S.gradesSeenBefore = S.data.gradesSeenAt || 0;
    S.data.gradesSeenAt = Date.now();
    persist();
  }
  S.ui.view = view;
  S.ui.course = course;
  if (!keepDay) S.ui.day = null;
  S.animate = true;
  renderDynamic();
  const n = S.refs.list?.querySelectorAll('.row').length || 0;
  announce(view === 'grades' ? 'Notas' : `${VIEW_LABEL[view]}: ${n} ${plural(n, 'tarea', 'tareas')}`);
}
function setCourse(id) {
  S.ui.course = id;
  S.animate = true;
  renderDynamic();
}
function setDay(ts) {
  S.ui.day = S.ui.day === ts ? null : ts;
  if (S.ui.day !== null && S.ui.view !== 'pending') S.ui.view = 'pending';
  S.animate = true;
  renderDynamic();
  if (S.ui.day !== null) {
    const n = S.refs.list?.querySelectorAll('.row').length || 0;
    announce(`${T.formatWeekdayDate(ts)}: ${n} ${plural(n, 'entrega', 'entregas')}`);
  } else announce('Filtro de día quitado');
}

// Lo que se ve: las tareas dentro de la ventana de atrasadas elegida.
function visibleTasks(now) {
  const d = S.data;
  const minDue = now - (d.prefs.overdueDays || 30) * DAY;
  return d.tasks.filter((t) => t.due >= minDue);
}

function signature(now) {
  const d = S.data;
  const vis = visibleTasks(now);
  const sum = T.summarize(vis, d.done, now);
  return [T.startOfDay(now), sum.pending, sum.overdue, sum.today, sum.next?.id, sum.after?.id, vis.map((t) => t.id + T.bucketOf(t, now)).join(',')].join('|');
}

function restoreFocus(key) {
  const find = (k) => k && [...root.querySelectorAll(`[data-key="${CSS.escape(k)}"]`)].find((el) => el.getClientRects().length);
  const target = find(key) || find(S.focusNext) || S.refs.tasksH;
  target?.focus({ preventScroll: true });
}

function renderDynamic() {
  if (S.screen !== 'app' || !S.data || !S.refs.content) return;
  const now = Date.now();
  const d = S.data;
  const active = document.activeElement;
  const key = active && root.contains(active) ? active.closest?.('[data-key]')?.dataset.key : null;

  const vis = visibleTasks(now);
  const sum = T.summarize(vis, d.done, now);
  const doneCount = countDone(d);
  const loading = S.syncing && !d.lastSync && !S.demo;
  const allClear = !loading && sum.pending === 0 && (d.lastSync || S.demo);

  const courses = T.coursesFromTasks(T.pendingTasks(vis, d.done), d.courses).filter(
    (c) => c.count > 0 || (c.progress !== null && !c.hidden && !(c.enddate && c.enddate * 1000 < now)) || c.id === S.ui.course
  );
  if (S.ui.course !== null && !courses.some((c) => c.id === S.ui.course)) S.ui.course = null;

  document.title = sum.pending ? `(${sum.pending}) Tasques` : 'Tasques';
  S.refs.content.setAttribute('aria-busy', String(loading));

  const inGrades = S.ui.view === 'grades';
  r0().head.hidden = inGrades;
  if (!inGrades) renderHead(now, sum, { loading, allClear, doneCount });
  renderNav(sum, doneCount, courses);
  renderChips(sum, doneCount, courses);
  renderCrumb(courses);
  renderBanner();
  updateSyncPill(now);
  renderList(now);

  S.sig = signature(now);
  S.animate = false;
  if (key && !root.contains(document.activeElement)) restoreFocus(key);
  else if (S.focusNext && (document.activeElement === document.body || !document.activeElement)) restoreFocus(null);
  S.focusNext = null;
}

// Cada 30 s solo se actualizan textos; si cambia algo estructural, se vuelve a pintar.
function tick() {
  if (S.screen !== 'app' || !S.data || document.hidden) return;
  const now = Date.now();
  if (signature(now) !== S.sig) return renderDynamic();
  updateClock(now);
  root.querySelectorAll('[data-due]').forEach((el) => {
    const v = T.relative(Number(el.dataset.due), now);
    if (el.textContent !== v) el.textContent = v;
  });
  updateSyncPill(now);
  if (S.refs.clearMeta && S.data.lastSync) S.refs.clearMeta.textContent = `Última sincronización: ${T.relative(S.data.lastSync, now)}.`;
}

function statusLine(sum) {
  const pill = (key, cls, long, short, view) =>
    h('button', { type: 'button', class: 'pill ' + cls, dataset: { key: 'tally:' + key }, onclick: () => setView(view) }, h('span', { class: 'long', text: long }), h('span', { class: 'short', text: short }));
  const parts = [];
  if (sum.overdue) parts.push(pill('overdue', 'is-danger', `${sum.overdue} ${plural(sum.overdue, 'atrasada', 'atrasadas')}`, `${sum.overdue} ${plural(sum.overdue, 'atrasada', 'atrasadas')}`, 'overdue'));
  if (sum.today) parts.push(pill('today', 'is-warn', `${sum.today} para hoy`, `${sum.today} hoy`, 'today'));
  const rest = sum.thisWeek - sum.today;
  if (rest > 0) parts.push(pill('week', '', `${rest} ${sum.today ? 'más ' : ''}en los próximos 7 días`, `${rest} ${sum.today ? 'más ' : ''}en 7 días`, 'week'));
  const p = h('p', { class: 'status' });
  if (!parts.length) {
    if (sum.next) {
      const { day, time } = T.formatDueParts(sum.next.due, Date.now());
      p.append(`Tu próxima entrega es ${day === 'Hoy' || day === 'Mañana' ? day.toLowerCase() : 'el ' + day}, a las ${time}.`);
    }
    return p;
  }
  parts.forEach((el, i) => {
    if (i > 0) p.append(i === parts.length - 1 ? h('span', { class: 'status-glue', text: ' y ' }) : h('span', { class: 'status-glue c', text: ', ' }));
    p.append(el);
  });
  p.append(h('span', { class: 'status-glue c', text: '.' }));
  return p;
}

function renderHead(now, sum, { loading, allClear, doneCount }) {
  const r = S.refs;
  const d = S.data;
  const first = firstName(d.site);
  r.head.classList.toggle('is-clear', Boolean(allClear));
  r.clearMeta = null;

  if (loading) {
    r.h1 = h('h1', { class: 'is-loading', tabindex: '-1', dataset: { key: 'h1' }, text: 'Cargando tus tareas…' });
    mount(r.title, h('p', { class: 'eyebrow', text: capital(T.formatDay(now)) }), r.h1, h('span', { class: 'sk sk-pill' }));
    r.next.hidden = false;
    mount(r.next, h('div', { class: 'sk-next', 'aria-hidden': 'true' }, h('span', { class: 'sk', style: { width: '40%' } }), h('span', { class: 'sk', style: { width: '70%', height: '28px' } }), h('span', { class: 'sk', style: { width: '55%' } })));
    r.horizon.hidden = true;
    return;
  }

  if (allClear) {
    r.h1 = h('h1', { tabindex: '-1', dataset: { key: 'h1' }, text: first ? `Vía libre, ${first}.` : 'Vía libre.' });
    r.clearMeta = !S.demo && d.lastSync ? h('p', { class: 'clear-meta', text: `Última sincronización: ${T.relative(d.lastSync, now)}.` }) : null;
    mount(
      r.title,
      h('span', { class: 'clear-badge', 'aria-hidden': 'true' }, icon('check-circle', 'icon')),
      r.h1,
      h('p', { class: 'clear-sub', text: 'No te queda nada pendiente en Moodle.' }),
      r.clearMeta
    );
    r.next.hidden = true;
    r.horizon.hidden = true;
    return;
  }

  const count = h('span', { class: 'tnum', text: String(sum.pending) });
  r.h1 = h(
    'h1',
    { tabindex: '-1', dataset: { key: 'h1' } },
    first ? h('span', { class: 'hello', text: `Hola, ${first}. ` }) : null,
    sum.pending === 1 ? 'Te queda ' : 'Te quedan ',
    count,
    sum.pending === 1 ? ' tarea' : ' tareas'
  );
  mount(
    r.title,
    h('p', { class: 'eyebrow', text: capital(T.formatDay(now)) }),
    r.h1,
    statusLine(sum),
    S.syncing ? h('p', { class: 'syncing-m', text: 'Sincronizando…' }) : null
  );
  renderNext(sum.next, sum.after, now);
  renderHorizon(now);
}

function clockUnits(parts) {
  return parts.map(([v, u]) => {
    const s = String(v);
    return h('span', { class: 'unit', dataset: { u } }, h('b', { class: /\D/.test(s) ? 'wordy' : '', text: s }), h('span', { text: u }));
  });
}

function renderNext(t, after, now) {
  const el = S.refs.next;
  if (!t) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const cd = T.countdownParts(t.due, now);
  el.classList.toggle('is-soon', t.due - now < DAY);
  const [kindLabel, kindIcon] = T.kindOf(t.kind);
  const { day, time } = T.formatDueParts(t.due, now);
  S.refs.clock = h('div', { class: 'clock' + (cd.urgent ? ' is-urgent' : ''), role: 'timer', 'aria-label': cd.aria }, ...clockUnits(cd.parts));
  const actionLabel = t.actionName && t.actionName.length <= 28 ? `${t.actionName} en Moodle` : 'Abrir en Moodle';
  mount(
    el,
    h(
      'div',
      { class: 'next-label' },
      h('h2', { id: 'next-h' }, icon('clock-countdown', 'icon-xs'), 'Siguiente entrega'),
      h('span', { class: 'kind' }, icon(kindIcon, 'icon-xs'), t.kindLabel || kindLabel),
      t.url
        ? h('a', { class: 'btn btn-ghost next-open-m', href: t.url, target: '_blank', rel: 'noopener noreferrer', dataset: { key: 'next:open-m' } }, 'Abrir en Moodle', icon('arrow-up-right', 'icon-xs'), h('span', { class: 'sr', text: ' (se abre en otra pestaña)' }))
        : null
    ),
    h(
      'div',
      { class: 'next-grid' },
      S.refs.clock,
      h(
        'div',
        { class: 'next-body' },
        h('button', { type: 'button', class: 'next-title', lang: contentLang(), dataset: { key: 'next:title' }, onclick: (e) => openTask(t, e.currentTarget), text: t.title }),
        h('p', { class: 'next-meta' }, tag(t), h('span', { class: day === 'Hoy' ? 'is-today' : '', text: `${day}, ${time}` }))
      )
    ),
    after
      ? h('p', { class: 'after' }, h('span', { class: 'k', text: 'Después' }), h('span', { class: 't', lang: contentLang(), text: after.title }), h('time', { datetime: new Date(after.due).toISOString(), text: (({ day, time }) => `${day}, ${time}`)(T.formatDueParts(after.due, now)) }))
      : null,
    h(
      'div',
      { class: 'next-actions' },
      t.url
        ? h('a', { class: 'btn btn-outline', href: t.url, target: '_blank', rel: 'noopener noreferrer', dataset: { key: 'next:open' } }, icon('arrow-up-right', 'icon-sm'), actionLabel, h('span', { class: 'sr', text: ' (se abre en otra pestaña)' }))
        : null,
      h('button', { type: 'button', class: 'btn btn-ghost', dataset: { key: 'next:done' }, onclick: () => toggleDone(t, true, rowFor(t.id)) }, icon('check', 'icon-sm'), 'Marcar hecha')
    )
  );
}

function updateClock(now) {
  const el = S.refs.clock;
  if (!el || !el.isConnected) return;
  const sum = T.summarize(visibleTasks(now), S.data.done, now);
  if (!sum.next) return;
  const cd = T.countdownParts(sum.next.due, now);
  const units = [...el.querySelectorAll('.unit')];
  const same = units.length === cd.parts.length && units.every((u, i) => u.dataset.u === cd.parts[i][1]);
  if (!same) mount(el, ...clockUnits(cd.parts));
  else
    units.forEach((u, i) => {
      const b = u.querySelector('b');
      const v = String(cd.parts[i][0]);
      if (b.textContent !== v) {
        b.textContent = v;
        u.classList.remove('roll');
        void u.offsetWidth;
        u.classList.add('roll');
      }
    });
  el.setAttribute('aria-label', cd.aria);
  el.classList.toggle('is-urgent', cd.urgent);
}

function renderHorizon(now) {
  const el = S.refs.horizon;
  const d = S.data;
  const days = T.horizon(T.pendingTasks(visibleTasks(now), d.done), now, 14);
  const total = days.reduce((n, x) => n + x.tasks.length, 0);
  if (!total && S.ui.day === null) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const wd = new Intl.DateTimeFormat('es-ES', { weekday: 'narrow' });
  const anim = S.animate && !reduced();
  let k = 0;
  const today = T.startOfDay(now);
  mount(
    el,
    h('div', { class: 'horizon-head' }, h('h2', { id: 'hz-title', text: 'Próximas dos semanas' }), h('p', { text: `${total} ${plural(total, 'entrega', 'entregas')}` })),
    h(
      'ol',
      { class: 'days' },
      ...days.map((day) => {
        const dt = new Date(day.ts);
        const dow = dt.getDay();
        const n = day.tasks.length;
        const max = isMobile() ? 4 : 5;
        const shown = n > max ? day.tasks.slice(0, max - 1) : day.tasks;
        const isToday = day.ts === today;
        const label = `${T.formatWeekdayDate(day.ts)}: ${n ? `${n} ${plural(n, 'entrega', 'entregas')}` : 'sin entregas'}`;
        return h(
          'li',
          { class: dow === 1 && !isToday ? 'is-monday' : '' },
          h(
            'button',
            {
              type: 'button',
              class: 'day' + (isToday ? ' is-today' : '') + (dow === 0 || dow === 6 ? ' is-weekend' : ''),
              'aria-pressed': String(S.ui.day === day.ts),
              'aria-label': label,
              title: n ? `${capital(T.formatWeekdayDate(day.ts))}\n${day.tasks.map((t) => '· ' + t.title).join('\n')}` : capital(label),
              dataset: { key: 'day:' + day.ts },
              onclick: () => setDay(day.ts),
            },
            h(
              'span',
              { class: 'bars' + (anim ? ' anim' : ''), 'aria-hidden': 'true' },
              ...shown.map((t) => h('i', { class: 'bar', style: { '--h': String(hueOf(t.courseId)), '--d': String(Math.min(k++, 16)) } })),
              n > shown.length ? h('span', { class: 'more', text: `+${n - shown.length}` }) : null
            ),
            h('span', { class: 'day-label', 'aria-hidden': 'true' }, h('span', { class: 'wd', text: isToday ? 'hoy' : wd.format(day.ts) }), h('b', { text: String(dt.getDate()) }))
          )
        );
      })
    )
  );
}

const r0 = () => S.refs;

function newGradesCount(now = Date.now()) {
  const d = S.data;
  if (!d?.grades) return 0;
  return G.recentGrades(d.grades, Math.max(d.gradesSeenAt || 0, now - 14 * DAY), 99).length;
}

function viewCounts(sum, doneCount) {
  return { pending: sum.pending, overdue: sum.overdue, today: sum.today, week: sum.thisWeek, done: doneCount, grades: newGradesCount() };
}

function renderNav(sum, doneCount, courses) {
  const r = S.refs;
  const counts = viewCounts(sum, doneCount);
  mount(
    r.navViews,
    ...VIEWS.map(([id, label, ic]) => {
      const n = counts[id];
      return h(
        'li',
        {},
        h(
          'button',
          { type: 'button', 'aria-pressed': String(S.ui.view === id), dataset: { key: 'view:' + id }, onclick: () => setView(id) },
          icon(ic, 'icon-sm'),
          h('span', { class: 'label', text: label }),
          n || id === 'pending' ? h('span', { class: 'count' + (id === 'overdue' && n ? ' is-danger' : '') + (id === 'grades' ? ' is-new' : ''), title: id === 'grades' ? `${n} ${plural(n, 'nota nueva', 'notas nuevas')}` : null, text: String(n) }) : null
        )
      );
    })
  );
  if (!courses.length) return clear(r.navCourses);
  const pendingTotal = sum.pending;
  mount(
    r.navCourses,
    h('p', { class: 'side-label', text: 'Asignaturas' }),
    h(
      'ul',
      { class: 'nav' },
      h('li', {}, h('button', { type: 'button', 'aria-pressed': String(S.ui.course === null), dataset: { key: 'course:all' }, onclick: () => setCourse(null) }, icon('books', 'icon-sm'), h('span', { class: 'label', text: 'Todas' }), h('span', { class: 'count', text: String(pendingTotal) }))),
      ...courses.map((c) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'course',
              'aria-pressed': String(S.ui.course === c.id),
              dataset: { key: 'course:' + c.id },
              title: c.progress !== null ? `${c.name} · ${c.progress} % completado en Moodle` : c.name,
              onclick: () => setCourse(S.ui.course === c.id ? null : c.id),
            },
            h('span', { class: 'tag', style: { '--h': String(hueOf(c.id)) }, text: c.code || T.courseCode(c.short, c.name) }),
            h('span', { class: 'label', lang: contentLang(), text: c.name }),
            c.count ? h('span', { class: 'count', text: String(c.count) }) : null
          )
        )
      )
    )
  );
}

function renderChips(sum, doneCount, courses) {
  const r = S.refs;
  const counts = viewCounts(sum, doneCount);
  const short = { pending: 'Pendientes', overdue: 'Atrasadas', today: 'Hoy', week: '7 días', done: 'Hechas', grades: 'Notas' };
  const filters = activeFilterChips(courses);
  const sig = courses.map((c) => c.id + ':' + c.count).join('|') + '#' + S.ui.course;
  if (r.courseSelect.dataset.sig !== sig) {
    r.courseSelect.dataset.sig = sig;
    mount(
      r.courseSelect,
      h('option', { value: '', text: 'Todas' }),
      ...courses.map((c) => h('option', { value: String(c.id), text: `${c.code || T.courseCode(c.short, c.name)} · ${c.name}${c.count ? ` (${c.count})` : ''}` }))
    );
  }
  r.courseSelect.value = S.ui.course === null ? '' : String(S.ui.course);
  const selCourse = courses.find((c) => c.id === S.ui.course);
  const keepScroll = r.chips.scrollLeft;
  mount(
    r.chips,
    ...filters,
    ...VIEWS.filter(([id]) => counts[id] || id === 'pending' || id === S.ui.view || (id === 'grades' && S.data.grades)).map(([id]) =>
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(S.ui.view === id), dataset: { key: 'chip:' + id }, onclick: () => setView(id) }, short[id], id !== 'grades' || counts[id] ? h('span', { class: 'num', text: String(counts[id]) }) : null)
    ),
    courses.length
      ? h('label', { class: 'chip-select' }, h('span', { class: 'chip' + (selCourse ? ' is-on' : ''), 'aria-hidden': 'true' }, selCourse ? selCourse.code || T.courseCode(selCourse.short, selCourse.name) : 'Asignatura', icon('caret-down', 'icon-xs')), r.courseSelect)
      : null
  );
  r.chips.scrollLeft = keepScroll;
  const on = r.chips.querySelector('.chip[aria-pressed="true"]');
  if (on && r.chips.clientWidth) {
    const a = on.offsetLeft - r.chips.offsetLeft;
    if (a < r.chips.scrollLeft || a + on.offsetWidth > r.chips.scrollLeft + r.chips.clientWidth) r.chips.scrollLeft = a - 16;
  }
}

function activeFilterChips(courses) {
  const out = [];
  const course = courses.find((c) => c.id === S.ui.course);
  if (course) out.push(h('span', { class: 'fchip' }, h('span', { class: 't', text: `${course.code || T.courseCode(course.short, course.name)} · ${course.name}` }), h('button', { type: 'button', 'aria-label': `Quitar el filtro ${course.name}`, dataset: { key: 'filter:course' }, onclick: () => setCourse(null) }, icon('x', 'icon-xs'))));
  if (S.ui.day !== null) out.push(h('span', { class: 'fchip' }, h('span', { class: 't', text: T.formatShortDay(S.ui.day) }), h('button', { type: 'button', 'aria-label': 'Quitar el filtro de día', dataset: { key: 'filter:day' }, onclick: () => setDay(S.ui.day) }, icon('x', 'icon-xs'))));
  return out;
}

function renderCrumb(courses) {
  const r = S.refs;
  mount(r.crumb, h('p', { class: 'view-name', text: VIEW_LABEL[S.ui.view] }), ...activeFilterChips(courses));
}

function updateSyncPill(now) {
  const el = S.refs.sync;
  if (!el) return;
  const d = S.data;
  let ic = 'cloud-check';
  let text;
  let cls = 'sync';
  if (S.syncing) {
    ic = 'arrows-clockwise';
    text = 'Sincronizando';
    el.setAttribute('aria-disabled', 'true');
  } else {
    el.removeAttribute('aria-disabled');
    if (S.error) {
      ic = 'cloud-slash';
      text = 'Sin conexión';
      cls += ' is-error';
    } else if (S.demo) text = 'Ejemplo';
    else if (d.lastSync) text = capital(T.relative(d.lastSync, now));
    else text = 'Sin sincronizar';
  }
  el.className = cls;
  el.title = d.lastSync && !S.demo ? `Última sincronización: ${T.formatLongDate(d.lastSync)}` : 'Sincronizar';
  el.setAttribute('aria-label', S.syncing ? 'Sincronizando con Moodle' : 'Sincronizar ahora');
  const want = `${ic}|${text}`;
  if (el.dataset.state !== want) {
    el.dataset.state = want;
    mount(el, icon(ic, 'icon-sm' + (S.syncing ? ' spin' : '')), h('span', { class: 'sync-text', text }));
  }
}

function renderBanner() {
  const e = S.error;
  const r = S.refs;
  if (!e) {
    r.bannerFor = null;
    return clear(r.banner);
  }
  const d = S.data;
  const rel = d.lastSync ? T.relative(d.lastSync, Date.now()) : '';
  const subText = !d.lastSync ? 'Aún no se ha podido descargar nada.' : rel === 'ahora' ? 'Mientras tanto ves la última copia.' : `Mientras tanto ves la copia de ${rel}.`;
  if (r.bannerFor === e && r.banner.firstChild) {
    const sub = r.banner.querySelector('.sub');
    if (sub) sub.textContent = subText;
    return;
  }
  r.bannerFor = e;
  const expired = e.code === 'invalidtoken' || e.code === 'accessexception';
  const site = ['sitepolicynotagreed', 'usernotfullysetup', 'passwordisexpired'].includes(e.code);
  let action;
  if (expired) action = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openReconnect() }, icon('key', 'icon-sm'), 'Reconectar');
  else if (site) action = h('a', { class: 'btn btn-primary', href: d.site.url, target: '_blank', rel: 'noopener noreferrer' }, icon('arrow-up-right', 'icon-sm'), 'Abrir Moodle');
  else action = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => sync() }, icon('arrow-counter-clockwise', 'icon-sm'), 'Reintentar');
  mount(
    r.banner,
    h(
      'div',
      { class: 'alert alert-error', role: 'alert' },
      icon('warning-circle', 'icon'),
      h(
        'div',
        { class: 'alert-body' },
        h('p', { class: 'msg', text: e.message }),
        h('p', { class: 'sub', text: subText }),
        h('div', { class: 'alert-actions' }, action)
      )
    )
  );
}

function skeletonList() {
  return h(
    'div',
    { class: 'group', 'aria-hidden': 'true' },
    h('div', { class: 'group-head' }, h('span', { class: 'sk', style: { width: '90px' } })),
    h(
      'div',
      { class: 'rows' },
      ...[60, 45, 70, 52, 66, 40].map((w) =>
        h('div', { class: 'sk-row' }, h('span', { class: 'sk c' }), h('span', { class: 'lines' }, h('span', { class: 'sk', style: { width: w + '%' } }), h('span', { class: 'sk', style: { width: '30%', height: '10px' } })), h('span', { class: 'sk', style: { width: '48px' } }))
      )
    )
  );
}

function emptyState(title, body, { tone = 'neutral', ic = 'tray', action = null } = {}) {
  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'empty-icon' + (tone === 'ok' ? ' is-ok' : ''), 'aria-hidden': 'true' }, icon(ic, 'icon')),
    h('h3', { text: title }),
    body ? h('p', { text: body }) : null,
    action
  );
}

// Lo que sale en Hechas: marcas propias de tareas que siguen en la lista y lo que ya no aparece en Moodle (sin repetir).
function countDone(d) {
  const ids = new Set(d.tasks.filter((t) => d.done[t.id]).map((t) => t.id));
  d.history.forEach((x) => {
    if (x.how !== 'expired') ids.add(x.id);
  });
  return ids.size;
}

function rowFor(id) {
  return root.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
}

function renderList(now = Date.now()) {
  const d = S.data;
  const r = S.refs;
  if (!d || !r.list) return;
  const anim = S.animate && !reduced();
  const { view, course, day } = S.ui;
  const query = (S.ui.query || '').trim();
  const loading = S.syncing && !d.lastSync && !S.demo;
  if (view === 'grades') return renderGrades(now);
  if (loading) return mount(r.list, skeletonList());

  if (view === 'done') {
    const manual = d.tasks.filter((t) => d.done[t.id]).map((t) => ({ ...t, completedAt: d.done[t.id], how: 'manual' }));
    const manualIds = new Set(manual.map((t) => t.id));
    let items = [...manual, ...d.history.filter((x) => !manualIds.has(x.id))];
    items = T.filterTasks(items, { view: 'all', course, query }, now).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    if (!items.length) {
      if (query) return mount(r.list, emptyState('Sin resultados', `Nada coincide con «${query}».`, { ic: 'magnifying-glass', action: h('button', { type: 'button', class: 'btn btn-outline', onclick: () => setQuery(''), text: 'Borrar búsqueda' }) }));
      return mount(r.list, emptyState('Todavía no hay nada aquí', 'Cuando marques una tarea o desaparezca de Moodle, aparecerá aquí.', { ic: 'check-circle' }));
    }
    const groups = [
      ['manual', 'Marcadas por ti'],
      ['gone', 'Ya no aparecen en Moodle'],
      ['expired', 'Plazo cerrado'],
    ];
    let k = 0;
    return mount(
      r.list,
      ...groups
        .map(([how, label]) => {
          const g = items.filter((x) => x.how === how);
          if (!g.length) return null;
          return h('section', { class: 'group', dataset: { bucket: how } }, h('div', { class: 'group-head' }, h('h3', { text: label }), h('span', { class: 'cnt', text: String(g.length) })), h('ul', { class: 'rows' }, ...g.map((t) => taskRow(t, now, k++, { how, anim }))));
        })
        .filter(Boolean)
    );
  }

  const minDue = now - (d.prefs.overdueDays || 30) * DAY;
  const items = T.filterTasks(d.tasks, { done: d.done, view, course, query, day, minDue }, now);
  if (!items.length) {
    const clearBtn = (label, fn) => h('button', { type: 'button', class: 'btn btn-outline', onclick: fn, text: label });
    if (query) return mount(r.list, emptyState('Sin resultados', `Nada coincide con «${query}».`, { ic: 'magnifying-glass', action: clearBtn('Borrar búsqueda', () => setQuery('')) }));
    if (day !== null) return mount(r.list, emptyState(`Nada para el ${T.formatWeekdayDate(day)}`, 'Ese día no tienes entregas.', { ic: 'calendar-blank', action: clearBtn('Quitar filtro', () => setDay(day)) }));
    if (course !== null) {
      const c = d.courses.find((x) => Number(x.id) === course);
      return mount(r.list, emptyState(`Sin entregas abiertas en ${c ? textOf(c.fullname, 120) : 'esta asignatura'}`, '', { tone: 'ok', ic: 'check-circle', action: clearBtn('Ver todas', () => setCourse(null)) }));
    }
    if (!d.lastSync && !S.demo) return mount(r.list, emptyState('Aún no hay datos', 'Sincroniza para traer tus tareas de Moodle.', { ic: 'arrows-clockwise', action: h('button', { type: 'button', class: 'btn btn-primary', onclick: () => sync(), text: 'Sincronizar' }) }));
    if (view === 'overdue') return mount(r.list, emptyState('Nada atrasado', 'Vas al día.', { tone: 'ok', ic: 'check-circle', action: clearBtn('Ver pendientes', () => setView('pending')) }));
    if (view === 'today') return mount(r.list, emptyState('Nada para hoy', 'Hoy no vence ninguna entrega.', { tone: 'ok', ic: 'check-circle', action: clearBtn('Ver pendientes', () => setView('pending')) }));
    if (view === 'week') {
      const sum = T.summarize(visibleTasks(now), d.done, now);
      return mount(r.list, emptyState('Nada en los próximos 7 días', sum.next ? `Tu próxima entrega es el ${T.formatDue(sum.next.due, now).toLowerCase()}.` : '', { tone: 'ok', ic: 'check-circle' }));
    }
    const doneCount = countDone(d);
    return mount(r.list, doneCount ? h('div', { class: 'empty' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => setView('done') }, icon('check-circle', 'icon-sm'), `Ver hechas (${doneCount})`)) : clear(h('div')));
  }

  let k = 0;
  const groups = T.groupByBucket(items, now);
  mount(
    r.list,
    ...groups.map((g) =>
      h(
        'section',
        { class: 'group', dataset: { bucket: g.id } },
        h(
          'div',
          { class: 'group-head' },
          h('h3', {}, g.id === 'overdue' ? icon('warning-circle', 'icon-xs') : null, g.label),
          h('span', { class: 'cnt', text: String(g.tasks.length) }),
          g.id === 'today' ? h('span', { class: 'sub', text: capital(T.formatDay(now)) }) : g.id === 'tomorrow' ? h('span', { class: 'sub', text: capital(T.formatDay(now + DAY)) }) : null
        ),
        h('ul', { class: 'rows' }, ...g.tasks.map((t) => taskRow(t, now, k++, { anim })))
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Notas
// ---------------------------------------------------------------------------

function gradeValue(formatted, max, pct, cls = '') {
  const tone = G.gradeTone(pct);
  return h(
    'span',
    { class: 'gval ' + cls + (tone ? ' is-' + tone : '') },
    h('b', { class: 'tnum', text: formatted || '-' }),
    max && /^\d/.test(formatted || '') ? h('span', { class: 'gmax', text: `/${String(max).replace('.', ',')}` }) : null
  );
}

function gradeBar(pct, cid) {
  return h('span', { class: 'gbar', 'aria-hidden': 'true' }, h('span', { class: 'gfill', style: { '--h': String(hueOf(cid)), '--p': String(typeof pct === 'number' ? pct : 0) } }));
}

function courseOf(cid) {
  const c = (S.data?.courses || []).find((x) => Number(x.id) === Number(cid));
  const t = (S.data?.tasks || []).find((x) => x.courseId === Number(cid));
  const name = c?.fullname || t?.courseName || 'Asignatura';
  const short = c?.shortname || t?.courseShort || '';
  return { id: Number(cid), name, short, code: T.courseCode(short, name), progress: typeof c?.progress === 'number' ? Math.round(c.progress) : null };
}

function courseTag(cid) {
  const c = courseOf(cid);
  return h('span', { class: 'tag', title: c.name, lang: contentLang(), style: { '--h': String(hueOf(cid)) }, text: c.code });
}

function renderGrades(now) {
  const d = S.data;
  const r = S.refs;
  const g = d.grades;
  const lang = contentLang();
  const query = T.fold ? T.fold((S.ui.query || '').trim()) : (S.ui.query || '').trim().toLowerCase();
  if (!g) {
    if (S.syncing) return mount(r.list, h('div', { class: 'grades' }, gradesHead(null, 0), skeletonList()));
    return mount(r.list, h('div', { class: 'grades' }, gradesHead(null, 0), emptyState('Aún no hay notas', 'Sincroniza para traer tus calificaciones de Moodle.', { ic: 'chart-bar', action: h('button', { type: 'button', class: 'btn btn-primary', onclick: () => sync(), text: 'Sincronizar' }) })));
  }
  let sums = G.courseSummaries(g, d.courses);
  if (S.ui.course !== null) sums = sums.filter((c) => c.id === S.ui.course);
  if (query) sums = sums.filter((c) => T.fold(`${courseOf(c.id).name} ${courseOf(c.id).code} ${c.items.map((i) => i.name).join(' ')}`).includes(query));
  const avg = G.averagePct(sums);
  const seenBefore = S.gradesSeenBefore ?? d.gradesSeenAt ?? 0;
  const recent = G.recentGrades({ courses: Object.fromEntries(sums.map((c) => [c.id, { items: c.items }])) }, now - 21 * DAY, 6);
  const newCount = recent.filter((i) => i.graded > seenBefore).length;

  if (!sums.length) {
    const msg = g.error
      ? emptyState('Tu centro no comparte las notas con la app', 'Puedes verlas en la web de Moodle, en Calificaciones.', { ic: 'chart-bar', action: d.site.url && !S.demo ? h('a', { class: 'btn btn-outline', href: `${d.site.url}/grade/report/overview/index.php`, target: '_blank', rel: 'noopener noreferrer' }, icon('arrow-up-right', 'icon-sm'), 'Abrir en Moodle') : null })
      : query
        ? emptyState('Sin resultados', `Ninguna nota coincide con «${S.ui.query.trim()}».`, { ic: 'magnifying-glass', action: h('button', { type: 'button', class: 'btn btn-outline', onclick: () => setQuery(''), text: 'Borrar búsqueda' }) })
        : emptyState('Aún no tienes notas', 'Cuando el profesorado califique algo, aparecerá aquí.', { ic: 'chart-bar' });
    return mount(r.list, h('div', { class: 'grades' }, gradesHead(null, 0), msg));
  }

  const anim = S.animate && !reduced();
  // Media y gráfico por asignatura
  const sorted = [...sums].filter((c) => typeof c.pct === 'number').sort((a, b) => b.pct - a.pct);
  const chart = h(
    'section',
    { class: 'gcard g-avg', 'aria-labelledby': 'g-avg-h' },
    h('div', { class: 'g-avg-top' }, h('div', {}, h('h2', { id: 'g-avg-h', class: 'gcard-h', text: 'Media' }), h('p', { class: 'g-avg-sub', text: `de ${sums.length} ${plural(sums.length, 'asignatura', 'asignaturas')}` })), avg !== null ? gradeValue(G.outOfTen(avg), 10, avg, 'is-xl') : h('span', { class: 'g-na', text: 'Sin media numérica' })),
    sorted.length
      ? h(
          'ul',
          { class: 'g-bars' + (anim ? ' anim' : '') },
          ...sorted.map((c, i) =>
            h(
              'li',
              {},
              h(
                'button',
                { type: 'button', class: 'g-barrow', dataset: { key: 'gbar:' + c.id }, onclick: () => openCourseGrades(c.id), 'aria-label': `${courseOf(c.id).name}: ${c.formatted}` },
                courseTag(c.id),
                h('span', { class: 'g-track' }, h('span', { class: 'g-fill', style: { '--h': String(hueOf(c.id)), '--p': String(c.pct), '--i': String(i) } })),
                h('span', { class: 'g-num tnum' + (G.gradeTone(c.pct) === 'low' ? ' is-low' : ''), text: G.outOfTen(c.pct) })
              )
            )
          )
        )
      : null
  );
  const recentCard = h(
    'section',
    { class: 'gcard g-recent', 'aria-labelledby': 'g-rec-h' },
    h('h2', { id: 'g-rec-h', class: 'gcard-h' }, 'Últimas notas', newCount ? h('span', { class: 'g-new', text: `${newCount} ${plural(newCount, 'nueva', 'nuevas')}` }) : null),
    recent.length
      ? h(
          'ul',
          { class: 'g-rlist' },
          ...recent.map((it) =>
            h(
              'li',
              {},
              h(
                'button',
                { type: 'button', class: 'g-ritem', dataset: { key: 'gitem:' + it.courseId + ':' + it.id }, onclick: () => openCourseGrades(it.courseId, it.id) },
                gradeValue(it.formatted, it.max, it.pct, 'is-chip'),
                h('span', { class: 'g-rmain' }, h('span', { class: 'g-rname', lang, text: it.name }), h('span', { class: 'g-rmeta' }, courseTag(it.courseId), h('span', { text: T.relative(it.graded, now) }), it.graded > seenBefore ? h('span', { class: 'badge is-accent', text: 'Nueva' }) : null))
              )
            )
          )
        )
      : h('p', { class: 'g-empty', text: 'Nada calificado en las últimas tres semanas.' })
  );

  const cards = h(
    'div',
    { class: 'g-grid' },
    ...sums.map((c, i) => {
      const info = courseOf(c.id);
      return h(
        'button',
        { type: 'button', class: 'g-course' + (anim ? ' anim' : ''), style: { '--h': String(hueOf(c.id)), '--i': String(i) }, dataset: { key: 'gcourse:' + c.id }, onclick: () => openCourseGrades(c.id) },
        h('span', { class: 'g-chead' }, courseTag(c.id), h('span', { class: 'g-cname', lang, text: info.name })),
        h('span', { class: 'g-cval' }, gradeValue(c.formatted, c.max, c.pct, 'is-lg'), h('span', { class: 'g-cnote', text: 'nota del curso' })),
        gradeBar(c.pct, c.id),
        h('span', { class: 'g-cmeta' }, `${c.gradedCount} ${plural(c.gradedCount, 'calificación', 'calificaciones')}`, c.last ? ` · última ${T.relative(c.last, now)}` : '', info.progress !== null ? ` · ${info.progress} % completado` : '')
      );
    })
  );

  mount(r.list, h('div', { class: 'grades' }, gradesHead(avg, newCount), h('div', { class: 'g-top' }, chart, recentCard), h('div', { class: 'group-head g-gh' }, h('h3', { text: 'Asignaturas' }), h('span', { class: 'cnt', text: String(sums.length) })), cards));
}

function gradesHead(avg, newCount) {
  const d = S.data;
  const now = Date.now();
  const h1 = h('h1', { tabindex: '-1', dataset: { key: 'h1' }, text: 'Tus notas' });
  S.refs.h1 = h1;
  const bits = [];
  if (avg !== null && avg !== undefined) bits.push(h('span', {}, 'Media de ', h('b', { class: 'tnum', text: G.outOfTen(avg) }), ' sobre 10'));
  if (newCount) bits.push(h('span', { class: 'pill is-accent', text: `${newCount} ${plural(newCount, 'nueva', 'nuevas')}` }));
  if (d.grades?.at && !S.demo) bits.push(h('span', { class: 'g-at', text: `Actualizadas ${T.relative(d.grades.at, now)}` }));
  return h('div', { class: 'g-head' }, h('p', { class: 'eyebrow', text: capital(T.formatDay(now)) }), h1, bits.length ? h('p', { class: 'g-status' }, ...bits) : null);
}

function openCourseGrades(cid, focusItem = null) {
  const d = S.data;
  const g = d?.grades?.courses?.[cid];
  if (!g) return;
  const info = courseOf(cid);
  const lang = contentLang();
  const now = Date.now();
  const total = g.total || {};
  const items = [...(g.items || [])].sort((a, b) => (b.graded || 0) - (a.graded || 0) || a.name.localeCompare(b.name, 'es'));
  const link = d.site.url && !S.demo ? `${d.site.url}/grade/report/user/index.php?id=${encodeURIComponent(cid)}` : null;
  openDialog(
    (close) =>
      h(
        'div',
        { class: 'sheet-wrap', style: { display: 'contents' } },
        h('div', { class: 'dlg-head' }, h('div', { class: 'sheet-course' }, courseTag(cid), h('span', { lang, text: info.name })), h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Cerrar', onclick: close }, icon('x', 'icon-sm'))),
        h(
          'div',
          { class: 'sheet-body' },
          h('p', { class: 'sheet-kind' }, icon('chart-bar', 'icon-xs'), 'Notas de la asignatura'),
          h('h2', { class: 'sheet-title', tabindex: '-1', lang, text: info.name }),
          h(
            'div',
            { class: 'g-total', style: { '--h': String(hueOf(cid)) } },
            h('div', { class: 'g-total-top' }, h('span', { class: 'g-total-k', text: 'Nota del curso' }), gradeValue(total.formatted || '', total.max, total.pct, 'is-xl')),
            gradeBar(total.pct, cid),
            info.progress !== null ? h('p', { class: 'g-total-sub', text: `${info.progress} % de la asignatura completado en Moodle` }) : null
          ),
          items.length
            ? h(
                'ul',
                { class: 'g-items' },
                ...items.map((it) =>
                  h(
                    'li',
                    { class: 'g-item' + (focusItem === it.id ? ' is-focus' : ''), dataset: { item: String(it.id) } },
                    h(
                      'div',
                      { class: 'g-item-top' },
                      h('span', { class: 'g-iname', lang }, icon(T.kindOf(it.module)[1], 'icon-xs'), h('span', { text: it.name })),
                      gradeValue(it.formatted, it.max, it.pct)
                    ),
                    it.formatted ? gradeBar(it.pct, cid) : null,
                    h('p', { class: 'g-imeta' }, it.graded ? `Calificada ${T.relative(it.graded, now)}` : 'Sin calificar', it.weight ? ` · pesa ${it.weight}` : ''),
                    it.feedback ? h('p', { class: 'g-ifb', lang }, icon('chat-text', 'icon-xs'), h('span', { text: it.feedback })) : null
                  )
                )
              )
            : h('p', { class: 'g-empty', text: 'Esta asignatura aún no tiene calificaciones.' }),
          link ? h('a', { class: 'btn btn-outline btn-lg btn-block', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('arrow-up-right', 'icon-sm'), 'Ver en Moodle', h('span', { class: 'sr', text: ' (se abre en otra pestaña)' })) : null
        )
      ),
    { cls: 'sheet' }
  );
  setTimeout(() => {
    const el = focusItem && document.querySelector(`dialog.sheet .g-item[data-item="${focusItem}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
    document.querySelector('dialog.sheet .sheet-title')?.focus({ preventScroll: Boolean(el) });
  }, 30);
}

// Marcar como hecha: sello, tachado, colapso y luego se vuelve a pintar.
function nextFocusKey(li) {
  const sib = li.nextElementSibling || li.previousElementSibling;
  return sib?.querySelector('[data-key^="check:"]')?.dataset.key || null;
}

function collapse(li) {
  const hgt = li.getBoundingClientRect().height;
  li.style.setProperty('height', hgt + 'px');
  void li.offsetHeight;
  li.classList.add('is-collapsing');
  li.style.setProperty('height', '0px');
  li.style.setProperty('padding-top', '0px');
  li.style.setProperty('padding-bottom', '0px');
  li.style.setProperty('min-height', '0px');
  li.style.setProperty('opacity', '0');
}

function toggleDone(t, done, li) {
  const d = S.data;
  if (!d) return;
  if (li && li.isConnected) S.focusNext = nextFocusKey(li);
  const timers = [];
  if (done) d.done[t.id] = Date.now();
  else delete d.done[t.id];
  persist();
  const apply = () => {
    if (S.data !== d) return;
    S.animate = false;
    renderDynamic();
  };
  const fast = reduced() || !li || !li.isConnected;
  if (fast) apply();
  else if (done) {
    li.classList.add('is-stamping');
    timers.push(setTimeout(() => collapse(li), 420));
    timers.push(setTimeout(apply, 740));
  } else {
    collapse(li);
    timers.push(setTimeout(apply, 320));
  }
  if (!done) {
    announce('Vuelve a estar pendiente');
    return;
  }
  announce('Marcada como hecha');
  let first = false;
  try {
    first = !S.seenCheck && !storage.getItem('mt.seen.check');
    S.seenCheck = true;
    if (first && !S.demo) storage.setItem('mt.seen.check', '1');
  } catch {
    /* nada */
  }
  const undo = () => {
    timers.forEach(clearTimeout);
    const cur = S.data;
    if (!cur) return;
    delete cur.done[t.id];
    persist();
    S.animate = false;
    renderDynamic();
  };
  if (first) toast('Marcada solo en Tasques. Para entregarla, ábrela en Moodle.', { icon: 'check-circle', action: { label: 'Deshacer', fn: undo }, timeout: 9000 });
  else
    toast(isMobile() ? 'Hecha' : 'Marcada como hecha', {
      key: 'done',
      icon: 'check-circle',
      merge: (n) => `${n} marcadas como hechas`,
      action: { label: 'Deshacer', fn: undo },
    });
}

// ---------------------------------------------------------------------------
// Panel de detalle de una tarea
// ---------------------------------------------------------------------------

// Datos extra de Moodle para una tarea: { a: tarea, sub: tu entrega, q: cuestionario }
function taskDetails(t) {
  const x = S.data?.details || {};
  const id = t.instance || t.cmid;
  if (!id) return {};
  if (t.kind === 'assign') return { a: x.assign?.[id], sub: x.sub?.[id] };
  if (t.kind === 'quiz') return { q: x.quiz?.[id] };
  return {};
}

const SUB_LABEL = { new: 'Sin entregar', draft: 'Borrador guardado, aún sin enviar', submitted: 'Entregada', reopened: 'Reabierta: puedes volver a entregar' };

function detailFacts(t, now) {
  const { a, sub, q } = taskDetails(t);
  const out = [];
  const fact = (k, ...v) => out.push(h('dt', { text: k }), h('dd', {}, ...v));
  if (sub?.status) {
    fact(
      'Tu entrega',
      h('span', { class: 'sub-status is-' + sub.status }, icon(sub.status === 'draft' ? 'pencil-simple-line' : sub.status === 'submitted' ? 'check-circle' : sub.status === 'reopened' ? 'repeat' : 'upload-simple', 'icon-xs'), SUB_LABEL[sub.status]),
      sub.modified ? h('span', { class: 'fact-sub', text: ` · editada ${T.relative(sub.modified, now)}` }) : null
    );
  }
  if (sub?.extension) fact('Prórroga hasta', capital(T.formatLongDate(sub.extension)));
  if (a?.cutoff && a.cutoff > t.due) fact('Se acepta hasta', capital(T.formatLongDate(a.cutoff)), h('span', { class: 'fact-sub', text: ' (con retraso)' }));
  if (a?.opens && a.opens > now) fact('Se abre', capital(T.formatLongDate(a.opens)));
  if (a?.maxGrade) fact('Nota máxima', `${a.maxGrade} ${a.maxGrade === 1 ? 'punto' : 'puntos'}`);
  if (a?.files) fact('Material', `${a.files} ${plural(a.files, 'archivo adjunto', 'archivos adjuntos')} en Moodle`);
  if (q) {
    if (q.opens && q.opens > now) fact('Se abre', capital(T.formatLongDate(q.opens)));
    if (q.timeLimit) fact('Tiempo', `${Math.round(q.timeLimit / 60)} min para hacerlo`);
    if (q.attempts !== null && q.attempts !== undefined) fact('Intentos', q.attempts === 0 ? 'Sin límite' : String(q.attempts));
    if (q.maxGrade) fact('Nota máxima', String(q.maxGrade).replace('.', ','));
  }
  return out;
}

function openTask(t, opener, how = null) {
  const d = S.data;
  if (!d) return;
  const now = Date.now();
  const manual = Boolean(d.done[t.id]);
  const inHistory = how === 'gone' || how === 'expired';
  const bucket = T.bucketOf(t, now);
  const [kindLabel, kindIcon] = T.kindOf(t.kind);
  const course = d.courses.find((c) => Number(c.id) === t.courseId);
  const progress = course && typeof course.progress === 'number' ? Math.round(course.progress) : null;
  const lang = contentLang();

  let chip;
  if (inHistory) chip = h('span', { class: 'state-chip' }, icon(how === 'expired' ? 'x-circle' : 'info', 'icon-xs'), how === 'expired' ? 'Plazo cerrado' : 'Ya no aparece en Moodle');
  else if (manual) chip = h('span', { class: 'state-chip is-ok' }, icon('check-circle', 'icon-xs'), 'Marcada como hecha');
  else if (t.actionable === false) chip = h('span', { class: 'state-chip' }, bucket === 'overdue' ? 'Ya no admite entregas' : 'Aún no está abierto');
  else if (bucket === 'overdue') chip = h('span', { class: 'state-chip is-danger' }, icon('warning-circle', 'icon-xs'), `Atrasada · ${T.relative(t.due, now)}`);
  else if (bucket === 'today') chip = h('span', { class: 'state-chip is-warn' }, icon('hourglass-medium', 'icon-xs'), `Hoy · ${T.relative(t.due, now)}`);
  else chip = h('span', { class: 'state-chip' }, icon('calendar-blank', 'icon-xs'), capital(T.relative(t.due, now)));

  const past = t.due < now;
  const facts = h(
    'dl',
    { class: 'facts' },
    h('dt', { text: 'Fecha límite' }),
    h('dd', {}, h('time', { datetime: new Date(t.due).toISOString(), text: capital(T.formatLongDate(t.due)) })),
    inHistory ? null : h('dt', { text: past ? 'Venció hace' : 'Queda' }),
    inHistory ? null : h('dd', {}, h('b', { text: T.durationText(Math.abs(t.due - now)) })),
    h('dt', { text: 'Asignatura' }),
    h(
      'dd',
      {},
      h('span', { lang, text: t.courseName }),
      progress !== null
        ? h('div', { class: 'progress' }, h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'fill', style: { '--h': String(hueOf(t.courseId)), '--p': String(progress / 100) } })), `${progress} % del curso completado en Moodle`)
        : null
    ),
    t.actionName ? h('dt', { text: 'En Moodle' }) : null,
    t.actionName ? h('dd', { lang, text: t.actionName }) : null,
    ...detailFacts(t, now)
  );
  const det = taskDetails(t);
  const feedbackBlock =
    det.sub && (det.sub.grade || det.sub.feedback)
      ? h(
          'div',
          { class: 'graded-box' },
          h('p', { class: 'graded-top' }, icon('seal-check', 'icon-sm'), 'Calificada', det.sub.grade ? h('b', { class: 'tnum', text: det.sub.grade }) : null),
          det.sub.feedback ? h('p', { class: 'graded-fb', lang, text: det.sub.feedback }) : null
        )
      : null;

  openDialog(
    (close) => {
      const actionLabel = t.actionName && t.actionName.length <= 28 ? `${t.actionName} en Moodle` : 'Abrir en Moodle';
      const doneBtn = inHistory
        ? null
        : manual
          ? h('button', { type: 'button', class: 'btn btn-outline btn-lg', onclick: () => { close(); toggleDone(t, false, null); } }, icon('arrow-counter-clockwise', 'icon-sm'), 'Volver a pendientes')
          : h('button', { type: 'button', class: 'btn btn-outline btn-lg', onclick: () => { close(); setTimeout(() => toggleDone(t, true, rowFor(t.id)), 170); } }, icon('check', 'icon-sm'), 'Marcar hecha');
      const icsBtn = h('button', { type: 'button', class: 'btn btn-outline btn-lg', onclick: () => exportIcs([t], `tasques-${String(t.id).replace(/[^a-z0-9-]/gi, '')}.ics`) }, icon('calendar-plus', 'icon-sm'), 'Al calendario');
      return h(
        'div',
        { class: 'sheet-wrap', style: { display: 'contents' } },
        h('div', { class: 'dlg-head' }, h('div', { class: 'sheet-course' }, tag(t), h('span', { lang, text: t.courseName })), h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Cerrar', onclick: close }, icon('x', 'icon-sm'))),
        h(
          'div',
          { class: 'sheet-body' },
          h('p', { class: 'sheet-kind' }, icon(kindIcon, 'icon-xs'), t.kindLabel || kindLabel),
          h('h2', { class: 'sheet-title', tabindex: '-1', lang, text: t.title }),
          chip,
          feedbackBlock,
          facts,
          t.description ? h('div', { class: 'desc' }, h('h3', { text: 'Descripción' }), h('p', { lang, text: t.description })) : null,
          h(
            'div',
            { class: 'sheet-actions' },
            t.url ? h('a', { class: 'btn btn-primary btn-lg btn-block', href: t.url, target: '_blank', rel: 'noopener noreferrer' }, icon('arrow-up-right', 'icon-sm'), actionLabel, h('span', { class: 'sr', text: ' (se abre en otra pestaña)' })) : null,
            h('div', { class: 'two' }, doneBtn, icsBtn)
          ),
          inHistory ? null : h('p', { class: 'sheet-note' }, icon('info', 'icon-xs'), h('span', { text: 'Marcarla aquí solo cambia tu lista. Para entregarla tienes que hacerlo en Moodle.' }))
        )
      );
    },
    { cls: 'sheet' }
  );
  setTimeout(() => document.querySelector('dialog.sheet .sheet-title')?.focus(), 30);
}

// ---------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------

function slimCourses(list) {
  return (list || []).map((c) => ({
    id: Number(c.id),
    fullname: textOf(c.fullname || c.displayname, 200),
    shortname: textOf(c.shortname, 60),
    progress: typeof c.progress === 'number' ? c.progress : null,
    hidden: Boolean(c.hidden),
    enddate: Number(c.enddate) || 0,
    completed: Boolean(c.completed),
  }));
}

async function sync() {
  if (S.syncing || !S.data) return;
  if (S.demo) {
    S.syncing = true;
    updateSyncPill(Date.now());
    await new Promise((r) => setTimeout(r, 600));
    if (!S.demo) return;
    S.syncing = false;
    updateSyncPill(Date.now());
    toast('Son datos de ejemplo. Conecta tu Moodle para ver los tuyos.', { icon: 'info' });
    return;
  }
  const d = S.data;
  const gen = ++S.syncGen;
  S.abort = new AbortController();
  S.syncing = true;
  S.error = null;
  let changed = false;
  announce('Sincronizando');
  renderDynamic();
  try {
    const client = new MoodleClient({ siteUrl: d.site.url, token: d.token, transport: d.prefs.transport, signal: S.abort.signal });
    const fromMs = Date.now() - d.prefs.overdueDays * DAY;
    const [events, courses] = await Promise.all([client.actionEvents({ fromSeconds: Math.floor(fromMs / 1000) }), client.courses(d.site.userId).catch(() => null)]);
    if (gen !== S.syncGen || S.data !== d) return;
    const fresh = events.map((e) => eventToTask(e, d.site.url, d.site.lang === 'ca' ? 'ca' : 'es')).filter(Boolean);
    const before = d.tasks.map((t) => t.id + ':' + t.due).sort().join(',');
    const merged = T.mergeSync(d.tasks.filter((t) => t.due >= fromMs), fresh, d.history, Date.now());
    d.tasks = merged.tasks;
    d.history = merged.history;
    if (courses) d.courses = slimCourses(courses);
    d.colors = T.assignCourseColors(d.colors || {}, [...new Set([...d.courses.map((c) => c.id), ...d.tasks.map((t) => t.courseId)])]);
    d.done = T.pruneDone(d.done, d.tasks, Date.now());
    d.lastSync = Date.now();
    changed = before !== d.tasks.map((t) => t.id + ':' + t.due).sort().join(',');
    if (client.transport === 'proxy' && d.prefs.transport === 'auto') d.prefs.transport = 'auto';
    await persist();
    if (gen !== S.syncGen) return;
    S.animate = changed;
    changed = false;
    renderDynamic();
    try {
      await enrich(client, d, gen);
    } catch {
      /* las notas son un extra: si fallan, las tareas siguen bien */
    }
    if (gen !== S.syncGen || S.data !== d) return;
    announce('Sincronizado');
    if (merged.gone) toast(`${merged.gone} ${plural(merged.gone, 'tarea ya no aparece', 'tareas ya no aparecen')} en Moodle.`, { icon: 'check-circle', action: { label: 'Ver', fn: () => setView('done') } });
    if (merged.expired) toast(`${merged.expired} ${plural(merged.expired, 'cuestionario se ha cerrado', 'cuestionarios se han cerrado')}.`, { icon: 'info', action: { label: 'Ver', fn: () => setView('done') } });
  } catch (err) {
    if (gen !== S.syncGen || S.data !== d) return;
    if (err?.name === 'AbortError') return;
    S.error = err instanceof MoodleError ? err : new MoodleError('Algo ha fallado al sincronizar. Inténtalo otra vez.', 'unknown');
    S.errorAt = Date.now();
    if (S.error.code === 'localserver') watchLocalServer();
  } finally {
    if (gen === S.syncGen) {
      S.syncing = false;
      S.animate = changed;
      if (S.screen === 'app' && S.data === d) renderDynamic();
    }
  }
}

// Notas y detalles de las tareas. Pocas peticiones a la vez para no cargar Moodle.
async function enrich(client, d, gen) {
  const pref = d.site.lang === 'ca' ? 'ca' : 'es';
  const now = Date.now();
  const ids = [
    ...new Set([...d.courses.filter((c) => !c.hidden && !(c.enddate && c.enddate * 1000 < now - 30 * DAY)).map((c) => c.id), ...d.tasks.map((t) => t.courseId)]),
  ]
    .filter(Boolean)
    .slice(0, 25);
  if (!ids.length) return;
  const [ov, asg, qz] = await Promise.all([client.courseGrades().catch(() => null), client.assignments(ids).catch(() => null), client.quizzes(ids).catch(() => null)]);
  if (gen !== S.syncGen || S.data !== d) return;
  const itemsRes = await G.pool(ids, 3, (id) => client.gradeItems(id, d.site.userId));
  const assignIds = [...new Set(d.tasks.filter((t) => t.kind === 'assign' && (t.instance || t.cmid)).map((t) => t.instance || t.cmid))].slice(0, 25);
  const subsRes = await G.pool(assignIds, 3, (id) => client.submissionStatus(id));
  if (gen !== S.syncGen || S.data !== d) return;

  const overview = ov ? G.slimOverview(ov) : {};
  const courses = {};
  ids.forEach((id, i) => {
    const slim = itemsRes[i] ? G.slimGradeItems(itemsRes[i], pref) : null;
    const o = overview[id];
    if ((slim && (slim.total || slim.items.length)) || (o && o.formatted)) {
      courses[id] = { total: slim?.total || (o ? { formatted: o.formatted, raw: o.raw, min: null, max: null, pct: null } : null), items: slim?.items || [] };
    }
  });
  const prev = d.grades;
  const gotGrades = ov || itemsRes.some(Boolean);
  if (gotGrades) d.grades = { at: now, courses };
  else if (!prev) d.grades = { at: now, courses: {}, error: 'unavailable' };

  const subs = { ...(d.details?.sub || {}) };
  assignIds.forEach((id, i) => {
    if (subsRes[i]) subs[id] = G.submissionInfo(subsRes[i], pref);
  });
  d.details = {
    assign: asg ? G.assignDetails(asg) : d.details?.assign || {},
    quiz: qz ? G.quizDetails(qz) : d.details?.quiz || {},
    sub: subs,
  };

  let fresh = 0;
  if (gotGrades && prev?.courses && !prev.error) {
    const seen = new Set();
    Object.values(prev.courses).forEach((c) => (c.items || []).forEach((it) => it.formatted && seen.add(`${it.id}:${it.formatted}`)));
    Object.values(d.grades.courses).forEach((c) => (c.items || []).forEach((it) => {
      if (it.formatted && !seen.has(`${it.id}:${it.formatted}`)) fresh++;
    }));
  }
  await persist();
  if (fresh) toast(`${fresh} ${plural(fresh, 'nota nueva', 'notas nuevas')} en Moodle.`, { icon: 'chart-bar', action: { label: 'Ver', fn: () => setView('grades') } });
}

function maybeAutoSync() {
  const d = S.data;
  if (S.screen !== 'app' || !d || S.demo || document.hidden || S.syncing) return;
  const now = Date.now();
  const retryable = S.error && !NO_RETRY.includes(S.error.code);
  if ((!S.error && now - d.lastSync > 15 * MIN) || (retryable && now - S.errorAt > 2 * MIN)) sync();
}

let healthTimer = null;
function watchLocalServer() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (S.screen !== 'app' || S.error?.code !== 'localserver') return clearInterval(healthTimer);
    try {
      const r = await fetch('api/health', { cache: 'no-store' });
      if (r.ok) {
        clearInterval(healthTimer);
        sync();
      }
    } catch {
      /* sigue apagado */
    }
  }, 5000);
}

function openReconnect({ title = 'Vuelve a conectar Moodle', changing = false } = {}) {
  const d = S.data;
  if (!d) return;
  const tokenSession = (d.site.auth || SITE_CFG?.loginMode) === 'token';
  openDialog((close) => {
    const creds = credsBlock({ mode: d.site.auth || SITE_CFG?.loginMode || 'password', siteUrl: () => d.site.url, idPrefix: 'rc-' });
    const errSlot = h('div');
    creds.onChange(() => clearError(errSlot, null));
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, changing ? 'Guardar' : 'Reconectar');
    const form = h('form', { class: 'form', novalidate: true }, creds.seg, creds.fields, errSlot, h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn btn-outline', text: 'Cancelar', onclick: close }), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.getAttribute('aria-disabled') === 'true') return;
      [creds.user.input, creds.pass.input, creds.token.input].forEach((i) => clearError(errSlot, i));
      busy(submit, true, 'Conectando…');
      let focusEl = creds.mode === 'token' ? creds.token.input : creds.pass.input;
      try {
        const client = new MoodleClient({ siteUrl: d.site.url, transport: d.prefs.transport });
        if (creds.mode === 'token') {
          const tk = creds.token.input.value.trim();
          if (!TOKEN_RE.test(tk)) throw new MoodleError('El token tiene 32 letras y números (0-9, a-f).', 'badtoken');
          client.token = tk;
        } else {
          if (!creds.user.input.value.trim()) {
            focusEl = creds.user.input;
            throw new MoodleError('Escribe tu usuario de Moodle.', 'empty');
          }
          await client.login(creds.user.input.value.trim(), creds.pass.input.value);
        }
        let info;
        try {
          info = await client.siteInfo();
        } catch (err) {
          if (creds.mode === 'token' && (err.code === 'invalidtoken' || err.code === 'accessexception')) throw new MoodleError(tokenErrorMessage(), err.code);
          throw err;
        }
        if (Number(info.userid) !== d.site.userId) throw new MoodleError('Esa cuenta no es la que tenías conectada. Para cambiar de usuario, borra los datos desde Ajustes.', 'otheruser');
        if (S.data !== d) return;
        d.token = client.token;
        d.site.auth = creds.mode;
        creds.pass.input.value = '';
        creds.token.input.value = '';
        await persist();
        close();
        S.error = null;
        toast(changing ? 'Token actualizado.' : 'Conectado de nuevo.', { icon: 'check-circle' });
        sync();
      } catch (err) {
        busy(submit, false);
        showError(errSlot, err, focusEl);
      }
    });
    const intro = changing
      ? 'Pega un token nuevo o entra con tu usuario. Tus marcas y tu historial se conservan.'
      : tokenSession && S.error?.code === 'accessexception'
        ? 'Moodle ha rechazado el acceso guardado. Seguramente el token ha caducado (suelen durar unas 12 semanas). Pega uno nuevo.'
        : 'Moodle ha rechazado el acceso guardado. Los tokens caducan cada cierto tiempo (normalmente cada 12 semanas).';
    setTimeout(() => (creds.mode === 'token' ? creds.token.input : creds.user.input).focus(), 30);
    return h('div', {}, dialogHead(title, close), h('div', { class: 'dlg-body' }, h('p', { text: intro }), form));
  });
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

function setRow(label, sub, control, { subMono = false, subTitle } = {}) {
  return h('div', { class: 'set-row' }, h('div', { class: 'l' }, h('span', { text: label }), sub ? h('span', { class: 's' + (subMono ? ' mono' : ''), title: subTitle, text: sub }) : null), control);
}
function selectCtl(label, value, options, onChange) {
  const sel = h('select', { class: 'select', 'aria-label': label }, ...options.map(([v, l]) => h('option', { value: String(v), text: l })));
  sel.value = String(value);
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
function themeSeg() {
  const name = uid('theme');
  const cur = getTheme();
  return h(
    'fieldset',
    { class: 'seg' },
    h('legend', { class: 'sr', text: 'Tema' }),
    ...[
      ['auto', 'Automático'],
      ['light', 'Claro'],
      ['dark', 'Oscuro'],
    ].map(([v, l]) => {
      const input = h('input', { type: 'radio', name, value: v });
      input.checked = v === cur;
      input.addEventListener('change', () => input.checked && applyTheme(v));
      return h('label', {}, input, h('span', { text: l }));
    })
  );
}

function openSettings() {
  const d = S.data;
  if (!d) return;
  openDialog((close) => {
    const body = h('div', { class: 'dlg-body' });
    const group = (label, ...rows) => [h('h3', { class: 'set-label', text: label }), h('div', { class: 'set-group' }, ...rows.filter(Boolean))];
    body.append(
      ...group(
        'Cuenta',
        h('div', { class: 'set-row is-user' }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(d.site.userName) }), h('div', { class: 'l' }, h('span', { text: d.site.userName || 'Sin nombre' }), h('span', { class: 's', text: S.demo ? 'Modo demostración' : d.site.name }))),
        S.demo ? null : setRow('Dirección', d.site.url, null, { subMono: true, subTitle: d.site.url }),
        S.demo ? null : setRow('Acceso a Moodle', d.site.auth === 'token' ? 'Con token de la app móvil' : 'Con usuario y contraseña', h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { close(); openReconnect({ title: 'Cambiar el acceso', changing: true }); } }, 'Cambiar'))
      ),
      ...group('Apariencia', setRow('Tema', '', themeSeg()))
    );
    if (!S.demo) {
      const conn = selectCtl('Conexión', d.prefs.transport, [['auto', 'Automática'], ['direct', 'Directa con Moodle'], ['proxy', 'A través de Tasques en tu ordenador']], (v) => {
        d.prefs.transport = v;
        persist();
      });
      body.append(
        ...group(
          'Seguridad',
          setRow(
            'Bloquear tras',
            'Sin usar Tasques',
            selectCtl('Bloquear tras', d.prefs.lockMinutes, [[5, '5 min'], [10, '10 min'], [30, '30 min'], [60, '1 h'], [240, '4 h'], [0, 'Solo al cerrar la pestaña']], (v) => {
              d.prefs.lockMinutes = Number(v);
              persist();
            })
          ),
          setRow('Frase de acceso', 'La que abre tus datos en este navegador', h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { close(); openChangePassphrase(); } }, 'Cambiar')),
          h(
            'details',
            { class: 'tech' },
            h('summary', {}, icon('caret-right', 'icon-xs'), 'Detalles técnicos'),
            h('div', { class: 'tech-body' }, h('p', { text: 'Cifrado AES-256-GCM. Clave derivada con PBKDF2-SHA-256 y 600 000 iteraciones. La clave solo existe en memoria mientras Tasques está desbloqueado.' }), h('div', { class: 'set-row', style: { padding: '0' } }, h('div', { class: 'l' }, h('span', { text: 'Conexión' })), conn))
          )
        ),
        ...group(
          'Sincronización',
          setRow(
            'Mostrar atrasadas de',
            '',
            selectCtl('Mostrar atrasadas de', d.prefs.overdueDays, [[14, '2 semanas'], [30, '30 días'], [60, '60 días'], [120, '120 días']], (v) => {
              d.prefs.overdueDays = Number(v);
              persist();
              S.animate = true;
              renderDynamic();
              sync();
            })
          )
        )
      );
    }
    body.append(
      ...group('Datos', setRow('Exportar al calendario', 'Tus entregas pendientes en un archivo .ics', h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => exportIcs() }, icon('calendar-plus', 'icon-xs'), 'Exportar')))
    );
    if (!S.demo) {
      body.append(
        h(
          'div',
          { class: 'set-group' },
          h(
            'button',
            {
              type: 'button',
              class: 'set-danger',
              onclick: async () => {
                const ok = await confirmDialog({ title: '¿Desconectar y borrar?', body: 'Se borran el token, la copia de tus tareas y tus marcas en este navegador. En Moodle no cambia nada.', confirm: 'Borrar todo' });
                if (ok) {
                  close();
                  wipe();
                  renderOnboard();
                  toast('Datos borrados de este navegador.', { icon: 'check-circle' });
                }
              },
            },
            icon('trash', 'icon-sm'),
            'Desconectar y borrar los datos de este navegador'
          )
        )
      );
    }
    return h('div', {}, dialogHead('Ajustes', close), body);
  });
}

function openChangePassphrase() {
  const d = S.data;
  if (!d) return;
  openDialog((close) => {
    const host = hostOf(d.site.url);
    const ctx = () => passContext([d.site.firstName, d.site.userName, d.site.name, host, ...String(d.site.url).split('/')]);
    const cur = passwordField({ id: 'cp-cur', label: 'Frase actual', autocomplete: 'current-password', revealLabel: 'Mostrar la frase actual' });
    const p1 = passwordField({ id: 'cp-new', label: 'Nueva frase', autocomplete: 'new-password', minlength: MIN_PASSPHRASE, revealLabel: 'Mostrar la nueva frase' });
    const p2 = passwordField({ id: 'cp-rep', label: 'Repite la nueva', autocomplete: 'new-password', revealLabel: 'Mostrar la repetición' });
    const st = strengthUi(p1.input, ctx);
    p1.field.querySelector('.field-head').append(st.aside);
    p1.field.append(st.meter);
    p2.field.append(matchUi(p1.input, p2.input));
    const errSlot = h('div');
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Cambiar' });
    const form = h('form', { class: 'form', novalidate: true }, pmUser(host), cur.field, p1.field, p2.field, errSlot, h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn btn-outline', text: 'Cancelar', onclick: close }), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.getAttribute('aria-disabled') === 'true') return;
      const a = p1.input.value;
      const s = passphraseStrength(a, ctx());
      if (a.length < MIN_PASSPHRASE || s.level < 2) return showError(errSlot, new Error(`Usa al menos ${MIN_PASSPHRASE} caracteres y algo difícil de adivinar.`), p1.input);
      if (a !== p2.input.value) return showError(errSlot, new Error('Las dos frases nuevas no coinciden.'), p2.input);
      busy(submit, true, 'Cifrando…');
      try {
        try {
          await new Vault(storage).unlock(cur.input.value);
        } catch {
          throw Object.assign(new Error('La frase actual no es correcta.'), { field: 'cur' });
        }
        await vault.create(a, S.data);
        cur.input.value = p1.input.value = p2.input.value = '';
        scrubRegExp();
        close();
        toast('Frase cambiada. Tus datos se han vuelto a cifrar con una clave nueva.', { icon: 'check-circle' });
      } catch (err) {
        busy(submit, false);
        showError(errSlot, err, err.field === 'cur' ? cur.input : p1.input);
      }
    });
    setTimeout(() => cur.input.focus(), 30);
    return h('div', {}, dialogHead('Cambiar frase de acceso', close), h('div', { class: 'dlg-body' }, form));
  });
}

function exportIcs(list = null, filename = 'tasques.ics') {
  const d = S.data;
  if (!d) return;
  const now = Date.now();
  const items = list || T.pendingTasks(d.tasks, d.done).filter((t) => t.due >= now);
  if (!items.length) return toast('No hay entregas futuras que exportar.', { icon: 'info' });
  const blob = new Blob([buildIcs(items, now)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(list && list.length === 1 ? 'Entrega exportada. Ábrela con tu calendario.' : `${items.length} ${plural(items.length, 'entrega exportada', 'entregas exportadas')}. Ábrelo con tu calendario.`, { icon: 'calendar-plus' });
}

// ---------------------------------------------------------------------------
// Temporizadores, teclado y eventos globales
// ---------------------------------------------------------------------------

function touch() {
  S.lastActivity = Date.now();
}
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => addEventListener(ev, touch, { passive: true }));

function idleCheck() {
  if (S.screen !== 'app' || S.demo || !S.data) return;
  const mins = Number(S.data.prefs.lockMinutes);
  if (!mins) return;
  if (Date.now() - S.lastActivity > mins * MIN) {
    const label = mins >= 60 ? `${mins / 60} h` : `${mins} min`;
    lock(`Se ha bloqueado tras ${label} sin uso.`);
  }
}

function startTimers() {
  stopTimers();
  S.timers.push(
    setInterval(() => {
      idleCheck();
      tick();
      maybeAutoSync();
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
    tick();
    maybeAutoSync();
  }
});
addEventListener('online', () => S.screen === 'app' && !S.demo && sync());

addEventListener('storage', (e) => {
  if (e.key === vault.storageKey && S.screen === 'app' && !S.demo) {
    if (e.newValue === null) {
      lock();
      wipe();
      renderOnboard();
    } else lock('Los datos han cambiado en otra pestaña.');
  }
});

document.addEventListener('keydown', (e) => {
  if (S.screen !== 'app' || document.querySelector('dialog[open]')) return;
  const tgt = e.target;
  const typing = tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement || tgt?.isContentEditable;
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (isMobile()) toggleSearchRow(root.querySelector('.tools .m-only[aria-expanded]'));
    else S.refs.search?.focus();
    return;
  }
  if (e.key === 'Escape') {
    if (S.ui.day !== null) {
      e.preventDefault();
      setDay(S.ui.day);
    } else if (S.ui.query) {
      e.preventDefault();
      setQuery('');
      if (isMobile()) closeSearchRow();
    }
  }
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function notice(title, body) {
  S.screen = 'notice';
  document.title = 'Tasques';
  mount(
    root,
    h(
      'main',
      { class: 'lock', id: 'main' },
      h('div', { class: 'lock-top' }, brandEl()),
      h('div', { class: 'lock-card' }, h('span', { class: 'glyph' }, icon('warning', 'icon')), h('h1', { text: title }), h('p', { class: 'sub', text: body })),
      h('span')
    )
  );
}

async function boot() {
  if (!globalThis.crypto || !crypto.subtle) {
    return notice('Abre Tasques con Iniciar.cmd', 'El cifrado del navegador solo funciona en páginas seguras (https://) o en tu propio ordenador (http://127.0.0.1). Cierra esta pestaña y abre Tasques con Iniciar.cmd.');
  }
  if (navigator.serviceWorker?.controller) {
    return notice(
      'Hay un programa extraño en segundo plano',
      'Otra web que usaste en esta dirección dejó un programa en segundo plano. Cierra la pestaña, vuelve a abrir Tasques con Iniciar.cmd y, si sigue, borra los datos del sitio en el navegador.'
    );
  }
  if (SITE_CFG === null) {
    try {
      const r = await fetch('api/config', { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined });
      SITE_CFG = r.ok ? await r.json() : false;
    } catch {
      SITE_CFG = false;
    }
  }
  let exists = false;
  try {
    exists = vault.exists();
  } catch {
    exists = false;
  }
  if (exists) renderLock();
  else renderOnboard();
}

boot();
