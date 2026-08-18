@echo off
setlocal
cd /d %~dp0

if "%PORT%"=="" set "PORT=8434"

rem 端口上还挂着上一次的服务就先停掉：不然双击图标，浏览器连上的还是旧进程。
call :stopold

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%'"

"%~dp0runtime\node.exe" "%~dp0app\server.js"

echo.
echo __APPNAME__ has stopped. / 服务已停止。
pause
exit /b 0

:stopold
set "OLDPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT%[^0-9].*LISTENING"') do set "OLDPID=%%p"
if not defined OLDPID exit /b 0
set "OLDNAME="
for /f "tokens=1 delims=," %%n in ('tasklist /fi "PID eq %OLDPID%" /fo csv /nh') do set "OLDNAME=%%~n"
rem 只接管自己人（node）。别的程序占着这个端口就交给用户处理，不能乱杀。
echo %OLDNAME% | findstr /i "^node" >nul
if errorlevel 1 (
  echo [ERROR] Port %PORT% is used by %OLDNAME% ^(PID %OLDPID%^) - not __APPNAME__.
  echo         Close that program, or start with another port:  set PORT=8444
  echo.
  pause
  exit /b 1
)
echo [INFO] Stopping the previous __APPNAME__ ^(PID %OLDPID%^) ...
taskkill /PID %OLDPID% /F >nul 2>nul
rem 等端口真的放开：偶尔要一两秒
for /l %%i in (1,1,10) do (
  netstat -ano | findstr /r /c:":%PORT%[^0-9].*LISTENING" >nul || exit /b 0
  timeout /t 1 /nobreak >nul
)
echo [WARN] Port %PORT% is still busy - starting anyway; node will say if it cannot bind.
exit /b 0
