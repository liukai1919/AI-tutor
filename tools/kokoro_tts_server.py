#!/usr/bin/env python3
"""Kokoro-82M 常驻守护进程：圆圆数学**英文**旁白的语音后端。

分工（2026-09-16 定）：
  中文 -> CosyVoice 2（tools/tts_server.py，照旧，参考音 zero_shot）
  英文 -> 这个（Kokoro 的公开预置音色 af_heart，不需要参考音）
已经生成过的音频一律不重烘，所以英文课里会同时听到新旧两种声音，这是接受的。
config.json 的 tts.url 可以按语言分别配地址，见 README。

接口和 tools/tts_server.py 保持一致，server.js / tools/prevoice.mjs 不用改调用方式：
  GET  /health -> {"ok":bool,"loading":bool,"error":str|null,
                   "engine":"kokoro-82M@…","voice":{"en":"af_heart"},
                   "speed":float,"device":str,"sampleRate":24000}
                  engine / voice 供 prevoice 开烘前核对，别把英文发错给中文那台。
  POST /synth  -> body JSON {text, lang, speed}，成功返回 audio/wav（24k/mono/16bit）。
                  lang 是 zh 直接 400：英文音色念中文只会念出一堆怪音，宁可让
                  server.js 退回浏览器语音，也不要悄悄用错引擎。
                  mode / refAudio / refText / refLang / instruct 这些 CosyVoice
                  专用字段收到也一律忽略（老配置直接送过来不会报错）。

语速：实际语速 = 请求里的 speed × --speed。config 里的 speed 进语音文件名的哈希、
不能动（动一下已经烘好的 5986 条全部对不上），所以英文语速改由这里的 --speed 调，
它不进哈希 —— 代价是改了以后已经生成的英文不会跟着变。

模型：hexgrad/Kokoro-82M，提交钉死在 MODEL_REVISION。启动时置 HF_HUB_OFFLINE=1，
只读本地快照；缺文件就在 /health 的 error 里写明缺哪个，绝不偷偷联网下载。
先下一次（唯一联网的一步）：
  huggingface-cli download hexgrad/Kokoro-82M --revision <MODEL_REVISION>

用法：
  .venv-kokoro/bin/python tools/kokoro_tts_server.py [--port 9881] [--speed 0.9]
      [--voice-en af_heart] [--device auto|cpu|cuda] [--model-dir <快照目录>]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 钉死的模型版本：readalong 2026-09-13 实测过的就是这一版。
MODEL_REPO = "hexgrad/Kokoro-82M"
MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
ENGINE_ID = "kokoro-82M@" + MODEL_REVISION[:7]
SAMPLE_RATE = 24000

ARGS = None
PIPELINE = None         # 英文管线（lang_code="a"）
VOICE_PACK = None
DEVICE = "cpu"
LOAD_ERR = None
LOADED = False
SYNTH_LOCK = threading.Lock()   # 一次只合成一条，别让几个请求互相抢


def log(msg: str) -> None:
    print(f"[kokoro-tts] {msg}", flush=True)


def snapshot_dir() -> Path:
    """固定版本的本地快照目录。--model-dir 优先，否则按 HF 缓存的标准布局找。"""
    if ARGS and ARGS.model_dir:
        return Path(ARGS.model_dir).expanduser().resolve()
    hub = Path(os.environ.get("HF_HUB_CACHE") or Path(
        os.environ.get("HF_HOME") or (Path.home() / ".cache" / "huggingface")) / "hub")
    name = "models--" + MODEL_REPO.replace("/", "--")
    return (hub / name / "snapshots" / MODEL_REVISION).resolve()


def patch_espeak() -> None:
    """kokoro 自带的 espeak-ng 路径在 macOS 上是坏的，导入 kokoro 之前改掉。

    RA_ESPEAK_LIBRARY / RA_ESPEAK_DATA 可以覆盖（和 readalong 的
    readalong/product/kokoro_adapter.py 用的是同两个变量）。
    Linux / WSL 上 espeakng_loader 自带的 .so 通常能直接用；不行就 apt install espeak-ng
    再用这两个环境变量指过去。
    """
    lib = os.environ.get("RA_ESPEAK_LIBRARY") or ""
    data = os.environ.get("RA_ESPEAK_DATA") or ""
    if sys.platform == "darwin":
        lib = lib or "/opt/homebrew/lib/libespeak-ng.dylib"
        data = data or "/opt/homebrew/share/espeak-ng-data"
    if not lib and not data:
        return
    try:
        import espeakng_loader
    except ImportError:
        return
    if lib and Path(lib).exists():
        espeakng_loader.get_library_path = lambda: lib
        log(f"espeak-ng 库 -> {lib}")
    if data and Path(data).exists():
        espeakng_loader.get_data_path = lambda: data
        log(f"espeak-ng 数据 -> {data}")


def pick_device() -> str:
    """auto = 有 CUDA 就用（Kokoro 只有 8200 万参数，显存占用很小，能和 CosyVoice 共存）。

    装的是 CPU 版 torch 的话 auto 就是 cpu；要上显卡得在这个 venv 里换 CUDA 版 torch。
    """
    import torch

    want = (ARGS.device or "auto").lower()
    if want == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if want == "cuda":
        raise RuntimeError("--device cuda 但 torch.cuda.is_available() 是 False"
                           "（这个 venv 里装的多半是 CPU 版 torch）")
    return "cpu"


def load_model() -> None:
    """后台线程里加载：只要英文这一条管线。"""
    global LOAD_ERR, LOADED, PIPELINE, VOICE_PACK, DEVICE
    try:
        snap = snapshot_dir()
        need = {
            "config": snap / "config.json",
            "weights": snap / "kokoro-v1_0.pth",
            "voice-en": snap / "voices" / f"{ARGS.voice_en}.pt",
        }
        missing = [f"{k} ({p})" for k, p in need.items() if not p.exists()]
        if missing:
            raise FileNotFoundError(
                "快照缺文件：" + "；".join(missing) +
                f"。先下载：huggingface-cli download {MODEL_REPO} --revision {MODEL_REVISION}")

        # 只读本地：任何一次 hf_hub_download 都会在这里直接抛，而不是偷偷拉个别的版本下来
        os.environ["HF_HUB_OFFLINE"] = "1"
        patch_espeak()
        from kokoro import KModel, KPipeline

        t0 = time.time()
        DEVICE = pick_device()
        model = KModel(repo_id=MODEL_REPO, config=str(need["config"]),
                       model=str(need["weights"])).to(DEVICE).eval()
        # repo_id 是 0.9.3 之后才有的参数：老版本收不了就退回不传（只影响日志里的告警）
        try:
            PIPELINE = KPipeline(lang_code="a", repo_id=MODEL_REPO, model=model)   # a = American English
        except TypeError:
            PIPELINE = KPipeline(lang_code="a", model=model)
        VOICE_PACK = PIPELINE.load_voice(str(need["voice-en"]))
        LOADED = True
        log(f"模型加载完成 {time.time() - t0:.1f}s（en={ARGS.voice_en} device={DEVICE} speed×{ARGS.speed}）")
    except Exception as e:  # noqa: BLE001 — 失败原因原样报给 /health
        LOAD_ERR = f"{type(e).__name__}: {e}"
        log(f"模型加载失败 {LOAD_ERR}")


class UnsupportedLang(ValueError):
    """中文请求走错了门：调用方应该把它发给 CosyVoice 那台。"""


def synth(req: dict) -> bytes:
    text = str(req.get("text") or "").strip()
    if not text:
        raise ValueError("text 为空")
    lang = str(req.get("lang") or "en").lower()
    if lang.startswith("zh"):
        raise UnsupportedLang(
            "这个守护进程只做英文（af_heart）。中文请发给 CosyVoice 那台"
            "（tools/tts_server.py），config 里 tts.url 可以按语言分开配。")
    # 请求里的 speed 在哈希里、固定是 config 的值；--speed 是不进哈希的语速档位
    speed = float(req.get("speed") or 1.0) * float(ARGS.speed or 1.0)

    samples = []
    # 英文管线内部有 en_tokenize，长段自己会切，整段送进去就行
    for result in PIPELINE(text, voice=VOICE_PACK, speed=speed):
        audio = getattr(result, "audio", None)
        if audio is None:
            continue
        samples.extend(audio.detach().cpu().numpy().tolist())
    if not samples:
        raise RuntimeError("引擎没有产出音频段")
    return to_wav(samples)


def to_wav(samples) -> bytes:
    """float32 [-1,1] -> 24kHz / 单声道 / 16-bit WAV（用标准库，不额外拖 soundfile）。"""
    import array

    pcm = array.array("h", (int(max(-1.0, min(1.0, s)) * 32767) for s in samples))
    if sys.byteorder == "big":
        pcm.byteswap()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
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
        body = json.dumps({
            "ok": LOADED,
            "loading": not LOADED and LOAD_ERR is None,
            "error": LOAD_ERR,
            "engine": ENGINE_ID,
            "voice": {"en": ARGS.voice_en},
            "speed": ARGS.speed,
            "device": DEVICE,
            "sampleRate": SAMPLE_RATE,
        }).encode()
        self._send(200, body, "application/json")

    def do_POST(self):  # noqa: N802
        if self.path != "/synth":
            return self._send(404, b"not found", "text/plain")
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)).decode("utf-8"))
        except Exception:
            return self._send(400, "请求不是合法 JSON".encode(), "text/plain; charset=utf-8")
        # 模型还在加载就等一等（最多 180s），加载失败直接报，让 server.js 退回浏览器语音
        deadline = time.time() + 180
        while not LOADED and LOAD_ERR is None and time.time() < deadline:
            time.sleep(0.5)
        if LOAD_ERR:
            return self._send(500, f"模型加载失败: {LOAD_ERR}".encode(), "text/plain; charset=utf-8")
        if not LOADED:
            return self._send(503, "模型还在加载".encode(), "text/plain; charset=utf-8")
        t0 = time.time()
        try:
            with SYNTH_LOCK:
                wav = synth(req)
        except UnsupportedLang as e:
            return self._send(400, str(e).encode(), "text/plain; charset=utf-8")
        except Exception as e:  # noqa: BLE001
            log(f"合成失败 {type(e).__name__}: {e}")
            return self._send(500, f"{type(e).__name__}: {e}".encode(), "text/plain; charset=utf-8")
        log(f"合成 ok {len(wav)/1024:.0f}KB 用时{time.time() - t0:.1f}s text={req.get('text','')[:24]!r}")
        self._send(200, wav, "audio/wav")


def main() -> int:
    global ARGS
    parser = argparse.ArgumentParser(description="Kokoro-82M 常驻 TTS 服务（只做英文）")
    # 9881 是默认：9880 让给还在跑的 CosyVoice 守护进程（中文还在用它）
    parser.add_argument("--port", type=int, default=9881)
    # 默认只听 loopback：/synth 没有鉴权，任何能连上的人都能排队占机器。
    # WSL 里绑 127.0.0.1 不影响 Windows 侧的 node 访问（WSL 的端口转发直接打到 VM 的
    # loopback，2026-08-14 实测；转发在 Windows 侧也只监听 127.0.0.1，局域网进不来）。
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--voice-en", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0,
                        help="语速倍数，不进哈希；实际语速 = 请求里的 speed × 这个值")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--model-dir", default=None, help="快照目录，默认从 HF 缓存里找钉死的那一版")
    ARGS = parser.parse_args()

    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    log(f"listening on {ARGS.host}:{ARGS.port}（{ENGINE_ID}，只做英文，模型后台加载中）")
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
