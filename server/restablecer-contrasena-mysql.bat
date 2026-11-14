@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Restablecer contraseña de root en MySQL
cd /d "%~dp0"

echo ==================================================
echo   Restablecer la contraseña de root de MySQL
echo ==================================================
echo.

REM --- 1. Debe correr como administrador ---
net session >nul 2>&1
if errorlevel 1 (
  echo Este archivo necesita permisos de administrador.
  echo Cierra esta ventana, dale clic derecho al archivo y elige
  echo "Ejecutar como administrador".
  echo.
  pause
  exit /b 1
)

REM --- 2. Buscar dónde está instalado MySQL ---
set "MYSQL_DIR="
for /d %%D in ("C:\Program Files\MySQL\MySQL Server *") do set "MYSQL_DIR=%%~fD"
if not defined MYSQL_DIR (
  echo No encontre MySQL en "C:\Program Files\MySQL".
  pause
  exit /b 1
)
for %%N in ("!MYSQL_DIR!") do set "VERSION=%%~nxN"
set "INI=C:\ProgramData\MySQL\!VERSION!\my.ini"
if not exist "!INI!" (
  echo No encontre el archivo de configuracion "!INI!".
  pause
  exit /b 1
)

REM --- 3. Buscar el nombre del servicio (normalmente MySQL80) ---
set "SVC="
for /f "tokens=2" %%S in ('sc query state^= all ^| findstr /r /i /c:"SERVICE_NAME: *MySQL"') do (
  if not defined SVC set "SVC=%%S"
)
if not defined SVC (
  echo No encontre el servicio de MySQL en Windows.
  pause
  exit /b 1
)

echo MySQL encontrado:  !VERSION!
echo Servicio:          !SVC!
echo.

REM --- 4. Pedir la contraseña nueva ---
:pedir
set "PASS="
set /p "PASS=Escribe la NUEVA contraseña (solo letras y numeros, minimo 6): "
echo(!PASS!| findstr /r /x "[a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9]*" >nul
if errorlevel 1 (
  echo   Usa solo letras y numeros, sin espacios ni acentos, de al menos 6 caracteres.
  echo.
  goto pedir
)
echo.
echo IMPORTANTE: anota esta contraseña en un lugar seguro.
echo.

REM --- 5. Crear el archivo temporal con la instruccion ---
set "INIT=%TEMP%\mysql-reset-init.txt"
> "!INIT!" echo ALTER USER 'root'@'localhost' IDENTIFIED BY '!PASS!';

REM --- 6. Detener el servicio ---
echo Deteniendo MySQL...
net stop "!SVC!" >nul 2>&1
timeout /t 3 /nobreak >nul

REM --- 7. Arrancar MySQL una vez con la nueva contraseña ---
echo Aplicando la nueva contraseña (puede tardar hasta un minuto)...
start "mysql-reset" /min "!MYSQL_DIR!\bin\mysqld.exe" --defaults-file="!INI!" --init-file="!INIT!"

set /a INTENTOS=0
:esperar
timeout /t 2 /nobreak >nul
set /a INTENTOS+=1
"!MYSQL_DIR!\bin\mysqladmin.exe" -u root -p!PASS! status >nul 2>&1
if not errorlevel 1 goto listo
if !INTENTOS! lss 30 goto esperar

REM --- No funcionó: dejar todo como estaba ---
echo.
echo No se pudo aplicar la contraseña. Dejando MySQL como estaba...
taskkill /im mysqld.exe /f >nul 2>&1
del "!INIT!" >nul 2>&1
timeout /t 3 /nobreak >nul
net start "!SVC!" >nul 2>&1
echo Toma una captura de esta ventana y mandasela a Claude.
pause
exit /b 1

:listo
REM --- 8. Apagar el MySQL temporal, borrar el archivo y prender el servicio ---
"!MYSQL_DIR!\bin\mysqladmin.exe" -u root -p!PASS! shutdown >nul 2>&1
timeout /t 5 /nobreak >nul
del "!INIT!" >nul 2>&1
echo Volviendo a encender el servicio de MySQL...
net start "!SVC!" >nul 2>&1
timeout /t 3 /nobreak >nul
"!MYSQL_DIR!\bin\mysqladmin.exe" -u root -p!PASS! status >nul 2>&1
if errorlevel 1 (
  echo.
  echo La contraseña cambio, pero el servicio no volvio a encender.
  echo Abre "Servicios", busca !SVC!, clic derecho, Iniciar.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   Listo: la contraseña de root ya es la nueva.
echo ==================================================
echo.
echo Ahora abre crear-base-de-datos.bat (doble clic normal)
echo y escribe esta misma contraseña cuando te la pida.
echo.
pause
