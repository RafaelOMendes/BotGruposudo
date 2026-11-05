@echo off
rem Mantém o bot rodando: se ele cair, reinicia em 10 segundos.
rem Código 2 = já existe outra instância; 3 = sessão desconectada (precisa de QR). Nos dois casos para.
cd /d "%~dp0"
:loop
node index.mjs
if %errorlevel%==2 exit /b
if %errorlevel%==3 exit /b
timeout /t 10 /nobreak >nul
goto loop
