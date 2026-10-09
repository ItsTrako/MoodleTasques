# Tasques

Las tareas que te quedan en Moodle, en una sola lista y con tus datos cifrados en el navegador.

Hecho para el Moodle del **IES Gabriela Mistral** (la dirección ya viene puesta), pero funciona con cualquier Moodle que tenga activada la app móvil.

## Qué hace

- **Lista de pendientes agrupada por fecha:** Atrasadas, Hoy, Mañana, Próximos días y Más adelante.
- **Cuenta atrás** hasta la próxima entrega, siempre a la vista.
- **Franja de 14 días** con la carga de cada día. Haz clic en un día para ver solo lo que vence ese día; otro clic (o Esc) quita el filtro.
- **Vista Hoy**, con lo que tienes que entregar hoy y nada más.
- **Panel de detalle** de cada tarea: descripción, asignatura, fecha límite y un botón para **abrirla en Moodle**. También muestra el **estado de tu entrega** (sin entregar, borrador guardado, entregada), prórrogas, hasta cuándo se acepta con retraso, la nota máxima, los archivos adjuntos y, en los cuestionarios, el tiempo y los intentos.
- **Notas:** media general, gráfico por asignatura, últimas notas (con aviso de las nuevas) y, en cada asignatura, todas las calificaciones con los comentarios del profesorado.
- **Asignaturas con código y color** (por ejemplo FIL o MAT) para reconocerlas de un vistazo, con filtro por asignatura y búsqueda instantánea.
- **Hechas:** lo que entregas en Moodle sale de la lista y pasa aquí solo. También puedes marcar tareas a mano (solo en tu dispositivo).
- **Exportar a calendario (.ics)**, una tarea suelta o todas a la vez, con aviso 24 h antes.
- **Desbloqueo rápido:** el formulario funciona con los gestores de contraseñas del navegador, y tú eliges cuándo se bloquea (de 5 min a 4 h sin uso, o solo al cerrar la pestaña).
- **Tema claro, oscuro o automático.** Funciona en el móvil.
- **Modo demostración** con datos de ejemplo, sin conectar nada.

Sin dependencias ni paso de compilación: HTML, CSS y JavaScript nativos, más un pequeño servidor en Node.

## En Windows (lo más fácil)

1. Instala **Node.js LTS** desde https://nodejs.org/es (siguiente, siguiente, finalizar). Si tienes winget: `winget install -e --id OpenJS.NodeJS.LTS`.
2. Descarga Tasques, por ejemplo en el Escritorio: `git clone https://github.com/ItsTrako/MoodleTasques`. Si no usas Git, en GitHub pulsa **Code > Download ZIP** y descomprímelo.
3. Abre la carpeta **MoodleTasques** y haz **doble clic en `Iniciar.cmd`**. Se abre una ventana negra (déjala abierta) y el navegador con Tasques.
4. La dirección del Moodle del IES Gabriela Mistral ya viene puesta. Pega tu **token** (ver más abajo), elige una frase de acceso y listo.

**¿Quieres un icono?** Doble clic en **`CrearAccesoDirecto.cmd`**. Aparece «Tasques» en el Escritorio y en el menú Inicio (en el menú Inicio: clic derecho > Anclar a la barra de tareas).

**Cerrar:** cierra la ventana negra «Tasques».
**Abrir otra vez:** el icono «Tasques» o `Iniciar.cmd`. Si ya estaba abierto, solo se abre el navegador.

**Importante:** tus datos se guardan cifrados *en ese navegador* y *para la dirección* `http://127.0.0.1:8080`. Si entras con otro navegador, por `localhost` o por otro puerto, verás Tasques vacío. No se ha borrado nada: vuelve a abrirlo con el icono.

**Actualizar:** doble clic en `Actualizar.cmd`. Si lo descargaste en ZIP, descarga el nuevo y sustituye la carpeta. Tus datos no se pierden, porque están en el navegador.

