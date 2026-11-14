@echo off
chcp 65001 >nul
title Simulador del ESP32 (extractor) - no cierres esta ventana
cd /d "%~dp0"
echo Simulador del ESP32: manda temperaturas de prueba al servidor como si
echo fuera el extractor real. Primero debe estar encendido el servidor
echo (iniciar-servidor-mysql.bat) en otra ventana.
echo.
node simulador-esp32.js
echo.
pause
