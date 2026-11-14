@echo off
chcp 65001 >nul
title Servidor HMI (MySQL) - no cierres esta ventana
cd /d "%~dp0"

if not exist "db-config.json" (
  echo Primero abre crear-base-de-datos.bat para configurar MySQL.
  pause
  exit /b 1
)

echo Servidor del HMI con MySQL. Deja esta ventana abierta mientras uses el sistema.
echo Para apagarlo presiona Ctrl+C o cierra la ventana.
echo.
node server-mysql.js
echo.
pause
