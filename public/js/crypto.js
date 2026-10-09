// Bóveda cifrada local.
//
// Todo lo que se guarda en el navegador (token de Moodle, caché de tareas,
// tareas marcadas como hechas) pasa por aquí. Nunca se escribe nada en claro.
//
//   clave  = PBKDF2-SHA256(frase, sal aleatoria de 16 B, 600 000 iteraciones) -> AES-GCM 256
//   bloque = AES-GCM(clave, IV aleatorio de 12 B, JSON, AAD = "moodletasques/v1")
//
// La CryptoKey se crea como no extraíble y solo vive en memoria mientras la
// sesión está desbloqueada. La frase de acceso no se guarda nunca.

import { COMMON_PASSWORDS } from './common-passwords.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const VAULT_VERSION = 1;
export const KDF_ITERATIONS = 600_000;
const AAD = enc.encode('moodletasques/v' + VAULT_VERSION);

const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('Este navegador no ofrece Web Crypto. Abre la app con HTTPS o en localhost.');
  return s;
};

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function seal(key, data) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(JSON.stringify(data)));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function open(key, box) {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromB64(box.iv), additionalData: AAD },
    key,
    fromB64(box.ct)
  );
  return JSON.parse(dec.decode(pt));
}

// ---------------------------------------------------------------------------
// Fuerza de la frase de acceso
// ---------------------------------------------------------------------------

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const lowerFold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const stripEnds = (s) => s.replace(/^[\d\W_]+|[\d\W_]+$/g, '');
const unleet = (s) => s.replace(/[013457@$]/g, (c) => LEET[c]);
const compact = (s) => s.replace(/[^a-z0-9]+/g, '');

// Formas con las que se compara una contraseña con la lista: tal cual, sin
// números ni símbolos en los extremos y sin leetspeak ("P@ssw0rd1" -> "password").
function variants(p) {
  const b = lowerFold(p);
  const out = new Set([b]);
  for (const v of [unleet(stripEnds(b)), stripEnds(unleet(b))]) {
    if (v.length >= 3) {
      out.add(v);
      out.add(v.replace(/\s+/g, ''));
    }
  }
  return out;
}

let commonForms = null;
let commonWords = null;
function loadCommon() {
  if (commonForms) return;
  commonForms = new Set();
  for (const w of COMMON_PASSWORDS) variants(w).forEach((v) => commonForms.add(v));
  // Palabras de la lista que cuentan como una sola pieza dentro de una frase.
  commonWords = [...commonForms].filter((w) => w.length >= 5 && /^[a-z]+$/.test(w)).sort((a, b) => b.length - a.length);
}

export function isCommonPassword(p) {
  loadCommon();
  return [...variants(p)].some((v) => commonForms.has(v));
}

const GENERIC = new Set(['http', 'https', 'www', 'com', 'cat', 'org', 'net', 'edu', 'php', 'html', 'index']);
const contextTokens = (context) =>
  [...new Set((Array.isArray(context) ? context : [context]).flatMap((c) => lowerFold(c ?? '').split(/[^a-z0-9]+/)))].filter(
    (t) => t.length >= 3 && !GENERIC.has(t)
  );

// Estimación aproximada de la entropía de la frase (bits). Solo orienta al
// usuario, pero el nivel 2 es el mínimo para crear la bóveda.
// context: nombre del centro, dirección de Moodle, nombre y usuario. Cada una
// de esas palabras que aparezca en la frase resta 20 bits.
export function passphraseStrength(p, context = []) {
  if (!p) return { bits: 0, label: 'Vacía', level: 0 };
  p = String(p);
  if (isCommonPassword(p)) return { bits: 0, label: 'Muy común', level: 0 };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
  // Los caracteres que siguen una serie (abc, 321) o repiten el anterior (aaa) aportan poco.
  let effective = 0;
  const cps = [...p].map((c) => c.codePointAt(0));
  cps.forEach((c, i) => {
    const step = i > 0 ? c - cps[i - 1] : null;
    effective += step !== null && Math.abs(step) <= 1 ? 0.25 : 1;
  });
  const unique = new Set(p).size;
  let bits = Math.min(effective, unique * 1.5) * Math.log2(Math.max(pool, 1));

  // Una palabra de la lista de contraseñas comunes vale unos 11 bits, no lo
  // que sumarían sus letras una a una.
  loadCommon();
  const perChar = bits / Math.max(cps.length, 1);
  const flat = compact(unleet(lowerFold(p)));
  const covered = new Array(flat.length).fill(false);
  for (const w of commonWords) {
    let i = flat.indexOf(w);
    while (i !== -1) {
      if (!covered.slice(i, i + w.length).some(Boolean)) {
        covered.fill(true, i, i + w.length);
        bits -= Math.max(0, w.length * perChar - 11);
      }
      i = flat.indexOf(w, i + 1);
    }
  }

  // Palabras del contexto (el centro, tu nombre...): fáciles de adivinar. Las
  // cortas solo cuentan como palabra suelta ("pau", no "pausa").
  const plain = compact(lowerFold(p));
  const words = new Set([lowerFold(p), unleet(lowerFold(p))].flatMap((s) => s.split(/[^a-z0-9]+/)));
  for (const t of contextTokens(context)) {
    const hit = t.length < 5 ? words.has(t) : plain.includes(t) || flat.includes(t) || flat.includes(unleet(t));
    if (hit) bits -= 20;
  }

  bits = Math.max(0, Math.round(bits));
  if (bits < 40) return { bits, label: 'Débil', level: 1 };
  if (bits < 60) return { bits, label: 'Aceptable', level: 2 };
  if (bits < 80) return { bits, label: 'Fuerte', level: 3 };
  return { bits, label: 'Muy fuerte', level: 4 };
}

