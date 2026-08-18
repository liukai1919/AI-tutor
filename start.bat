@echo off
setlocal
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 18+ from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if "%PORT%"=="" set "PORT=8434"

rem 端口上还挂着上一次的服务就先停掉再起：不然改了代码重开，
rem 浏览器连上的还是旧进程，看半天以为没生效。
call :stopold

echo Starting Yuanyuan Math ...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%'"

node server.js

echo.
echo Server stopped.
pause
exit /b 0

:stopold
set "OLDPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT%[^0-9].*LISTENING"') do set "OLDPID=%%p"
if not defined OLDPID exit /b 0
set "OLDNAME="
for /f "tokens=1 delims=," %%n in ('tasklist /fi "PID eq %OLDPID%" /fo csv /nh') do set "OLDNAME=%%~n"
rem 只接管自己人（node）。别的程序占了这个端口就交给用户处理，不能乱杀。
echo %OLDNAME% | findstr /i "^node" >nul
if errorlevel 1 (
  echo [ERROR] Port %PORT% is held by %OLDNAME% ^(PID %OLDPID%^), which is not Yuanyuan Math.
  echo         Close it yourself, or set a different port:  set PORT=8444 ^&^& start.bat
  echo.
  pause
  exit /b 1
)
echo [INFO] Port %PORT% still has an old server on it ^(PID %OLDPID%^) - stopping it first...
taskkill /PID %OLDPID% /F >nul 2>nul
rem 等端口真的放开：TIME_WAIT 之类偶尔要一两秒
for /l %%i in (1,1,10) do (
  netstat -ano | findstr /r /c:":%PORT%[^0-9].*LISTENING" >nul || exit /b 0
  timeout /t 1 /nobreak >nul
)
echo [WARN] Port %PORT% is still busy after 10s - starting anyway, node will report if it cannot bind.
exit /b 0
