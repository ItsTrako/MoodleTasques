@echo off
rem Tasques: haz doble clic aqui para abrirlo. Deja la ventana abierta mientras lo uses.
setlocal
title Tasques
cd /d "%~dp0"

rem --- 1. Buscar Node.js (tambien si el PATH aun no se ha actualizado) ---
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto check_version
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE=%ProgramFiles%\nodejs\node.exe"
  goto check_version
)
echo.
echo   No encuentro Node.js en este ordenador.
echo.
echo   1. Se va a abrir la web de Node.js: descarga e instala la version LTS.
echo   2. Cuando acabe, vuelve a hacer doble clic en Iniciar.cmd.
echo.
start "" "https://nodejs.org/es/download"
pause
exit /b 1

:check_version
rem --- 2. Comprobar que es Node 20 o superior ---
"%NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" 2>nul
if errorlevel 1 (
  echo.
  echo   Tu Node.js es demasiado antiguo. Tasques necesita la version 20 o superior.
  echo   Se va a abrir la web de Node.js: instala la version LTS y vuelve a probar.
  echo.
  start "" "https://nodejs.org/es/download"
  pause
  exit /b 1
)

rem --- 3. Arrancar. server.js abre el navegador solo. ---
"%NODE%" server.js %*
if errorlevel 1 (
  echo.
  echo   Tasques se ha cerrado por un error. Lee el mensaje de arriba.
  echo.
  pause
  exit /b 1
)
rem Si Tasques ya estaba abierto, server.js solo abre el navegador y sale.
timeout /t 3 >nul
endlocal
