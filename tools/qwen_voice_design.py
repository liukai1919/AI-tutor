#!/usr/bin/env python3
"""一次性：用 Qwen3-TTS VoiceDesign 按文字描述"设计"圆圆老师的声音，出 N 条候选参考音。

设计出来的 wav 之后当 Base 克隆模型的参考音用（中英都克隆同一条，保证同一个"人"）。
跑完就退出、释放显存；候选给家长试听，选中哪条把它喂给 qwen_tts_server 的 refAudio。

用法：python qwen_voice_design.py --out /mnt/d/ai-tutor/build/voice-abtest2/ref [--n 3]
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

# 克隆参考音的台词：两句、约 10 秒，无数字（refText 必须和它一字不差）
DESIGN_TEXT = ("Hello, my friend! I'm Miss Yuanyuan, your math teacher. "
               "Learning math is like a little adventure, and we're going to explore it together, step by step.")
DESIGN_INSTRUCT = ("A warm, friendly young female elementary school teacher in her mid-twenties. "
                   "Clear, bright, natural voice, standard neutral American English pronunciation, "
                   "moderate pace with gentle enthusiasm - encouraging and patient, "
                   "never exaggerated, never childish.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--n", type=int, default=3)
    parser.add_argument("--model-dir", default="~/tts/qwen3-tts/VoiceDesign")
    args = parser.parse_args()

    import torch
    import soundfile as sf
    from qwen_tts import Qwen3TTSModel

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    model_dir = str(Path(args.model_dir).expanduser().resolve())
    t0 = time.time()
    try:
        model = Qwen3TTSModel.from_pretrained(model_dir, device_map="cuda:0", dtype=torch.bfloat16,
                                              attn_implementation="flash_attention_2")
    except Exception:  # noqa: BLE001
        model = Qwen3TTSModel.from_pretrained(model_dir, device_map="cuda:0", dtype=torch.bfloat16,
                                              attn_implementation="sdpa")
    print(f"VoiceDesign 加载 {time.time() - t0:.1f}s", flush=True)

    for i in range(1, args.n + 1):
        t0 = time.time()
        wavs, sr = model.generate_voice_design(text=DESIGN_TEXT, language="English", instruct=DESIGN_INSTRUCT)
        f = out / f"design-{i}.wav"
        sf.write(str(f), wavs[0], sr)
        print(f"design-{i}.wav  {len(wavs[0])/sr:.1f}s  用时{time.time() - t0:.1f}s", flush=True)
    (out / "design-text.txt").write_text(DESIGN_TEXT, encoding="utf-8")
    print("DESIGN DONE", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
