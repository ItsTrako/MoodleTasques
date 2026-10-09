#!/usr/bin/env node
// Servidor de Tasques, sin dependencias.
//
// - Sirve public/ con cabeceras de seguridad estrictas (CSP, COOP, CORP...).
// - Lee tasques.config.json (sin secretos): el nombre y la dirección de tu
//   Moodle, el puerto y si debe abrir el navegador.
// - Hace de puente (proxy) SOLO hacia tu Moodle, por si el navegador no puede
//   hablar con él directamente (CORS). No registra ni guarda nada.
// - Si el puerto ya lo usa otro Tasques, abre ese y sale. Si es otro programa,
//   prueba los 9 puertos siguientes y avisa de que tus datos están en el de siempre.
//
// Uso:  node server.js             (en Windows: doble clic en Iniciar.cmd)
//       node server.js --no-open   (no abrir el navegador)
//
// Variables de entorno (opcionales): PORT, HOST, PUBLIC_HOST,
// MOODLE_ALLOWED_HOSTS, HTTPS_BEHIND_PROXY=1, NO_COLOR. Ver README.md.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ConfigError, parseConfigText, resolveConfig, createHandler, proxyEnabled } from './server-lib.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, 'public');
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')).version || '0';
  } catch {
    return '0';
  }
})();

// --- Mensajes de consola ----------------------------------------------------------
// Sin símbolos raros: la consola clásica de Windows no siempre los tiene.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1'), green = paint('32'), yellow = paint('33'), red = paint('31'), dim = paint('2'), cyan = paint('36');
const say = (...l) => console.log(...l);

function fail(msg, hint) {
  console.error('');
  console.error(red('  Error: ' + msg));
  if (hint) console.error('  ' + hint);
  console.error('');
  process.exit(1);
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  fail(`Tasques necesita Node.js 20 o superior (tienes la ${process.versions.node}).`, 'Descarga la versión LTS en https://nodejs.org/es y vuelve a abrir Tasques.');
}

// --- Configuración -----------------------------------------------------------------
function loadConfig() {
  const file = join(DIR, 'tasques.config.json');
  try {
    let cfg = {};
    if (existsSync(file)) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch (e) {
        throw new ConfigError('No puedo abrir tasques.config.json.', `Detalle: ${e.message}`);
      }
      const parsed = parseConfigText(text);
      cfg = parsed.cfg;
      for (const k of parsed.ignored) {
        say(yellow(`  Aviso: he ignorado «${k}» de tasques.config.json. Los tokens y contraseñas NUNCA van en ese archivo.`));
        say(dim('  Escríbelos en la propia app: se guardan cifrados en tu navegador.'));
      }
    }
    const resolved = resolveConfig(cfg, { env: process.env, argv: process.argv.slice(2) });
    for (const w of resolved.warnings) say(yellow('  Aviso: ' + w));
    return resolved;
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message, e.hint);
    throw e;
  }
}
const CFG = loadConfig();

let PORT = CFG.port;
const server = http.createServer(createHandler({ cfg: CFG, root: ROOT, version: VERSION, getPort: () => PORT, env: process.env }));
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

// --- Arranque ----------------------------------------------------------------------
// Abre el navegador predeterminado. Nunca hace caer el servidor: si no puede,
// lo dice. La promesa se resuelve cuando se sabe si ha arrancado (o a los 2 s).
function openBrowser(url) {
  const sorry = () => say(dim(`  (No he podido abrir el navegador. Abre tú ${url})`));
  const [cmd, args, opts] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
      : process.platform === 'darwin'
        ? ['open', [url], {}]
        : ['xdg-open', [url], {}];
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      const child = spawn(cmd, args, { ...opts, stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => {
        sorry();
        done();
      });
      child.on('spawn', done);
      child.unref();
    } catch {
      sorry();
      done();
    }
  });
}

// ¿Lo que ocupa el puerto es otro Tasques? (también versiones antiguas sin /api/health)
async function isTasques(port) {
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
  try {
    const j = await (await get('/api/health')).json();
    if (j && j.app === 'tasques') return true;
  } catch {}
  try {
    return /<title>Tasques<\/title>/.test(await (await get('/')).text());
  } catch {
    return false;
  }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.off('listening', onOk);
      reject(e);
    };
    const onOk = () => {
      server.off('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, CFG.host);
  });
}

async function start() {
  const wanted = CFG.port;
  const last = Math.min(wanted + 9, 65535);
  for (let port = wanted; port <= last; port++) {
    PORT = port;
    try {
      await listen(port);
      return banner(port, wanted);
    } catch (e) {
      // EACCES en Windows suele ser un rango de puertos reservado por Hyper-V, WSL o Docker.
      if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
        if (await isTasques(port)) {
          const url = `http://127.0.0.1:${port}/`;
          say('');
          say('  ' + green('Tasques ya estaba abierto en ') + cyan(url));
          if (CFG.open) {
            say('  Te lo abro en el navegador.');
            await openBrowser(url);
          }
          say(dim('  Esta ventana se puede cerrar.'));
          say('');
          process.exit(0);
        }
        if (port === wanted) {
          say(yellow(`  Aviso: el puerto ${port} ${e.code === 'EACCES' ? 'está reservado por Windows' : 'lo está usando otro programa'}. Pruebo el siguiente...`));
        }
        continue;
      }
      fail(`No he podido arrancar el servidor: ${e.message}`);
    }
  }
  fail(`Los puertos ${wanted} a ${last} están ocupados.`, 'Cierra otros programas o cambia "port" en tasques.config.json.');
}

function banner(port, wanted) {
  const url = `http://127.0.0.1:${port}/`;
  const pc = CFG.publicConfig;
  say('');
  say('  ' + bold('Tasques') + dim(` v${VERSION}`));
  say('  ' + green('Listo en ') + cyan(url));
  if (pc.moodleUrl) say('  ' + dim('Moodle: ') + (pc.schoolName ? pc.schoolName + ' · ' : '') + pc.moodleUrl);
  if (proxyEnabled(CFG)) {
    const to = [...(pc.moodleUrl ? ['ese Moodle'] : []), ...CFG.allowedHosts].join(', ');
    say('  ' + dim(`Puente con Moodle: activo, solo hacia ${to}.`));
  }
  if (CFG.connectOrigin) say('  ' + dim(`La app solo puede conectarse a ${CFG.connectOrigin} (lockToMoodle).`));
  if (port !== wanted) {
    say('');
    say(yellow(`  Aviso: estás en el puerto ${port}, no en el ${wanted} de siempre.`));
    say(yellow(`  Tus datos guardados están en http://127.0.0.1:${wanted}/ y aquí no se verán.`));
    say(yellow(`  Cierra el programa que usa el ${wanted} y vuelve a abrir Tasques para recuperarlos.`));
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(CFG.host)) {
    say('');
    say(yellow(`  Aviso: escucho en ${CFG.host}, así que otros equipos de la red pueden llegar a Tasques.`));
    if (!CFG.publicHost) say(yellow('  Define PUBLIC_HOST con el nombre que usarán (por ejemplo tasques.midominio.cat), o responderé 421.'));
  }
  say('');
  say(dim('  Deja esta ventana abierta mientras uses Tasques. Para apagarlo, ciérrala.'));
  say('');
  if (CFG.open) openBrowser(url);
}

const bye = () => {
  say(dim('\n  Tasques apagado. ¡Hasta luego!\n'));
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

start();
