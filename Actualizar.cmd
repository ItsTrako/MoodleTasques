@echo off
rem Descarga la ultima version de Tasques. Tus datos NO se tocan: estan en el navegador.
setlocal
title Actualizar Tasques
cd /d "%~dp0"
where git >nul 2>nul
if errorlevel 1 goto no_git
if not exist ".git" goto no_git

echo.
echo   Buscando novedades...
echo.
git pull --ff-only
if errorlevel 1 (
  echo.
  echo   No he podido actualizar. Lo mas normal es que hayas cambiado algun archivo.
  echo   Para descartar tus cambios y quedarte con la version oficial, escribe:
  echo       git stash
  echo       git pull
  echo.
  pause
  exit /b 1
)
echo.
echo   Tasques esta al dia. Si estaba abierto, cierra su ventana y vuelve a abrirlo.
echo.
pause
exit /b 0

:no_git
echo.
echo   Esta carpeta no se descargo con Git, asi que no puedo actualizarla sola.
echo   Descarga el ZIP nuevo desde GitHub y sustituye esta carpeta.
echo   Tus tareas y ajustes no se pierden: estan guardados en el navegador.
echo.
start "" "https://github.com/ItsTrako/MoodleTasques"
pause
exit /b 1
