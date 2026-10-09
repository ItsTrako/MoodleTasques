# Tasques

Las tareas que te quedan en Moodle, en una sola lista, con tus datos cifrados en el navegador.

- **Pendientes, atrasadas y de esta semana**, agrupadas por fecha límite (Atrasadas, Hoy, Mañana, Próximos 7 días, Más adelante).
- **Cuenta atrás** hasta la próxima entrega y una **franja de 14 días** con la carga de cada día por asignatura.
- **Filtros** por asignatura, con el progreso de cada curso, y búsqueda instantánea.
- **Hechas**: lo que entregas en Moodle desaparece de la línea de tiempo y pasa aquí solo. También puedes marcar tareas a mano (solo en tu dispositivo).
- **Exportar a calendario** (.ics) con aviso 24 h antes.
- Tema claro, oscuro o automático. Funciona en móvil.
- **Modo demostración** con datos de ejemplo, sin conectar nada.

Sin dependencias ni paso de compilación: HTML, CSS y JavaScript nativos, más un servidor Node de un solo archivo.

## Uso

```bash
npm start            # http://127.0.0.1:8080
npm test             # pruebas (node:test)
```

1. Escribe la dirección de tu Moodle y tu usuario y contraseña (o un token de la app móvil: en Moodle, *Preferencias → Claves de seguridad*).
2. Elige una **frase de acceso**. Con ella se cifra todo lo que se guarda en el navegador.
3. Listo. La próxima vez solo tendrás que escribir la frase.

La app usa el servicio `moodle_mobile_app`, el mismo que la app oficial de Moodle. Si tu centro no lo tiene activado, no funcionará: pide que activen la app móvil.

### Si el navegador no puede hablar con Moodle (CORS)

Normalmente el navegador se conecta directamente a Moodle. Si tu Moodle lo bloquea, el servidor incluido puede hacer de puente, **solo** hacia los hosts que autorices:

```bash
MOODLE_ALLOWED_HOSTS=campus.miinstituto.cat npm start
```

El proxy acepta únicamente `login/token.php` y `webservice/rest/server.php`, solo por HTTPS, solo desde la propia app, sin seguir redirecciones y sin registrar nada. Sin `MOODLE_ALLOWED_HOSTS` está desactivado.

## Seguridad

| Qué | Cómo |
|---|---|
| Cifrado en reposo | AES-256-GCM (Web Crypto). IV aleatorio de 96 bits en cada guardado y datos adicionales autenticados con la versión. |
| Derivación de la clave | PBKDF2-SHA-256, 600 000 iteraciones, sal aleatoria de 128 bits. La `CryptoKey` es no extraíble y solo existe en memoria. |
| Contraseña de Moodle | Se usa una vez para pedir el token y se descarta. Nunca se guarda. |
| Token | Solo se guarda cifrado. Viaja en el cuerpo del POST, nunca en la URL. |
| Bloqueo | Automático tras 5-60 min sin uso (configurable), manual con el candado, y si otra pestaña cambia los datos. Tras 3 intentos fallidos, espera creciente. |
| XSS | Nada de `innerHTML`: todo el texto de Moodle entra como `textContent`. La CSP exige Trusted Types, así que un `innerHTML` accidental fallaría. Los enlaces solo se aceptan si apuntan al propio Moodle. |
| Cabeceras | CSP estricta sin scripts ni estilos en línea, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP y `Permissions-Policy`. HSTS con `HTTPS_BEHIND_PROXY=1`. |
| Terceros | Ninguno. Fuentes (Geist) e iconos (Phosphor) están en el repositorio; no se carga nada de CDNs. |
| Solo HTTPS | Las direcciones `http://` se rechazan (salvo `localhost`, para desarrollo). |

Si olvidas la frase de acceso no hay forma de recuperar los datos: bórralos desde la pantalla de bloqueo y vuelve a conectar. En Moodle no se pierde nada.

## Despliegue

Es una web estática (`public/`). Puedes servirla con `server.js` detrás de HTTPS (Caddy, nginx...) o subir `public/` a cualquier hosting estático; en ese caso la CSP va en la etiqueta `<meta>` del HTML y el modo proxy no está disponible.

## Estructura

```
public/
  index.html          CSP y punto de entrada
  css/app.css         sistema visual (tokens claro/oscuro)
  js/app.js           pantallas e interacción
  js/crypto.js        bóveda cifrada
  js/moodle.js        cliente REST de Moodle
  js/store.js         lógica de tareas (pura, probada)
  js/ics.js           exportación a calendario
  js/demo.js          datos de ejemplo
  assets/             fuentes, iconos y licencias
server.js             servidor estático + proxy opcional
test/                 pruebas
```

Licencias de terceros: Geist (SIL OFL 1.1) y Phosphor Icons (MIT), en `public/assets/`.
