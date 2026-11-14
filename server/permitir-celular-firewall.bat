@echo off
chcp 65001 >nul
title Permitir que el celular abra el HMI (Firewall)

net session >nul 2>&1
if errorlevel 1 (
  echo Este archivo necesita permisos de administrador.
  echo Dale clic derecho y elige "Ejecutar como administrador".
  echo.
  pause
  exit /b 1
)

echo Agregando una regla al Firewall de Windows para el puerto 3000
echo ^(solo en redes PRIVADAS: tu casa o la red HMI-ESP32 marcada como privada^)...
echo.
netsh advfirewall firewall delete rule name="HMI servidor (puerto 3000)" >nul 2>&1
netsh advfirewall firewall add rule name="HMI servidor (puerto 3000)" dir=in action=allow protocol=TCP localport=3000 profile=private
if errorlevel 1 (
  echo.
  echo No se pudo agregar la regla. Toma una captura de esta ventana.
  pause
  exit /b 1
)
echo.
echo Listo. Ahora el celular puede abrir la pagina del HMI.
echo.
echo IMPORTANTE: la red WiFi tambien debe estar marcada como "Privada":
echo   Configuracion ^> Red e Internet ^> Wi-Fi ^> ^(tu red^) ^> Tipo de perfil de red: Privada
echo.
pause
