@echo off
chcp 65001 >nul
title Crear base de datos MySQL - HMI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo No encontre Node.js. Instalalo desde https://nodejs.org y vuelve a abrir este archivo.
  pause
  exit /b 1
)

if not exist "node_modules\mysql2" (
  echo Instalando el paquete mysql2 ^(solo la primera vez, necesita internet^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo No se pudo instalar. Revisa que la laptop tenga internet
    echo ^(no la red HMI-ESP32^) y vuelve a abrir este archivo.
    pause
    exit /b 1
  )
  echo.
)

node crear-base-de-datos.js
echo.
pause
