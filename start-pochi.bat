@echo off
REM Defensively cleared: if this happens to be launched from a dev shell
REM (or any parent process) that has ELECTRON_RUN_AS_NODE set, Electron
REM runs as a plain Node.js binary instead of launching the app -- Pochi
REM would silently fail to start. A normal Desktop double-click never has
REM this set, but clearing it here costs nothing and removes the whole
REM failure class either way.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
call npm start
