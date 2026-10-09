import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault, seal, open, deriveKey, randomBytes, passphraseStrength, isCommonPassword, MIN_PASSPHRASE, KDF_ITERATIONS } from '../public/js/crypto.js';
import { COMMON_PASSWORDS } from '../public/js/common-passwords.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => [...m.values()].join('') };
};

test('la bóveda cifra, guarda y descifra con la frase correcta', async () => {
  const store = memory();
  const v = new Vault(store);
  const data = { token: 'a'.repeat(32), tasks: [{ id: 'ev1', title: 'Pràctica 3' }] };
  await v.create('cafè lent sota la pluja', data);
  assert.ok(v.exists());
  assert.ok(!store.dump().includes('aaaaaaaa'), 'el token no debe aparecer en claro');
  assert.ok(!store.dump().includes('Pràctica'), 'las tareas no deben aparecer en claro');

  const again = new Vault(store);
  assert.deepEqual(await again.unlock('cafè lent sota la pluja'), data);
});

test('una frase incorrecta no descifra', async () => {
  const store = memory();
  await new Vault(store).create('frase correcta 123', { a: 1 });
  await assert.rejects(new Vault(store).unlock('frase incorrecta 123'), /incorrecta/);
});

test('cualquier manipulación del bloque cifrado se detecta', async () => {
  const store = memory();
  await new Vault(store).create('frase correcta 123', { a: 1 });
  const rec = JSON.parse(store.getItem('mt.vault'));
  const ct = Buffer.from(rec.box.ct, 'base64');
  ct[0] ^= 1;
  rec.box.ct = ct.toString('base64');
  store.setItem('mt.vault', JSON.stringify(rec));
  await assert.rejects(new Vault(store).unlock('frase correcta 123'));
});

test('cada guardado usa un IV nuevo', async () => {
  const key = await deriveKey('x'.repeat(10), randomBytes(16), 1000);
  const a = await seal(key, { n: 1 });
  const b = await seal(key, { n: 1 });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.deepEqual(await open(key, a), { n: 1 });
});

test('rechaza frases demasiado cortas', async () => {
  await assert.rejects(new Vault(memory()).create('corta', {}), /al menos/);
});

test('bloquear borra la clave de memoria', async () => {
  const v = new Vault(memory());
  await v.create('frase correcta 123', {});
  v.lock();
  assert.equal(v.unlocked, false);
  await assert.rejects(v.save({}), /bloqueada/);
});

test('estimación de fuerza', () => {
  assert.deepEqual(passphraseStrength(''), { bits: 0, label: 'Vacía', level: 0 });
  assert.ok(passphraseStrength('abc12345').level <= 1);
  assert.ok(passphraseStrength('xkq7').level <= 1);
  assert.ok(passphraseStrength('cafè lent sota la pluja').level >= 3);
  assert.equal(MIN_PASSPHRASE, 8);
});

test('rechaza contraseñas de diccionario aunque lleven mayúsculas, números o leetspeak', () => {
  for (const p of ['password1', 'Password1', 'qwertyuiop', 'Barcelona1', 'mistral2025', 'iesgabrielamistral', 'P@ssw0rd!', 'Messi10!', 'barça2024', 'contraseña', 'Contrasenya123', 'tequiero', 'i love you', 'Moodle2025', 'tasques1', '12345678']) {
    const s = passphraseStrength(p);
    assert.equal(s.level, 0, `${p} debería ser muy común`);
    assert.equal(s.label, 'Muy común');
    assert.ok(isCommonPassword(p), p);
  }
  const ok = passphraseStrength('cafè lent sota la pluja');
  assert.ok(ok.level >= 2, 'una frase de varias palabras se acepta');
  assert.equal(isCommonPassword('cafè lent sota la pluja'), false);
});

test('las palabras de la lista dentro de una frase cuentan poco', () => {
  // Sin contexto, el nombre del centro con las palabras cambiadas de orden no llega al mínimo.
  assert.ok(passphraseStrength('gabrielamistralies').level < 2);
  assert.ok(passphraseStrength('monkeydragonshadow').bits < passphraseStrength('quxofrawbelstinty').bits);
});

test('las palabras del contexto restan 20 bits cada una', () => {
  const ctx = ['IES Gabriela Mistral', 'https://educaciodigital.cat/iesgabrielamistral/moodle', 'Pau', 'pau'];
  const base = passphraseStrength('robot violeta 93 sabater');
  assert.equal(passphraseStrength('robot violeta 93 sabater', ['Joan Sabater']).bits, base.bits - 20);
  assert.equal(passphraseStrength('robot violeta 93 sabater', ctx).bits, base.bits);
  // El nombre del centro, aunque se mezcle, no llega al mínimo (nivel 2).
  assert.ok(passphraseStrength('mistral gabriela ies', ctx).level < 2);
  assert.ok(passphraseStrength('xarxa gabriela mistral', ctx).level < 2);
  // Un nombre corto solo cuenta como palabra suelta.
  assert.equal(passphraseStrength('Pau surt a les 9', ctx).bits, passphraseStrength('Pau surt a les 9').bits - 20);
  assert.equal(passphraseStrength('pausa llarga al pati', ctx).bits, passphraseStrength('pausa llarga al pati').bits);
  // Un contexto suelto (texto en lugar de lista) también vale.
  assert.equal(passphraseStrength('robot violeta 93 sabater', 'Sabater').bits, base.bits - 20);
});

