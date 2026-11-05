@echo off
rem Mantém o bot rodando: se ele cair, reinicia em 10 segundos.
cd /d "%~dp0"
:loop
node index.js
timeout /t 10 /nobreak >nul
goto loop
