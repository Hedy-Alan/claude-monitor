@echo off
chcp 65001 >nul
title Claude Code Desktop Monitor

echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║     🤖 Claude Code Desktop Monitor           ║
echo   ╚══════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

echo [*] Starting monitor server with auto-open...
start /B node server.js --open

echo.
echo   ✅ Monitor is starting...
echo   📊 Dashboard: http://localhost:9876
echo   🛑 Close this window or press Ctrl+C to stop
echo.

:: Keep window open
pause >nul
