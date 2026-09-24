@echo off
title Metricos - Tiempo Muerto Mantenimiento
cd /d "%~dp0"

set PORT=4173
if exist .env for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" .env') do if not "%%b"=="" set PORT=%%b

rem Si la app esta instalada como servicio de Windows, solo abre el navegador
rem (no se debe iniciar una segunda copia en el mismo puerto).
sc query Metricos >nul 2>nul
if not errorlevel 1 (
  net start Metricos >nul 2>nul
  start "" http://localhost:%PORT%
  exit /b
)

where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js en el PATH.
  pause
  exit /b 1
)

echo ============================================
echo  Metricos - Tiempo Muerto de Mantenimiento
echo  Abriendo servidor en http://localhost:%PORT%
echo ============================================
echo.
start "Metricos Tiempo Muerto" cmd /k "node server.js"
timeout /t 3 /nobreak >nul
start "" http://localhost:%PORT%
exit
