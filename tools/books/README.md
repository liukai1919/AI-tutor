# 书籍管线（构建期工具）

把一本教材变成「跟教材学」里的一门课。**运行期（`server.js`）不依赖这个目录**——
它只读 `data/curriculum/books/` 里生成好的静态 JSON 和文本。

```bash
cd tools/books && npm install     # pdfjs-dist + sharp，只装在这个子目录
```

## 一本书要产出两样东西

1. `data/curriculum/books/<bookId>.json` —— 章节结构 + 每小节的条目
   （`en`/`zh` 标题、`pages` 页码范围、`elaborations` 内容概括、`terms`、`teachHints`）。
2. `data/curriculum/books/text/<bookId>/<itemId>.txt` —— 每小节一份**讲课参考**。
   讲课时会附进提示词（要求跟着书的铺垫走，但用自己的话讲、例题换数字）。
   文件不存在也能跑，只是讲解不再贴着原书。

## 先判断 PDF 是哪一类

```bash
node probe_pdf.mjs <书.pdf>
```

看每页的 `textItems`：

- **有文字层**（textItems > 0）→ 用 `extract_text.mjs` 直接抽正文。
- **没有文字层**（每页一张整页图）→ 是扫描件，看 `/Filter` 决定用哪个脚本，
  抽成图片后交给能看图的代理去读、写成内容提要。

## 文字层 PDF

```bash
node extract_text.mjs ../../data/curriculum/books/<bookId>.json <书.pdf> <offset>
```

`offset` = **PDF 页码 − 书上印的页码**。先翻到正文第 1 页看它在 PDF 里是第几页，
减 1 就是 offset（本项目：Prealgebra = 20，Intro Algebra = 18）。

## 扫描件

按压缩格式分两种，都是把每页的图像流从 PDF 里直接抠出来，不需要
poppler / canvas：

```bash
# CCITTFaxDecode（1 位黑白传真压缩）
node scan_ccitt_pages.mjs <书.pdf> <起页> <止页> <输出目录> [宽度=1600]

# DCTDecode（JPEG）—— 直接 dump 字节，零解码
node scan_jpeg_pages.mjs <书.pdf> <输出目录> [起页] [止页]
```

踩过的坑：

- **G4 的极性**：PDF 的 `BlackIs1=false` 对应 TIFF `PhotometricInterpretation=0`。
  按规范推理会推反，解出来整页全黑——已在脚本里按实测值写死。
- **页码偏移必须验证两次**：抽一页图看页脚印的页码反推 offset，再到全书另一头
  验一个点。数论那本拆成两个 PDF，两册偏移不同（−16 / +148），在书第 165 页交接。
- 缩到宽 1500 左右足够看清，再大只是浪费。

## 内容概括怎么来

**不要凭目录猜**。让子代理逐节去读（文字层读 txt、扫描件读页面图），
一章一个代理并行跑，每个代理自己把提要 `Write` 到 `text/<bookId>/`，
只回传 `{id, elaborations, terms, teachHints}`，再按 id 合并进书籍 JSON。
合并时校验 `teachHints` 只能取前端支持的图形名。

实测代理会抓出目录版概括里的实质错误（内容其实在别的小节、书里根本没教那个方法），
所以这一步值得做。
