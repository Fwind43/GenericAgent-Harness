@echo off
rem ga-harness launcher: uses the harness venv if present; `gah run` then hops to GA's venv itself.
setlocal
set "PYTHONPATH=%~dp0;%PYTHONPATH%"
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" -m ga_harness.cli %*
) else (
  py -3 -m ga_harness.cli %*
)
exit /b %ERRORLEVEL%
