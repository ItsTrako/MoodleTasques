import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault, seal, open, deriveKey, randomBytes, passphraseStrength } from '../public/js/crypto.js';

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
  assert.equal(passphraseStrength('').level, 0);
  assert.equal(passphraseStrength('abc12345').level, 1);
  assert.ok(passphraseStrength('cafè lent sota la pluja').level >= 3);
});
