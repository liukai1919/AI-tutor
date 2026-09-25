#!/usr/bin/env python3
"""Qwen3-TTS（Base 克隆模型）常驻守护进程：接口和 tts_server.py 的 /synth 完全一致，
盲听第二轮的 D 组用它；如果最终选它，config.tts.url 指过来即可，prevoice 零改动。

用法：python qwen_tts_server.py [--port 9882] [--model-dir ~/tts/qwen3-tts/Base]

接口：
  GET  /health -> {"ok":bool,"loading":bool,"error":str|null}
  POST /synth  -> {text, lang, refAudio, refText, ...}，成功返回 audio/wav 字节。
                  refAudio/refText 必填（Qwen 克隆没有默认参考音）；mode/speed/instruct
                  被忽略（Qwen 用参考音定风格，语速由文本和参考音决定）。
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
SYNTH_LOCK = threading.Lock()

LANG_NAME = {"zh": "Chinese", "en": "English"}


def log(msg: str) -> None:
    print(f"[qwen-tts] {msg}", flush=True)


def load_model() -> None:
    global MODEL, MODEL_ERR
    try:
        import torch
        from qwen_tts import Qwen3TTSModel

        model_dir = str(Path(ARGS.model_dir).expanduser().resolve())
        t0 = time.time()
        try:
            MODEL = Qwen3TTSModel.from_pretrained(
                model_dir, device_map="cuda:0", dtype=torch.bfloat16,
                attn_implementation="flash_attention_2")
            log("attn=flash_attention_2")
        except Exception as e:  # noqa: BLE001 — flash-attn 没装/不兼容就退 sdpa
            log(f"flash_attention_2 不可用（{type(e).__name__}），退回 sdpa")
            MODEL = Qwen3TTSModel.from_pretrained(
                model_dir, device_map="cuda:0", dtype=torch.bfloat16,
                attn_implementation="sdpa")
        log(f"模型加载完成 {time.time() - t0:.1f}s")
    except Exception as e:  # noqa: BLE001
        MODEL_ERR = f"{type(e).__name__}: {e}"
        log(f"模型加载失败 {MODEL_ERR}")


def synth(req: dict) -> bytes:
    import soundfile as sf

    text = str(req.get("text") or "").strip()
    if not text:
        raise ValueError("text 为空")
    ref_audio = str(req.get("refAudio") or "")
    ref_text = str(req.get("refText") or "")
    if not ref_audio or not ref_text:
        raise ValueError("Qwen 克隆必须给 refAudio + refText")
    if not Path(ref_audio).expanduser().exists():
        raise FileNotFoundError(f"参考音不存在: {ref_audio}")
    language = LANG_NAME.get(str(req.get("lang") or "zh"), "English")
    wavs, sr = MODEL.generate_voice_clone(
        text=text, language=language,
        ref_audio=str(Path(ref_audio).expanduser()), ref_text=ref_text)
    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, format="WAV")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
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
        deadline = time.time() + 300
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
    parser = argparse.ArgumentParser(description="Qwen3-TTS Base 克隆常驻服务")
    parser.add_argument("--port", type=int, default=9882)
    parser.add_argument("--host", default="127.0.0.1")   # 无鉴权，只听 loopback
    parser.add_argument("--model-dir", default="~/tts/qwen3-tts/Base")
    ARGS = parser.parse_args()

    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    log(f"listening on {ARGS.host}:{ARGS.port}（模型后台加载中）")
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
