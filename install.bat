@echo off
setlocal
cd /d %~dp0

echo ================================================
echo  Yuanyuan Math - install dependencies
echo  (build tools + AI engine CLIs only.
echo  Local models are NOT installed here:
echo  Ollama and the CosyVoice voice engine are
echo  skipped on purpose - see README for those.)
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 18+ from https://nodejs.org and re-run this script.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node.js:  %%v

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found - it normally ships with Node.js. Reinstall Node from https://nodejs.org
  pause
  exit /b 1
)
for /f "delims=" %%v in ('npm -v') do echo npm:      %%v
echo.

echo [1/3] Server + frontend (server.js, public/index.html)
echo       Zero-dependency Node app - nothing to install.
echo.

echo [2/3] Build tool: tools\books (PDF to per-section text/images for book courses)
if exist "tools\books\package.json" (
  pushd tools\books
  call npm install
  if errorlevel 1 (
    echo [WARN] npm install failed in tools\books - the book-scanning scripts may not run.
  ) else (
    echo       OK.
  )
  popd
) else (
  echo       tools\books\package.json not found, skipping.
)
echo       (tools\curriculum\parse_bc.mjs has no dependencies of its own.)
echo.

echo [3/3] AI engine CLIs (so "Explain it" has an engine to call)
where claude >nul 2>nul
if not errorlevel 1 (
  echo       Claude Code: already installed, skipping.
) else (
  echo       Installing Claude Code ^(npm i -g @anthropic-ai/claude-code^) ...
  call npm install -g @anthropic-ai/claude-code
  if errorlevel 1 echo [WARN] Claude Code install failed - install manually later if you want it.
)
where gemini >nul 2>nul
if not errorlevel 1 (
  echo       Gemini CLI: already installed, skipping.
) else (
  echo       Installing Gemini CLI ^(npm i -g @google/gemini-cli^) ...
  call npm install -g @google/gemini-cli
  if errorlevel 1 echo [WARN] Gemini CLI install failed - install manually later if you want it.
)
echo.

echo ================================================
echo  Done.
echo.
echo  Skipped on purpose:
echo   - Ollama (local model)          https://ollama.com
echo   - CosyVoice natural voice/TTS   see README, natural-voice section
echo   - Grok Build / Codex CLIs       no scripted installer here - see their own docs
echo.
echo  If Claude Code / Gemini CLI were just installed, run "claude" or
echo  "gemini" once to sign in before start.bat can use them.
echo ================================================
pause
