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

// Estimación aproximada de la entropía de la frase (bits). Solo orienta al usuario.
export function passphraseStrength(p) {
  if (!p) return { bits: 0, label: 'Vacía', level: 0 };
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
  const bits = Math.round(Math.min(effective, unique * 1.5) * Math.log2(Math.max(pool, 1)));
  if (bits < 40) return { bits, label: 'Débil', level: 1 };
  if (bits < 60) return { bits, label: 'Aceptable', level: 2 };
  if (bits < 80) return { bits, label: 'Fuerte', level: 3 };
  return { bits, label: 'Muy fuerte', level: 4 };
}

export const MIN_PASSPHRASE = 8;

// Persistencia: un único registro con la sal, los parámetros del KDF y el bloque cifrado.
export class Vault {
  constructor(storage, storageKey = 'mt.vault') {
    this.storage = storage;
    this.storageKey = storageKey;
    this.key = null;
    this.salt = null;
    this.iterations = KDF_ITERATIONS;
  }

  read() {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (rec.v !== VAULT_VERSION || rec.kdf !== 'PBKDF2-SHA256' || !rec.salt || !rec.box) return null;
      return rec;
    } catch {
      return null;
    }
  }

  exists() {
    return this.read() !== null;
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
    if (!rec) throw new Error('No hay ninguna bóveda guardada.');
    const salt = fromB64(rec.salt);
    const key = await deriveKey(passphrase, salt, rec.iter);
    let data;
    try {
      data = await open(key, rec.box);
    } catch {
      // AES-GCM falla la verificación de integridad si la clave no es la correcta.
      throw new Error('Frase de acceso incorrecta.');
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