export const MIN_PASSPHRASE = 8;

const MIN_ITERATIONS = KDF_ITERATIONS;
const MAX_ITERATIONS = 10_000_000;

function vaultError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}
const damaged = () => vaultError('Los datos guardados están dañados.', 'damaged');

function b64Length(str) {
  if (typeof str !== 'string' || !str) return -1;
  try {
    return fromB64(str).length;
  } catch {
    return -1;
  }
}

// Persistencia: un único registro con la sal, los parámetros del KDF y el bloque cifrado.
export class Vault {
  constructor(storage, storageKey = 'mt.vault') {
    this.storage = storage;
    this.storageKey = storageKey;
    this.key = null;
    this.salt = null;
    this.iterations = KDF_ITERATIONS;
  }

  // Lee y valida el registro guardado. Devuelve null si no hay ninguno y lanza
  // un error si está dañado o manipulado (iteraciones fuera de rango, sal o IV
  // con otra longitud...), para no colgar el descifrado ni mostrar errores crudos.
  read() {
    let raw;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      return null;
    }
    if (!raw) return null;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      throw damaged();
    }
    if (!rec || typeof rec !== 'object' || rec.v !== VAULT_VERSION || rec.kdf !== 'PBKDF2-SHA256') throw damaged();
    if (!Number.isInteger(rec.iter) || rec.iter < MIN_ITERATIONS || rec.iter > MAX_ITERATIONS) throw damaged();
    if (!rec.box || typeof rec.box !== 'object') throw damaged();
    if (b64Length(rec.salt) !== 16 || b64Length(rec.box.iv) !== 12) throw damaged();
    // AES-GCM: al menos 1 byte cifrado más la etiqueta de 16 bytes.
    if (b64Length(rec.box.ct) < 17) throw damaged();
    return rec;
  }

  // Hay algo guardado (aunque esté dañado: entonces unlock() lo explica).
  exists() {
    try {
      return Boolean(this.storage.getItem(this.storageKey));
    } catch {
      return false;
    }
  }

  get unlocked() {
    return this.key !== null;
  }

  async create(passphrase, data) {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
      throw new Error(`La frase de acceso necesita al menos ${MIN_PASSPHRASE} caracteres.`);
    }
    this.salt = randomBytes(16);
    this.iterations = KDF_ITERATIONS;
    this.key = await deriveKey(passphrase, this.salt, this.iterations);
    await this.save(data);
  }

  async unlock(passphrase) {
    const rec = this.read();
    if (!rec) throw vaultError('No hay ninguna bóveda guardada.', 'nodata');
    const salt = fromB64(rec.salt);
    // Sin Web Crypto (página sin HTTPS ni localhost) se explica eso; los datos no están dañados.
    subtle();
    let key;
    try {
      key = await deriveKey(String(passphrase ?? ''), salt, rec.iter);
    } catch {
      throw damaged();
    }
    let data;
    try {
      data = await open(key, rec.box);
    } catch {
      // AES-GCM falla la verificación de integridad si la clave no es la correcta.
      throw vaultError('Frase de acceso incorrecta.', 'badpass');
    }
    this.key = key;
    this.salt = salt;
    this.iterations = rec.iter;
    return data;
  }

  async save(data) {
    if (!this.key) throw new Error('La bóveda está bloqueada.');
    const box = await seal(this.key, data);
    const rec = { v: VAULT_VERSION, kdf: 'PBKDF2-SHA256', iter: this.iterations, salt: toB64(this.salt), box };
    this.storage.setItem(this.storageKey, JSON.stringify(rec));
  }

  lock() {
    this.key = null;
    this.salt = null;
  }

  destroy() {
    this.lock();
    this.storage.removeItem(this.storageKey);
  }
}
