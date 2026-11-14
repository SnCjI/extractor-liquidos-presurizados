@echo off
chcp 65001 >nul
title Servidor HMI (MySQL) - no cierres esta ventana
cd /d "%~dp0server"

where node >nul 2>nul
if errorlevel 1 (
  echo No encontre Node.js. Instalalo desde https://nodejs.org
  pause
  exit /b 1
)

if not exist "db-config.json" (
  echo Todavia no esta configurada la base de datos MySQL.
  echo Primero abre server\crear-base-de-datos.bat
  pause
  exit /b 1
)

if not exist "node_modules\mysql2" (
  echo Instalando dependencias ^(solo la primera vez^)...
  call npm install
)

echo Abriendo la pagina en tu navegador...
echo Deja esta ventana abierta mientras uses la pagina. Para apagar: cierra esta ventana.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
node server-mysql.js
echo.
pause
