@echo off
rem Mantém o bot rodando: se ele cair, reinicia em 10 segundos.
rem Código de saída 2 = já existe outra instância, então para.
cd /d "%~dp0"
:loop
node index.js
if %errorlevel%==2 exit /b
timeout /t 10 /nobreak >nul
goto loop