test('la lista de contraseñas es pequeña y está en minúsculas', async () => {
  const { statSync } = await import('node:fs');
  const size = statSync(new URL('../public/js/common-passwords.js', import.meta.url)).size;
  assert.ok(size < 20_000, `ocupa ${size} bytes`);
  assert.ok(COMMON_PASSWORDS.size >= 2000);
  for (const w of ['password', 'qwertyuiop', 'contraseña', 'contrasenya', 'barcelona', 'barca', 'madrid', 'messi', 'tequiero', 'iloveyou', 'moodle', 'tasques', 'mistral', 'gabriela', 'institut', 'instituto']) {
    assert.ok(COMMON_PASSWORDS.has(w), w);
  }
  assert.ok([...COMMON_PASSWORDS].every((w) => w === w.toLowerCase() && !/\s/.test(w)));
});

// ---------------------------------------------------------------------------
// Cabecera de la bóveda
// ---------------------------------------------------------------------------

const tamper = async (change) => {
  const store = memory();
  await new Vault(store).create('frase correcta 123', { a: 1 });
  const rec = JSON.parse(store.getItem('mt.vault'));
  change(rec);
  store.setItem('mt.vault', JSON.stringify(rec));
  return store;
};

test('una cabecera manipulada se rechaza sin intentar descifrar', async () => {
  const cases = {
    'iter = 0': (r) => (r.iter = 0),
    'iter enorme': (r) => (r.iter = 2 ** 32 - 1),
    'iter por debajo del mínimo': (r) => (r.iter = 1000),
    'iter con decimales': (r) => (r.iter = 600000.5),
    'iter como texto': (r) => (r.iter = '600000'),
    'sal corta': (r) => (r.salt = Buffer.alloc(8).toString('base64')),
    'sal que no es base64': (r) => (r.salt = '***'),
    'sin sal': (r) => delete r.salt,
    'IV corto': (r) => (r.box.iv = Buffer.alloc(8).toString('base64')),
    'sin bloque': (r) => delete r.box,
    'bloque que no es base64': (r) => (r.box.ct = '***'),
    'bloque más corto que la etiqueta': (r) => (r.box.ct = Buffer.alloc(16).toString('base64')),
    'bloque vacío': (r) => (r.box.ct = ''),
    'otra versión': (r) => (r.v = 2),
    'otro KDF': (r) => (r.kdf = 'scrypt'),
  };
  for (const [name, change] of Object.entries(cases)) {
    const store = await tamper(change);
    const v = new Vault(store);
    assert.equal(v.exists(), true, name);
    assert.throws(() => v.read(), /dañados/, name);
    const t0 = Date.now();
    await assert.rejects(v.unlock('frase correcta 123'), (e) => /Los datos guardados están dañados/.test(e.message) && e.code === 'damaged', name);
    assert.ok(Date.now() - t0 < 2000, `${name}: no debe colgarse`);
    assert.equal(v.unlocked, false);
  }
});

test('un registro ilegible también cuenta como dañado', async () => {
  const store = memory();
  store.setItem('mt.vault', '{no es json');
  const v = new Vault(store);
  assert.equal(v.exists(), true);
  await assert.rejects(v.unlock('lo que sea 123'), /dañados/);
});

test('sin Web Crypto, unlock() lo explica y no dice que los datos estén dañados', async () => {
  const store = memory();
  await new Vault(store).create('frase correcta 123', { a: 1 });
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (a) => real.getRandomValues(a) }, configurable: true });
  try {
    await assert.rejects(new Vault(store).unlock('frase correcta 123'), (e) => /Web Crypto/.test(e.message) && e.code !== 'damaged');
  } finally {
    Object.defineProperty(globalThis, 'crypto', desc);
  }
  assert.deepEqual(await new Vault(store).unlock('frase correcta 123'), { a: 1 });
});

test('sin bóveda: exists() es falso y unlock() lo dice', async () => {
  const v = new Vault(memory());
  assert.equal(v.exists(), false);
  assert.equal(v.read(), null);
  await assert.rejects(v.unlock('frase correcta 123'), /No hay ninguna bóveda/);
  const broken = new Vault({
    getItem: () => {
      throw new Error('bloqueado');
    },
  });
  assert.equal(broken.exists(), false);
});

test('una bóveda válida conserva su cabecera y su clave', async () => {
  const store = memory();
  const v = new Vault(store, 'otra.clave');
  await v.create('frase correcta 123', { a: 1 });
  assert.equal(v.storageKey, 'otra.clave');
  const rec = v.read();
  assert.equal(rec.iter, KDF_ITERATIONS);
  assert.equal(Buffer.from(rec.salt, 'base64').length, 16);
  assert.equal(v.salt.length, 16);
  const again = new Vault(store, 'otra.clave');
  assert.deepEqual(await again.unlock('frase correcta 123'), { a: 1 });
  await again.save({ a: 2 });
  assert.deepEqual(await new Vault(store, 'otra.clave').unlock('frase correcta 123'), { a: 2 });
  again.destroy();
  assert.equal(again.exists(), false);
});
