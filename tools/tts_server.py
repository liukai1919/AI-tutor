#!/usr/bin/env python3
"""CosyVoice 2 常驻守护进程：圆圆数学的自然语音后端（推荐跑法）。

为什么是守护进程而不是每次起进程（tts_batch.py）：
① 模型常驻显存，省掉每节课 ~12s 冷加载，单步合成 2-9s；
② 服务器只在启动时碰一次 wsl.exe——这台机器的 wslservice 会周期性 wedge
   （E_UNEXPECTED，见 vediotube-videogen 的 wsl-keepalive.vbs），wedge 只影响
   新建会话，已在跑的进程和 localhost 转发不受影响，HTTP 通道因此免疫。

用法：python tts_server.py [--port 9880] [--repo ~/tts/CosyVoice] [--model-dir ...]

接口：
  GET  /health -> {"ok":bool,"loading":bool,"error":str|null}
  POST /synth  -> body JSON {text, lang, mode, instruct, refAudio, refText,
                             refLang, speed}，成功返回 audio/wav 字节，
                  失败返回 4xx/5xx + 文本原因。
参数含义与 tts_batch.py 的 manifest 一致；没给的用默认。
建议装成 systemd 服务（跟 videogen/comfyui 一样由 keepalive 复活链带活）。
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARGS = None
MODEL = None
MODEL_ERR = None
SYNTH_LOCK = threading.Lock()   # GPU 上一次只合成一条


def log(msg: str) -> None:
    print(f"[tts-server] {msg}", flush=True)


def load_model() -> None:
    global MODEL, MODEL_ERR
    try:
        repo = Path(ARGS.repo).expanduser().resolve()
        model_dir = Path(ARGS.model_dir or repo / "pretrained_models/CosyVoice2-0.5B").expanduser().resolve()
        for p, label in ((repo, "CosyVoice 仓库"), (model_dir, "模型目录")):
            if not p.exists():
                raise FileNotFoundError(f"{label}不存在: {p}")
        sys.path.insert(0, str(repo))
        sys.path.insert(0, str(repo / "third_party/Matcha-TTS"))
        from cosyvoice.cli.cosyvoice import CosyVoice2

        t0 = time.time()
        MODEL = CosyVoice2(str(model_dir), load_jit=False, load_trt=False, fp16=False)
        log(f"模型加载完成 {time.time() - t0:.1f}s")
    except Exception as e:  # noqa: BLE001 — 失败原因原样报给 /health
        MODEL_ERR = f"{type(e).__name__}: {e}"
        log(f"模型加载失败 {MODEL_ERR}")


def synth(req: dict) -> bytes:
    import torch
    import torchaudio

    text = str(req.get("text") or "").strip()
    if not text:
        raise ValueError("text 为空")
    repo = Path(ARGS.repo).expanduser().resolve()
    ref_audio = Path(req.get("refAudio") or repo / "asset/zero_shot_prompt.wav").expanduser()
    if not ref_audio.exists():
        raise FileNotFoundError(f"参考音不存在: {ref_audio}")
    ref_text = req.get("refText") or "希望你以后能够做的比我还好呦。"
    ref_lang = req.get("refLang") or "zh"
    lang = req.get("lang") or ref_lang
    # 默认 zero_shot：instruct 在部分 CosyVoice 版本会把指令念出来（2026-08-12 实测）
    mode = req.get("mode") or "zero_shot"
    speed = float(req.get("speed") or 1.0)

    if mode == "instruct":
        instruct = (req.get("instruct") or {}).get(lang) if isinstance(req.get("instruct"), dict) else req.get("instruct")
        instruct = instruct or "用温柔亲切的语气说这句话。"
        gen = MODEL.inference_instruct2(text, instruct, str(ref_audio), stream=False, speed=speed)
    elif lang == ref_lang:
        gen = MODEL.inference_zero_shot(text, ref_text, str(ref_audio), stream=False, speed=speed)
    else:
        gen = MODEL.inference_cross_lingual(text, str(ref_audio), stream=False, speed=speed)
    chunks = [r["tts_speech"] for r in gen]
    if not chunks:
        raise RuntimeError("引擎没有产出音频段")
    audio = torch.cat(chunks, dim=1)
    buf = io.BytesIO()
    torchaudio.save(buf, audio, MODEL.sample_rate, format="wav")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 默认逐请求刷屏，收敛成自己的 log
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path != "/health":
            return self._send(404, b"not found", "text/plain")
        body = json.dumps({"ok": MODEL is not None, "loading": MODEL is None and MODEL_ERR is None, "error": MODEL_ERR}).encode()
        self._send(200, body, "application/json")

    def do_POST(self):  # noqa: N802
        if self.path != "/synth":
            return self._send(404, b"not found", "text/plain")
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)).decode("utf-8"))
        except Exception:
            return self._send(400, "请求不是合法 JSON".encode(), "text/plain; charset=utf-8")
        # 模型还在加载就等一等（最多 180s），加载失败直接报
        deadline = time.time() + 180
        while MODEL is None and MODEL_ERR is None and time.time() < deadline:
            time.sleep(0.5)
        if MODEL_ERR:
            return self._send(500, f"模型加载失败: {MODEL_ERR}".encode(), "text/plain; charset=utf-8")
        if MODEL is None:
            return self._send(503, "模型还在加载".encode(), "text/plain; charset=utf-8")
        t0 = time.time()
        try:
            with SYNTH_LOCK:
                wav = synth(req)
        except Exception as e:  # noqa: BLE001
            log(f"合成失败 {type(e).__name__}: {e}")
            return self._send(500, f"{type(e).__name__}: {e}".encode(), "text/plain; charset=utf-8")
        log(f"合成 ok {len(wav)/1024:.0f}KB 用时{time.time() - t0:.1f}s text={req.get('text','')[:24]!r}")
        self._send(200, wav, "audio/wav")


def main() -> int:
    global ARGS
    parser = argparse.ArgumentParser(description="CosyVoice 2 常驻 TTS 服务")
    parser.add_argument("--port", type=int, default=9880)
    # 默认只听 loopback：/synth 没有鉴权，任何能连上的人都能排队占 GPU。
    # WSL 里绑 127.0.0.1 不影响 Windows 侧的 node 访问（WSL 的端口转发直接打到 VM 的
    # loopback，2026-08-14 实测；转发在 Windows 侧也只监听 127.0.0.1，局域网进不来）。
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--repo", default="~/tts/CosyVoice")
    parser.add_argument("--model-dir", default=None)
    ARGS = parser.parse_args()

    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    log(f"listening on {ARGS.host}:{ARGS.port}（模型后台加载中）")
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
