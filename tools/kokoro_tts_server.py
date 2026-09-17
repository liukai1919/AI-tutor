#!/usr/bin/env python3
"""Kokoro-82M 常驻守护进程：圆圆数学的自然语音后端（2026-09-16 起的推荐跑法）。

和 tools/tts_server.py（CosyVoice 2）接口完全一致，所以 server.js / tools/prevoice.mjs
只要把 config.json 的 tts.url 指过来就能换引擎，讲课、缓存、语音包、合成失败退回浏览器
语音这些逻辑一行都不用动。

为什么换掉 CosyVoice：
① CosyVoice 的 zero_shot 是在模仿一段参考录音（refAudio 留空时用的是仓库自带的真人
   录音 asset/zero_shot_prompt.wav）。我们定了规矩：不克隆任何真人的声音。
   Kokoro 用的是公开的预置音色，不需要参考音。
② Apache-2.0，CPU 就能跑，不需要显卡，也不需要 WSL 常驻一个吃显存的进程。

代价：af_heart 只念英文，Kokoro 没有 CosyVoice 那种同音色跨语言的能力，所以
**中文课和英文课是两个不同的声音**（中文走 zf_* 音色）。

用法：
  .venv-kokoro/bin/python tools/kokoro_tts_server.py [--port 9880]
      [--voice-en af_heart] [--voice-zh zf_xiaoxiao] [--model-dir <快照目录>]

接口：
  GET  /health -> {"ok":bool,"loading":bool,"error":str|null,
                   "engine":str,"voice":{"en":str,"zh":str},"sampleRate":24000}
                  engine / voice 供 tools/prevoice.mjs 开烘前比对：音色对不上，
                  烘出来的 sha1 一条都命不中（见 README 那个坑）。
  POST /synth  -> body JSON {text, lang, speed}，成功返回 audio/wav（24k/mono/16bit）。
                  mode / refAudio / refText / refLang / instruct 这些 CosyVoice 专用
                  字段收到也一律忽略（老配置直接送过来不会报错）。

模型：hexgrad/Kokoro-82M，提交钉死在 MODEL_REVISION。启动时置 HF_HUB_OFFLINE=1，
只读本地快照；缺文件就在 /health 的 error 里写明缺哪个，绝不偷偷联网下载。
先下一次（唯一联网的一步）：
  huggingface-cli download hexgrad/Kokoro-82M --revision <MODEL_REVISION>
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 钉死的模型版本：readalong 2026-09-13 实测过的就是这一版。
# 换版本要连 config.json 里 tts.voice.engine 一起改，否则哈希不变、旧音频继续被命中。
MODEL_REPO = "hexgrad/Kokoro-82M"
MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
ENGINE_ID = "kokoro-82M@" + MODEL_REVISION[:7]
SAMPLE_RATE = 24000

ARGS = None
PIPELINES = {}          # "en"/"zh" -> KPipeline
VOICE_PACKS = {}        # "en"/"zh" -> 音色张量
LOAD_ERR = None
LOADED = False
SYNTH_LOCK = threading.Lock()   # 一次只合成一条，别让几个请求抢 CPU


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


def load_model() -> None:
    """后台线程里加载：一个 KModel，两条管线共用它（中英各一条）。"""
    global LOAD_ERR, LOADED
    try:
        snap = snapshot_dir()
        need = {
            "config": snap / "config.json",
            "weights": snap / "kokoro-v1_0.pth",
            "voice-en": snap / "voices" / f"{ARGS.voice_en}.pt",
            "voice-zh": snap / "voices" / f"{ARGS.voice_zh}.pt",
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
        model = KModel(repo_id=MODEL_REPO, config=str(need["config"]), model=str(need["weights"])).eval()

        def make_pipeline(lang_code, **kw):
            # repo_id 是 0.9.3 之后才有的参数：老版本收不了就退回不传（只影响日志里的告警）
            try:
                return KPipeline(lang_code=lang_code, repo_id=MODEL_REPO, model=model, **kw)
            except TypeError:
                return KPipeline(lang_code=lang_code, model=model, **kw)

        en = make_pipeline("a")                      # a = American English
        # 注意：中文这条不传 en_callable。misaki 只在 version="1.1"（也就是另一个模型
        # Kokoro-82M-v1.1-zh）才会用 en_callable；v1.0 走的是 ZHG2P.legacy_call，
        # 那条路把英文原样塞进音素串，"area" 被当成 IPA 字母 a-r-e-a 念出来
        # （2026-09-16 实测，不是 issue #9 里猜的「跳过不念」，是念错）。
        # 中文讲解里 41.6% 的旁白夹着英文术语，所以中英混排在 zh_to_phonemes() 里自己拼。
        zh = make_pipeline("z")

        PIPELINES["en"], PIPELINES["zh"] = en, zh
        VOICE_PACKS["en"] = en.load_voice(str(need["voice-en"]))
        VOICE_PACKS["zh"] = zh.load_voice(str(need["voice-zh"]))
        LOADED = True
        log(f"模型加载完成 {time.time() - t0:.1f}s（en={ARGS.voice_en} zh={ARGS.voice_zh}）")
    except Exception as e:  # noqa: BLE001 — 失败原因原样报给 /health
        LOAD_ERR = f"{type(e).__name__}: {e}"
        log(f"模型加载失败 {LOAD_ERR}")


# 中文管线不会自己分块：KPipeline 对非英文是一整段过 G2P，音素超过 510 就
# 「Truncating len(ps) == N > 510」直接截掉后半句（数学讲解很容易超）。所以中文在这里
# 按标点自己切成小块，再把音频拼起来。英文管线内部有 en_tokenize 自动分块，整段送即可。
ZH_SPLIT = re.compile(r"(?<=[。！？；!?;\n])")
# v1.1 的 misaki 用来切中英的那条正则，这里照抄：一串拉丁字母（可含空格、撇号、连字符）
# 算一个英文片段，其余算中文片段。
EN_RUN = re.compile(r"([A-Za-z '\-]*[A-Za-z][A-Za-z '\-]*)|([^A-Za-z]+)")
PHONEME_MAX = 510          # KModel 的硬上限，超了 kokoro 自己会截断


def zh_to_phonemes(text: str) -> str:
    """中文 -> 音素串，夹着的英文单词交给英文 G2P（音素照样用中文音色念）。

    v1.0 的 ZHG2P 没有这套拼接（见 load_model 里的说明），所以自己拼：
    阿拉伯数字先过 cn2an 变中文（"1.05" -> "一点零五"），标点按 misaki 的规则映射，
    然后拉丁串走英文 G2P、其余走 legacy_call。
    """
    from misaki.zh import ZHG2P
    import cn2an

    t = cn2an.transform(str(text), "an2cn")
    t = ZHG2P.map_punctuation(t)
    segs = []
    for en_part, zh_part in EN_RUN.findall(t):
        if en_part.strip():
            ps, _ = PIPELINES["en"].g2p(en_part.strip())
            segs.append(str(ps).strip())
        elif zh_part.strip():
            segs.append(ZHG2P.legacy_call(zh_part.strip()))
    return " ".join(s for s in segs if s)


def split_phonemes(ps: str) -> list:
    """音素串还是超过 510 就在空格处再切一刀（保险丝，正常分块之后基本用不上）。"""
    out = []
    while len(ps) > PHONEME_MAX:
        cut = ps.rfind(" ", 0, PHONEME_MAX)
        if cut <= 0:
            cut = PHONEME_MAX
        out.append(ps[:cut])
        ps = ps[cut:].lstrip()
    if ps:
        out.append(ps)
    return out


def zh_chunks(text: str, limit: int) -> list:
    out, cur = [], ""
    for piece in (p for p in ZH_SPLIT.split(text) if p.strip()):
        if cur and len(cur) + len(piece) > limit:
            out.append(cur)
            cur = piece
        else:
            cur += piece
    if cur.strip():
        out.append(cur)
    # 单句就超长（整句没有句末标点）：退一步按逗号顿号切
    final = []
    for c in out:
        while len(c) > limit * 2:
            cut = max(c.rfind("，", 0, limit * 2), c.rfind("、", 0, limit * 2), c.rfind(",", 0, limit * 2))
            if cut <= 0:
                cut = limit * 2 - 1
            final.append(c[:cut + 1])
            c = c[cut + 1:]
        if c.strip():
            final.append(c)
    return final or [text]


def synth(req: dict) -> bytes:
    text = str(req.get("text") or "").strip()
    if not text:
        raise ValueError("text 为空")
    lang = "zh" if str(req.get("lang") or "zh").lower().startswith("zh") else "en"
    speed = float(req.get("speed") or ARGS.speed or 1.0)

    pipeline, pack = PIPELINES[lang], VOICE_PACKS[lang]
    parts = zh_chunks(text, ARGS.zh_chunk_chars) if lang == "zh" else [text]
    gap = [0.0] * int(SAMPLE_RATE * max(0.0, ARGS.chunk_gap))

    samples = []
    for i, part in enumerate(parts):
        # 中文先自己转音素（把夹着的英文单词接上），英文整段交给管线自己分块
        units = split_phonemes(zh_to_phonemes(part)) if lang == "zh" else None
        results = (r for u in units for r in pipeline.generate_from_tokens(u, voice=pack, speed=speed)) \
            if units is not None else pipeline(part, voice=pack, speed=speed)
        for result in results:
            audio = getattr(result, "audio", None)
            if audio is None:
                continue
            samples.extend(audio.detach().cpu().numpy().tolist())
        if gap and i < len(parts) - 1:
            samples.extend(gap)
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
            "voice": {"en": ARGS.voice_en, "zh": ARGS.voice_zh},
            "speed": ARGS.speed,
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
        except Exception as e:  # noqa: BLE001
            log(f"合成失败 {type(e).__name__}: {e}")
            return self._send(500, f"{type(e).__name__}: {e}".encode(), "text/plain; charset=utf-8")
        log(f"合成 ok {len(wav)/1024:.0f}KB 用时{time.time() - t0:.1f}s text={req.get('text','')[:24]!r}")
        self._send(200, wav, "audio/wav")


def main() -> int:
    global ARGS
    parser = argparse.ArgumentParser(description="Kokoro-82M 常驻 TTS 服务")
    parser.add_argument("--port", type=int, default=9880)
    # 默认只听 loopback：/synth 没有鉴权，任何能连上的人都能排队占 CPU。
    # WSL 里绑 127.0.0.1 不影响 Windows 侧的 node 访问（WSL 的端口转发直接打到 VM 的
    # loopback，2026-08-14 实测；转发在 Windows 侧也只监听 127.0.0.1，局域网进不来）。
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--voice-en", default="af_heart")
    # 中文音色还没定案（issue #12 要人试听 zf_xiaobei/xiaoni/xiaoxiao/xiaoyi），
    # 这里先给个临时值；定下来之前别把它写进 config 的哈希。
    parser.add_argument("--voice-zh", default="zf_xiaoxiao")
    parser.add_argument("--speed", type=float, default=1.0, help="请求里没带 speed 时用的默认语速")
    parser.add_argument("--model-dir", default=None, help="快照目录，默认从 HF 缓存里找钉死的那一版")
    parser.add_argument("--zh-chunk-chars", type=int, default=80, help="中文分块字数上限")
    parser.add_argument("--chunk-gap", type=float, default=0.12, help="中文块之间垫多少秒静音")
    ARGS = parser.parse_args()

    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    log(f"listening on {ARGS.host}:{ARGS.port}（{ENGINE_ID}，模型后台加载中）")
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
