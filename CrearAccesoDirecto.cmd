@echo off
rem Crea un icono "Tasques" en el Escritorio y en el menu Inicio.
setlocal
cd /d "%~dp0"
set "TASQUES_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:TASQUES_DIR; $sh=New-Object -ComObject WScript.Shell; foreach($f in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))){ $s=$sh.CreateShortcut((Join-Path $f 'Tasques.lnk')); $s.TargetPath=(Join-Path $d 'Iniciar.cmd'); $s.WorkingDirectory=$d; $s.IconLocation=(Join-Path $d 'public\assets\tasques.ico')+',0'; $s.Description='Abrir Tasques'; $s.Save() }"
if errorlevel 1 (
  echo.
  echo   No he podido crear el acceso directo. Puedes hacerlo a mano:
  echo   clic derecho en Iniciar.cmd, Enviar a, Escritorio.
) else (
  echo.
  echo   Listo. Tienes "Tasques" en el Escritorio y en el menu Inicio.
  echo   Truco: en el menu Inicio, clic derecho, Anclar a la barra de tareas.
)
echo.
pause
endlocal