**El token nunca va en ningún archivo.** Solo se pega en la app, que lo guarda cifrado.

### Dónde está tu token

El Moodle de educaciodigital.cat está en catalán:

1. Entra en el Moodle del instituto: https://educaciodigital.cat/iesgabrielamistral/moodle
2. Arriba a la derecha, abre tu menú de usuario y ve a **Preferències > Claus de seguretat**. (Dirección directa: https://educaciodigital.cat/iesgabrielamistral/moodle/user/managetoken.php)
3. Copia la clave del servicio **Moodle mobile web service** y pégala en Tasques.

Si no aparece ninguna clave de ese servicio, entra una vez en la app oficial de Moodle del móvil y vuelve a mirar. Ese token es el mismo que usa la app del móvil: si algún día lo restableces en Moodle, tendrás que pegar el nuevo en Tasques (y volver a entrar en la app del móvil).

### Si algo falla

| Ves esto | Haz esto |
|---|---|
| «No encuentro Node.js» | Instala Node.js LTS y vuelve a abrir `Iniciar.cmd`. |
| «Windows protegió su PC» | *Más información > Ejecutar de todas formas*. Pasa con los archivos bajados de Internet. |
| PowerShell: «npm.ps1 no se puede cargar... la ejecución de scripts está deshabilitada» | Usa `.\Iniciar.cmd`, `node server.js` o `npm.cmd start`. No cambies la política de ejecución. |
| «El puerto 8080 lo está usando otro programa» | Tasques se abre en el 8081, pero sin tus datos. Cierra el otro programa y vuelve a abrir Tasques. |
| Página en blanco o «Tasques no se ha abierto bien» | Has abierto `index.html` directamente. Usa `Iniciar.cmd`. |
| «No se puede acceder a este sitio» o «Tasques está cerrado en tu ordenador» | La ventana negra está cerrada. Vuelve a abrir Tasques y pulsa Sincronizar. |
| Tasques aparece vacío, como el primer día | Estás en otro navegador, en `localhost` o en otro puerto. Abre Tasques con el icono: siempre usa `http://127.0.0.1:8080`. |
| «Ese token no funciona en este Moodle» o «Moodle ha rechazado el acceso guardado» | El token está mal copiado o ha caducado. Cópialo otra vez desde *Preferències > Claus de seguretat* y pégalo en Tasques (botón «Reconectar»). Tus tareas marcadas no se pierden. |

### Desde PowerShell (opcional)

```powershell
cd $HOME\Desktop\MoodleTasques       # o la carpeta donde lo descargaste
.\Iniciar.cmd                       # o: node server.js
$env:PORT = 8181; node server.js    # variables en PowerShell (no uses VAR=valor)
```

Ojo: con otro puerto la dirección cambia y no verás los datos guardados en el 8080.

## En macOS, Linux y otros sistemas

Necesitas Node.js 20 o superior.

```bash
npm start            # abre http://127.0.0.1:8080 en el navegador
npm run dev          # igual, pero sin abrir el navegador
npm test             # pruebas (node:test)
```

## Primer uso

1. La dirección del Moodle ya viene puesta (sale de `tasques.config.json`). Pega tu token o, si tu Moodle lo permite, entra con usuario y contraseña.
2. Elige una **frase de acceso**. Con ella se cifra todo lo que se guarda en el navegador. Mejor varias palabras al azar que una palabra con números.
3. Listo. La próxima vez solo tendrás que escribir la frase (o dejar que la rellene el gestor de contraseñas del navegador).

La app usa el servicio `moodle_mobile_app`, el mismo que la app oficial de Moodle. Si tu centro no lo tiene activado, no funcionará: pide que activen la app móvil.

Si olvidas la frase de acceso no hay forma de recuperar los datos: bórralos desde la pantalla de bloqueo y vuelve a conectar. En Moodle no se pierde nada.

## Configuración: `tasques.config.json`

Este archivo **no guarda secretos** y se puede subir al repositorio. Si alguien escribe ahí una clave con nombre de token o contraseña, el servidor la ignora y avisa.

| Clave | Qué hace | Valor actual |
|---|---|---|
| `schoolName` | Nombre del centro que muestra la app. | `"IES Gabriela Mistral"` |
| `moodleUrl` | Dirección de tu Moodle (solo `https://`). La app la rellena sola y el puente se activa para ella. | `"https://educaciodigital.cat/iesgabrielamistral/moodle"` |
| `loginMode` | Forma de entrar que se muestra primero: `"token"` o `"password"`. | `"token"` |
| `port` | Puerto fijo. No lo cambies si ya tienes datos: están ligados a la dirección. | `8080` |
| `openBrowser` | Abrir el navegador al arrancar. | `true` |
| `extraAllowedHosts` | Otros servidores Moodle a los que el puente puede llamar (nombre de host). | `[]` |
| `lockToMoodle` | Si es `true`, la app solo puede conectarse a tu Moodle (ver más abajo). | `false` |

Variables de entorno opcionales: `PORT` (otro puerto), `HOST` (por defecto `127.0.0.1`, así Windows no pide permiso al cortafuegos), `PUBLIC_HOST` (el nombre con el que se llega al servidor si lo publicas), `MOODLE_ALLOWED_HOSTS`, `HTTPS_BEHIND_PROXY=1` y `NO_COLOR`. Con `--no-open` no se abre el navegador.

### El puente con Moodle (CORS)

Normalmente el navegador habla directamente con Moodle. Si Moodle no lo permite, el servidor incluido hace de puente. **Se activa solo para el `moodleUrl` de `tasques.config.json`**, con el prefijo exacto: en educaciodigital.cat cada instituto tiene su propia ruta, y las de otros centros se rechazan.

Para autorizar un servidor entero (avanzado), en PowerShell:

```powershell
$env:MOODLE_ALLOWED_HOSTS="educaciodigital.cat"; node server.js
```

En macOS o Linux: `MOODLE_ALLOWED_HOSTS=educaciodigital.cat npm start`. También puedes ponerlo en `extraAllowedHosts`.

El puente acepta únicamente `login/token.php` y `webservice/rest/server.php`, solo por HTTPS, solo desde la propia app (cabecera `Origin` obligatoria y del mismo origen), sin seguir redirecciones, con un máximo de 4 peticiones a la vez y 8 MB por respuesta, y sin registrar nada.

### Fijar las conexiones a tu Moodle (`lockToMoodle`)

Con `"lockToMoodle": true`, el servidor envía una CSP con `connect-src 'self' https://educaciodigital.cat`. Aunque alguien consiguiera inyectar código en la página, el navegador no le dejaría enviar tus datos a ningún otro sitio. El navegador aplica a la vez esta política y la de la etiqueta `<meta>`, y gana la más estricta.

A cambio, otro Moodle solo funcionaría a través del puente, y el puente también rechaza los sitios que no estén en la configuración. Por eso viene desactivado (`false`).

## Seguridad

| Qué | Cómo |
|---|---|
| Cifrado en reposo | AES-256-GCM (Web Crypto). IV aleatorio de 96 bits en cada guardado y datos adicionales autenticados con la versión. |
| Derivación de la clave | PBKDF2-SHA-256, 600 000 iteraciones, sal aleatoria de 128 bits. La `CryptoKey` es no extraíble y solo existe en memoria. |
| Frase de acceso | Se mide su fuerza y se rechazan las débiles, las muy comunes y las que contienen el nombre del centro o tu usuario. Es lo único que protege tus datos si alguien copia los del navegador. |
| Contraseña de Moodle | Se usa una vez para pedir el token y se descarta. Nunca se guarda. |
| Token | Solo se guarda cifrado, nunca en un archivo. Viaja en el cuerpo del POST, nunca en la URL. |
| Bloqueo | Automático tras un rato sin uso (de 5 min a 4 h, o solo al cerrar la pestaña) y manual con el candado. La espera tras varios intentos fallidos es solo un freno contra quien intente adivinar a mano. La protección de verdad es una frase de acceso larga. |
| XSS | Nada de `innerHTML`: todo el texto de Moodle entra como `textContent`. La CSP exige Trusted Types, así que un `innerHTML` accidental fallaría. Los enlaces solo se aceptan si apuntan al propio Moodle. |
| Cabeceras | CSP estricta sin scripts ni estilos en línea, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP y `Permissions-Policy`. HSTS con `HTTPS_BEHIND_PROXY=1`. |
| Servidor local | Escucha solo en `127.0.0.1` y solo responde a `127.0.0.1`, `localhost` y `[::1]` en su puerto (o a `PUBLIC_HOST`). Cualquier otro nombre recibe 421, lo que corta los ataques de DNS rebinding. |
| Puente con Moodle | Solo tu Moodle, solo dos rutas, solo HTTPS y solo desde la propia app. Límites de tamaño y de peticiones simultáneas. |
| Service workers | Si otra web que usaste en la misma dirección dejó un service worker, el servidor lo sustituye por uno que se da de baja solo. |
| Terceros | Ninguno. Las fuentes (Geist) y los iconos (Phosphor) están en el repositorio; no se carga nada de CDNs. |
| Solo HTTPS | Las direcciones `http://` se rechazan (salvo `localhost`, para desarrollo). |

## Despliegue

Lo normal es usarlo en tu propio ordenador con `Iniciar.cmd` o `npm start`.

Para publicarlo en un servidor, pon `server.js` detrás de un proxy con HTTPS (Caddy, nginx...) y define:

- `HOST=0.0.0.0` (o la interfaz que toque),
- `PUBLIC_HOST=tasques.midominio.cat` (el nombre exacto con el que se entra; si falta, el servidor responde 421),
- `HTTPS_BEHIND_PROXY=1` para enviar HSTS.

También puedes subir solo `public/` a cualquier hosting estático. En ese caso la CSP va en la etiqueta `<meta>` del HTML, no hay puente ni `tasques.config.json` (la dirección de Moodle no viene puesta), y `frame-ancestors` y `X-Frame-Options` tienes que configurarlos en el propio hosting, porque una etiqueta `<meta>` no puede.

## Estructura

```
Iniciar.cmd               abrir Tasques en Windows (doble clic)
CrearAccesoDirecto.cmd    icono en el Escritorio y en el menú Inicio
Actualizar.cmd            descargar la última versión (git pull)
tasques.config.json       tu Moodle, el puerto... (sin secretos)
server.js                 arranque: puerto, navegador y mensajes
server-lib.js             servidor: archivos, cabeceras, /api/config y puente
public/
  index.html              CSP y punto de entrada
  css/app.css             sistema visual (tokens claro y oscuro)
  js/app.js               pantallas e interacción
  js/dom.js               utilidades del DOM
  js/crypto.js            bóveda cifrada
  js/common-passwords.js  contraseñas demasiado comunes (se rechazan)
  js/moodle.js            cliente REST de Moodle
  js/details.js       notas y detalles de las tareas (puro, probado)
  js/store.js             lógica de tareas (pura, probada)
  js/ics.js               exportación a calendario
  js/demo.js              datos de ejemplo
  assets/                 fuentes, iconos, favicon, tasques.ico y licencias
test/                     pruebas (node --test)
```

## Licencias

- Código de Tasques: MIT.
- Geist y Geist Mono: SIL Open Font License 1.1, en `public/assets/fonts/OFL-Geist.txt`.
- Phosphor Icons: MIT, en `public/assets/LICENSE-phosphor.txt`.
- Lista de contraseñas comunes: SecLists (MIT), citada en `public/js/common-passwords.js`.
