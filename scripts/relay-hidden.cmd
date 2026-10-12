@echo off
rem Start the mimo-workbuddy-connect relay hidden, for the current user.
rem Used by the Run registry entry installed by install.ps1.
rem
rem %~dp0 is this file's directory (scripts\), so the plugin root is its parent.
setlocal
set "SCRIPT_DIR=%~dp0"
set "PLUGIN_DIR=%SCRIPT_DIR%.."
if not defined MIMO_WORKBUDDY_HOME set "MIMO_WORKBUDDY_HOME=%APPDATA%\mimo-workbuddy-connect"
if not exist "%MIMO_WORKBUDDY_HOME%" mkdir "%MIMO_WORKBUDDY_HOME%"
set "LOG_FILE=%MIMO_WORKBUDDY_HOME%\relay.log"

where node >nul 2>nul
if not %errorlevel%==0 (
  echo [%date% %time%] node.exe was not found on PATH >> "%LOG_FILE%"
  exit /b 1
)

rem Run from the plugin root so relative paths resolve predictably.
pushd "%PLUGIN_DIR%"
start "" /b node "%PLUGIN_DIR%\src\cli.js" serve >> "%LOG_FILE%" 2>&1
popd
exit /b 0
