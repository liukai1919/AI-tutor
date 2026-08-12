#!/usr/bin/env python3
"""CosyVoice 2 批量合成：圆圆数学的配音端（跑在 WSL 的 cosyvoice conda 环境里）。

与 videogen 的 tts_cosyvoice.py 同源，但为交互式讲题改成批量：
一次加载模型，把整节课所有步骤逐条合成，冷加载 ~12s 只付一次。

用法：python tts_batch.py manifest.json

manifest 结构（由 server.js 生成，路径都是本机/WSL 视角）：
{
  "repo": null,                // CosyVoice 仓库，默认 ~/tts/CosyVoice
  "modelDir": null,            // 权重目录，默认 <repo>/pretrained_models/CosyVoice2-0.5B
  "outDir": "/mnt/d/ai-tutor/tts-cache",
  "speed": 1.0,
  "mode": "instruct",          // instruct | zero_shot
  "refAudio": null,            // 参考音，默认 <repo>/asset/zero_shot_prompt.wav
  "refText": "希望你以后能够做的比我还好呦。",   // zero_shot 模式需要与参考音逐字匹配
  "refLang": "zh",
  "instruct": {"zh": "...", "en": "..."},        // instruct 模式的语气指令
  "items": [{"id": "sha1", "text": "……", "lang": "zh"}]
}

每条产出 <outDir>/<id>.wav；先写 <id>.tmp.wav 再原子改名，
server.js 用「最终文件存在」判断就绪。逐条打进度行，方便排查。
退出码：0 全成，2 部分失败，1 致命错误。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path


def log(msg: str) -> None:
    print(f"[tts] {msg}", flush=True)


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: tts_batch.py manifest.json", file=sys.stderr)
        return 1
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))

    repo = Path(manifest.get("repo") or "~/tts/CosyVoice").expanduser().resolve()
    model_dir = Path(
        manifest.get("modelDir") or repo / "pretrained_models/CosyVoice2-0.5B"
    ).expanduser().resolve()
    ref_audio = Path(
        manifest.get("refAudio") or repo / "asset/zero_shot_prompt.wav"
    ).expanduser().resolve()
    out_dir = Path(manifest["outDir"]).expanduser().resolve()
    ref_text = manifest.get("refText") or "希望你以后能够做的比我还好呦。"
    ref_lang = manifest.get("refLang") or "zh"
    # 默认 zero_shot：instruct 在部分 CosyVoice 版本会把指令念出来（2026-08-12 实测）
    mode = manifest.get("mode") or "zero_shot"
    speed = float(manifest.get("speed") or 1.0)
    instruct = manifest.get("instruct") or {}
    items = [
        it for it in manifest.get("items") or []
        if it.get("id") and (it.get("text") or "").strip()
    ]

    for path, label in ((repo, "CosyVoice 仓库"), (model_dir, "模型目录"), (ref_audio, "参考音")):
        if not path.exists():
            print(f"{label}不存在: {path}", file=sys.stderr)
            return 1
    if not items:
        log("没有要合成的条目")
        return 0
    out_dir.mkdir(parents=True, exist_ok=True)

    # 全部命中缓存就不必加载模型（提交任务与执行之间可能已被别的任务补齐）。
    todo = [it for it in items if not (out_dir / f"{it['id']}.wav").exists()]
    if not todo:
        log("全部命中缓存")
        return 0

    # CosyVoice 不发 pip 包，靠 sys.path 进来；Matcha-TTS 是它 vendor 的依赖。
    sys.path.insert(0, str(repo))
    sys.path.insert(0, str(repo / "third_party/Matcha-TTS"))
    import torch
    import torchaudio
    from cosyvoice.cli.cosyvoice import CosyVoice2

    t0 = time.time()
    model = CosyVoice2(str(model_dir), load_jit=False, load_trt=False, fp16=False)
    log(f"模型加载 {time.time() - t0:.1f}s，待合成 {len(todo)} 条，mode={mode}")

    ok = fail = 0
    for it in todo:
        item_id, text, lang = it["id"], it["text"].strip(), it.get("lang") or ref_lang
        final = out_dir / f"{item_id}.wav"
        tmp = out_dir / f"{item_id}.tmp.wav"
        t1 = time.time()
        try:
            # 参考音传路径：当前版 frontend 自己按目标采样率加载（videogen 实测）。
            if mode == "instruct":
                ins = instruct.get(lang) or instruct.get("zh") or "用温柔亲切的语气说这句话。"
                gen = model.inference_instruct2(text, ins, str(ref_audio), stream=False, speed=speed)
            elif lang == ref_lang:
                gen = model.inference_zero_shot(text, ref_text, str(ref_audio), stream=False, speed=speed)
            else:
                gen = model.inference_cross_lingual(text, str(ref_audio), stream=False, speed=speed)
            chunks = [r["tts_speech"] for r in gen]
            if not chunks:
                raise RuntimeError("引擎没有产出音频段")
            audio = torch.cat(chunks, dim=1)
            torchaudio.save(str(tmp), audio, model.sample_rate)
            os.replace(tmp, final)
            ok += 1
            log(f"{item_id} ok {audio.shape[1] / model.sample_rate:.2f}s 用时{time.time() - t1:.1f}s")
        except Exception as e:  # 单条失败不拖垮整批
            fail += 1
            tmp.unlink(missing_ok=True)
            log(f"{item_id} fail {type(e).__name__}: {e}")

    log(f"done ok={ok} fail={fail}")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
