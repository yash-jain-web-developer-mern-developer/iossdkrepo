@echo off
rem Starts the MobiAd investor demo (simulated data) and opens the browser. Close this window to stop it.
cd /d "%~dp0"
start "" "http://localhost:8080/"
node scripts\demo.mjs
pause
