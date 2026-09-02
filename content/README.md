# content/ — 给 AITutor-APPLE 的题库快照

`qbank/` 是根目录 `qbank.json`（gitignore，不进 git）的**干净导出**：剥掉了 `usedAt`（本机做题记录）、
排除了 AoPS 键。布局按 Apple 版规划：

- `qbank/by-skill/<lang>/<技能id>.json` — 技能题库（每题带误区 tags，2026-09-01 起 234 份全覆盖；tags 与选项位置对齐，正确项 "ok"，**不能下发客户端**）
- `qbank/legacy-by-standard/<lang>/<条目id>.json` — 老的大纲条目题库（已全量审稿：剔错 42 题并补齐）
- `manifest.json` — 数量、引擎、注意事项

**刷新方式**（在 Node 版机器上，题库有更新之后）：

```bash
node tools/export_apple.mjs
cp -r build/apple-export/qbank content/ && cp build/apple-export/manifest.json content/
```

server.js 不读这个目录；它只是给 Apple 版走 git 的分发通道。语音（330MB）不在 git 里，
需要时跑 `node tools/export_apple.mjs` 拿完整包（含 voice/ 和 index.json）。
