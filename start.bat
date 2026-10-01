@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo FixHub: http://localhost:3000
node --no-warnings server.js
pause
