@echo off
rem Opens the WatsonsTester launcher without WatsonsTester.exe (for PCs that block the exe).
cd /d "%~dp0"
node launcher\launcher.cjs
pause
