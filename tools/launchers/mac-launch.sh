#!/bin/bash
# 双击 .app 走这里：先停掉端口上的旧实例，再按芯片挑 node 起服务、开浏览器。
# 打包时由 tools/pack.mjs 原样拷进 Contents/MacOS/launch 并置为可执行。
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../Resources" && pwd)"
ARCH="$(uname -m)"
NODE="$DIR/node-x64"
if [ "$ARCH" = "arm64" ]; then NODE="$DIR/node-arm64"; fi
PORT="${PORT:-8434}"

# 上一次的实例还开着就先关掉，否则浏览器连上的是旧进程。
# 只接管自己人（进程名是 node）；别的程序占着端口就报错让用户处理。
OLD="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$OLD" ]; then
  if ps -p "$OLD" -o comm= 2>/dev/null | grep -qi node; then
    echo "Stopping the previous instance (pid $OLD) ..."
    kill "$OLD" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done
    if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      kill -9 "$OLD" 2>/dev/null || true
      sleep 1
    fi
  else
    echo "Port $PORT is held by another program (pid $OLD). Close it, or start with PORT=8444."
    exit 1
  fi
fi

( sleep 2; open "http://localhost:$PORT" ) &
exec "$NODE" "$DIR/app/server.js"
