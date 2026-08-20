# Yuanyuan Math 🧮

*[中文版 →](README.zh.md) · [Project website](https://liukai1919.github.io/AI-tutor/)*

An AI math tutor for kids: give it a problem (typed or photographed), and it explains it step by step,
with pictures, read aloud — then shows the answer to check plus one practice problem of the same kind.
**Supports Chinese and English** (one-click switch in the top right — explanations, UI, and voice all follow).

Runs on your own computer or a Raspberry Pi. **No API key needs to go in the webpage** — it automatically
borrows whichever AI tool is already logged in on your machine.

## Try it live (no install)

A free demo runs at **[ai-tutor-olive-eight.vercel.app](https://ai-tutor-olive-eight.vercel.app/)** — the
BC curriculum lessons, quizzes and unit tests, instantly, no signup, with the same pre-baked natural
voice as the installer. Kid login: tap the avatar, PIN `1234`. Parent login: `demo` / `demo1234`. It's a
serverless deployment with no AI engine attached, so photo questions aren't available there (that's what
the installer below is for) — and there's no persistent storage, so anything you change resets whenever
the instance recycles.

## Just install it (for people who don't want to tinker)

Grab the package for your system from [Releases](https://github.com/liukai1919/AI-tutor/releases). Install, double-click the icon, and lessons start —
**no Node, no AI setup, no internet, no accounts on anyone's server**:

| System | Download | How to install |
|---|---|---|
| Windows | `YuanyuanMath-x.y.z-win-x64-setup.exe` | Double-click, next-next-done. Installs into your own user folder — no administrator rights needed. Windows may warn "unknown publisher" the first time (this build has no code-signing certificate); click "More info → Run anyway". |
| Windows (no install) | `YuanyuanMath-x.y.z-win-x64.zip` | Unzip anywhere, double-click `圆圆数学.bat` inside. |
| macOS | `YuanyuanMath-x.y.z-mac.tar.gz` | Double-click to expand → drag `圆圆数学.app` into Applications (drag first — otherwise macOS runs it from a read-only spot and nothing can be saved) → run `xattr -dr com.apple.quarantine "/Applications/圆圆数学.app"` once in Terminal to clear the quarantine flag (also unsigned, so Gatekeeper blocks it; no Terminal? double-click it once, let it get blocked, then System Settings → Privacy & Security → "Open Anyway". The old "right-click → Open" trick was removed in macOS 15). One-time only. |

Your browser opens http://localhost:8434 automatically. Create a parent account, then an account for
your child, and you're going. An iPad or phone on the same Wi-Fi works too — use the "LAN access"
address printed in the window.

**Where your data lives / is upgrading safe**: accounts, learning progress, the accumulated quiz bank
and your config are stored in the system's per-user data folder (Windows `%APPDATA%\YuanyuanMath`,
macOS `~/Library/Application Support/YuanyuanMath`), so **upgrading, reinstalling, or uninstalling and
installing again never loses them**. The one manual step is for macOS users upgrading from 1.0.0, which
kept data inside the .app bundle (exactly the problem that got fixed): **before** replacing the .app,
right-click the old `圆圆数学.app` → "Show Package Contents", and copy the `data` folder plus
`config.json` and `qbank.json` from `Contents/Resources/app/` into a folder you create at
`~/Library/Application Support/YuanyuanMath/`, then install the new version. Windows upgrades from
1.0.0 need nothing: install the new version (zip users: extract over the old folder) and the first
launch takes over the old data automatically.

**What's already in the box** (none of it needs an AI engine):

- **Every lesson** in the BC Grade 4-7 math curriculum, in both Chinese and English — instant, works offline
- The matching **quiz bank** for each topic
- A **unit test** for every unit (5 per grade, in both languages)
- **Natural-sounding voice** in both languages, pre-synthesized with CosyVoice — not the robotic browser voice

**What still needs an AI engine** (next section; Ollama is free and offline):

- Asking your own question — typed or photographed
- FSA practice sets (province-wide assessment style, Grades 4 and 7 only)
- The parent's "full progress report"
- Anything that asks for fresh content — "write me another test", "explain it a different way"

Without an engine you won't hit error popups — the UI tells you plainly which paths are open.

## Supported AI engines (optional; installing one unlocks photo questions)

| Engine | How it's billed | Supports photos of problems |
|---|---|---|
| **Claude Code** (`claude` CLI) | Your Claude subscription | ✅ |
| **Grok Build** (`grok` CLI) | Your Grok account, pay-per-use | ❌ (type the problem instead) |
| **Gemini CLI** (`gemini`) | Google's free tier | ✅ |
| **Codex** (`codex` CLI) | Your OpenAI login | ❌ |
| **Ollama (local model)** | Completely free, offline | ✅ (needs a vision-capable model, e.g. qwen) |
| Anthropic / OpenAI-compatible API | Key in `config.json` (server-side) | ✅ |

If you have more than one installed, it auto-picks one by default — or choose manually from ⚙️ in the top right of the page.

## Quick start (Windows / Mac / Linux)

Requires Node.js 18+ (https://nodejs.org).

```bash
node server.js
```

On Windows you can just double-click `start.bat`. Then open the address shown in the terminal in your
browser (default http://localhost:8434). To use it on a phone or tablet on the same Wi-Fi, visit the
"LAN access" address shown in the terminal.

## Configuration (config.json)

```jsonc
{
  "port": 8434,
  "registrationCode": "",    // registration closes itself once the first parent exists; set an invite code to open it for another family
  "provider": "auto",        // pin a specific engine: ollama | grok | claude | gemini | codex | anthropic | openai
  "providerByTask": {        // route engines per task (optional). Task names match the usage ledger:
    "quiz": "ollama",        //   teach / ask (photo questions) / quiz / unit / fsa / report /
    "ask": "claude"          //   pregen:teach|quiz|unit (build-time batches) / judge:teach|quiz|unit (build-time review)
  },                         // if a routed engine is down, falls back to provider / auto — never blocks a lesson
  "ollama": {
    "url": "http://localhost:11434",
    "model": "",             // leave blank to auto-pick; the qwen family is recommended (good at math, supports Chinese and vision)
    "think": true            // turning this off speeds things up but hurts math accuracy — not recommended
  },
  "anthropic": { "apiKey": "", "model": "claude-opus-5" },
  "openai": { "baseUrl": "", "apiKey": "", "model": "" },  // for OpenAI-compatible services like OpenRouter/xAI
  "tts": { ... }               // natural voice (optional), see the "Natural Voice" section below
}
```

Environment variables `PORT` and `REGISTRATION_CODE` override the corresponding settings.
(The old `accessCode` is deprecated: access control is now handled by the account system below, and the
setting is ignored if present.)

## Accounts: parent / student roles

The first time you open the page you'll see a **setup wizard**: create a parent account (username +
password), then create the child's account (name + a 4–6 digit PIN — no email needed). After that the app
opens on a **picker screen**: kids tap their own name and enter their PIN; parents sign in from the
"I'm a parent" link in the corner. Sign-ins last 60 days (sliding renewal, survives server restarts).

**Permission split** (enforced server-side, not just hidden buttons):

| | Student (kid account) | Parent |
|---|---|---|
| Ask questions, learn the curriculum, quizzes, unit tests / FSA sets | ✅ | ✅ |
| View/replay their own lesson history, self-report practice | ✅ | ✅ |
| Switch grade/book, language | ✅ | ✅ |
| 📊 Parent report, marking topics solid ★ | ❌ | ✅ |
| Generating the **full progress report** (AI-written, see below) | ❌ | ✅ |
| Deleting records / clearing data | ❌ | ✅ |
| Choosing the AI engine (kids always use the config default) | ❌ | ✅ |
| Creating / renaming / PIN-resetting / deleting kid accounts | ❌ | ✅ |

- **Temporary parent unlock on the kid's device**: while a kid is signed in, tapping 📊 (or any parent
  feature) pops up a parent sign-in; once verified, the page enters "parent mode" (with a badge at the
  top). **Closing the tab exits automatically** and leaves the kid signed in.
- **Multiple kids**: parents can add more kids in ⚙️ Settings; each kid's progress, history, papers (FSA sets and unit tests) and
  reports are fully separate (stored under `data/kids/<kid-id>/`). The quiz question bank is shared by the
  whole family (saves engine cost). Parents switch between kids with the "current child" selector.
- **Old data migrates automatically**: the legacy root-level `progress.json` / `history.json` /
  `fsa-sets.json` are moved into the **first kid you create**, losing nothing.
- Forgot a password? For a parent password, delete that entry from `data/users.json` on the server and
  register again (kid data is untouched). Kid PINs are reset by the parent in Settings.
- Brute-force protection: 5 wrong attempts from the same device locks sign-in for 30 seconds.
- Technical notes: passwords/PINs are stored with scrypt + per-user salt in `data/users.json`; session
  tokens live in `data/sessions.json`; voice audio URLs (content-hashed) and the static page itself are
  unauthenticated — the audio files are unguessable cache entries and the page contains no secrets.

## Full progress report (parent-only)

The "**Generate full report**" button at the top of the 📊 report: Ms. Yuanyuan turns the child's complete
learning data (four-tier distribution, right/wrong by strand, weak spots, the last 14 days of activity,
unit-test and FSA score trends) into a **written report with commentary and advice** — an overall summary, strand-by-strand
analysis, highlights, areas that need work (each with a 5–10 minute at-home practice idea), tips for
parents, and what to learn next.

To keep the AI from inventing numbers, the report has two layers: **all statistics are computed
deterministically by the server** (shown in the "data appendix" at the end), and the AI only writes the
narrative around them. Generating one takes about 1–2 minutes (one AI call) and it's archived automatically
in `data/kids/<kid-id>/reports.json` (the latest 50 per kid) — reopen, compare, or print any time without
regenerating.

## Natural voice (optional, CosyVoice 2)

By default it uses the child's device's built-in browser text-to-speech (free, zero setup, but a bit robotic).
If the server machine has [CosyVoice 2](https://github.com/FunAudioLLM/CosyVoice) installed (a local model,
Apache-2.0 licensed, needs 2–4GB VRAM, also runs on CPU), lessons will switch to a natural, human-sounding
voice — the same voice for both Chinese and English.

**Recommended setup: a persistent daemon** (the model loads once, then each step takes 2–9 seconds to voice).
Start `tools/tts_server.py` inside CosyVoice's own Python environment:

```bash
# In an environment with CosyVoice installed (usually WSL on Windows):
python tools/tts_server.py --port 9880
# If the model isn't at ~/tts/CosyVoice: --repo /path/CosyVoice [--model-dir ...]
```

The daemon listens on `127.0.0.1` only — `/synth` has no auth, so anyone who can reach it can queue
work onto your GPU. Running it inside WSL still works for the Node server on Windows (WSL's port
forwarding reaches the VM's loopback directly; verified). You only need `--host 0.0.0.0` when the
daemon and the Node server live on different machines — add your own firewall rules if so.

Then point config.json at it:

```jsonc
"tts": {
  "enabled": true,
  "url": "http://localhost:9880",   // daemon address (works even from WSL — localhost is auto-forwarded)
  "mode": "zero_shot",              // closest match to the reference voice (default). "instruct" lets you
                                    // control tone with instructions, but some CosyVoice versions will
                                    // read the instruction out loud — verify before switching

  "speed": 1.0,
  "refAudio": "",                   // to change the voice: path to 3+ seconds of clean speech (from the engine's perspective)
  "refText": "",                    // zero_shot mode needs a verbatim transcript of the reference audio
  "refLang": "zh"
}
```

On Windows + WSL, it's best to run the daemon as a systemd service (`systemctl enable --now yuanyuan-tts`,
see the videogen unit file in the same directory as this README for a template) so it recovers with WSL;
**don't** have Node spawn `wsl.exe` on every request — on this kind of setup, wslservice has been observed
to periodically wedge (E_UNEXPECTED), while an already-running daemon and localhost forwarding are unaffected.

If you don't want a persistent daemon, there's also **command mode**:
`"command": ["/path/python", "/path/ai-tutor/tools/tts_batch.py", "{manifest}"]`, which spins up a process
per lesson to synthesize in batch (costs an extra ~12 seconds of model loading each time). If neither `url`
nor `command` is set, it falls back to plain browser speech.

How it works: as soon as a lesson is generated, the server starts synthesizing each step, cached by content
hash in `tts-cache/` (capped at 500MB with automatic cleanup — replaying the same problem is instant). If a
given step isn't ready yet, the frontend waits up to 15 seconds before falling back to browser speech —
**a failure anywhere never blocks the lesson**. English explanations are synthesized cross-lingually with
the same voice, no separate setup needed.

## Deploying to a Raspberry Pi (so kids can use it away from home)

A Raspberry Pi 4/5 works fine (2GB RAM is enough — the AI engine runs in the cloud/on subscription, the Pi
is just a bridge).

### 1. Install Node and this app

```bash
sudo apt update && sudo apt install -y nodejs npm
# copy the whole ai-tutor folder to the Pi, e.g. /home/pi/ai-tutor
cd /home/pi/ai-tutor && node server.js   # run it once manually to confirm it works
```

### 2. Install an AI engine on the Pi (Claude Code or Gemini CLI recommended)

```bash
# Option A: Claude Code (uses your Claude subscription, most reliable for math)
npm install -g @anthropic-ai/claude-code
claude   # follow the prompt to log in once

# Option B: Gemini CLI (generous free tier)
npm install -g @google/gemini-cli
gemini   # log in once

# Option C: skip the CLI and put an API key in config.json's anthropic or openai section
```

> A Raspberry Pi can't run local large models — the Ollama option is meant for a desktop at home, not the Pi.

### 3. Register accounts (first time you open the page)

Open the Pi's address in a browser and follow the setup wizard to create the parent and kid accounts
(see the "Accounts" section above). **Once the first parent is registered, the registration endpoint
closes itself** — anyone else who reaches this server can no longer start a new family. To open it up
for a second family, set `registrationCode` (an invite code) in `config.json`; only people with the
code can then register.

### 4. Start on boot (systemd)

```bash
sudo tee /etc/systemd/system/yuanyuan.service > /dev/null <<'EOF'
[Unit]
Description=YuanYuan Math
After=network.target

[Service]
ExecStart=/usr/bin/node /home/pi/ai-tutor/server.js
WorkingDirectory=/home/pi/ai-tutor
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now yuanyuan
```

### 5. Remote access: use Tailscale (strongly recommended — don't forward router ports)

[Tailscale](https://tailscale.com) is free, secure, and needs no router configuration:

```bash
# on the Pi:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then install the Tailscale app on the kid's tablet/phone and log into the same account. After that, from
anywhere, opening `http://<pi's-tailscale-name>:8434` in a browser just works — traffic is end-to-end
encrypted and strangers can't reach it.

(If you absolutely need direct public access, Cloudflare Tunnel also works. Registration closes itself
after the first parent, so strangers can't start a new family — but public exposure still lets them
guess at your parent password and kid PINs, so avoid it if you can.)

## Learn Along the Curriculum (BC Math Curriculum)

Not just "one problem at a time" — the **"Learn"** tab on the home page teaches systematically, following
the official British Columbia math curriculum (June 2016):

- Pick a grade (**Grades 4–7** are built in) to see every topic in this term's five strands, shown
  bilingually (English is the official wording; Chinese titles are for the child and parent).
- Tap any topic and Ms. Yuanyuan teaches it: a real-life example to introduce it → the core method with
  pictures → 1–2 worked examples → a one-line takeaway. Chinese lessons naturally weave in the English
  term ("小数, called *decimal* in English class") so the child can connect it with what they hear at school.
- At the end of each lesson, the child self-reports right/wrong, which is saved under their own account
  (`data/kids/<kid-id>/progress.json`): a grey dot means not yet learned, blue means taught, green means
  **solid** (answered correctly on 2+ different days). Progress survives a server restart.
- Curriculum data is static JSON generated at build time (`data/curriculum/bc/`), read-only and
  offline-capable at runtime; to re-scrape/proofread it, run `node tools/curriculum/parse_bc.mjs --grade 4`
  (any existing Chinese layer is preserved automatically).
- The 📊 icon in the top right is the **parent report** (parent-only — a kid tapping it gets the parent
  sign-in): a summary by strand ("18 topics this term, X taught, Y solid"), each rated using the same
  four-tier language as a real BC report card (Emerging / Developing / Proficient / Extending), with a
  bilingual explanation of each strand's Big Idea — ready to print and bring to a parent-teacher
  conference. Its top bar can also generate the AI-written **full progress report** (see the dedicated
  section above).
- **Unit tests** (the 📝 button beside every unit heading): a "unit" is one BC curriculum strand, or one
  chapter of a book. When a unit is done, tap 📝 for a test: 8 questions covering **every** topic in that
  unit, ordered basic → applying → challenge (3 / 3 / 2), each tagged with its own topic. Timed; after
  submitting you get the score plus a per-question explanation, and any missed question turns into a lesson
  on that topic with one tap. **Marking and progress are computed server-side** from the stored answer key —
  whatever the browser claims does not count. The three kinds of practice divide the work: the Solid Quiz (⚡)
  drills **one** topic until it is solid; the FSA set (🎯) is province-wide-assessment style and only exists
  for Grades 4/7; the unit test **closes out a unit**, for any grade and any book.
- **FSA practice tests** (Grades 4/7, the 🎯 button inside "Learn"): the FSA is BC's province-wide fall
  numeracy assessment for Grades 4 and 7. Ms. Yuanyuan generates an original 6-question set of FSA-style
  multi-step scenario questions on the spot (distractors are drawn from real common mistakes), timed. After
  submitting, you see the score and a full explanation for each question; every right/wrong answer is
  recorded into the learning progress, and any missed question can be turned into a full lesson on that
  topic with one tap. To practice reading in English (the real test is in English), just switch the UI to
  EN before generating a set.
- **Generate once, reuse forever**: generated papers are saved per kid (FSA sets in
  `data/kids/<kid-id>/fsa-sets.json`, unit tests in `unit-tests.json`) — the "previously
  generated sets" list and each unit's 📝 panel let you open and retake any of them, with every attempt's score
  recorded (only 🎯 / "＋ New test" spends the engine on a *new* one). Quitting part-way records
  "stopped at 3/8" rather than a bad score. Re-tapping a topic you've already been taught
  **replays the last lesson** (instant, voice already cached, no engine cost) — only the 🔄 icon on that
  row regenerates a fresh lesson.

Data source: the official BC website [curriculum.gov.bc.ca](https://curriculum.gov.bc.ca/curriculum/mathematics/4/core);
entries preserve the official wording verbatim and cite their source on the page (BC Curriculum · June 2016).

## History

After every lesson, the server automatically logs the whole thing under the kid's account
(`data/kids/<kid-id>/history.json`, up to 500 entries per kid, rolling eviction). Open the history panel
with 📖 in the top right: search by problem/answer, tap any entry to **replay it exactly as it was** (no
new AI request — instant playback if the voice is cached in `tts-cache`). Deleting entries is a parent
action (sign in as a parent to delete). Photographed problems don't save the photo itself, just a 📷
marker. History follows the server — a problem the child worked through on a tablet shows up when a parent
signs in on a computer and selects that child.

## Usage ledger (usage.jsonl)

Every AI call gets one line of accounting in the data folder (`usage.jsonl`, next to
`config.json`): which task (lesson / photo question / quiz bank / test paper / report /
build-time `pregen:*`), which engine, which model, seconds spent, tokens, and dollars —
whatever the engine reports (the claude CLI, Ollama and the API adapters all do). Failed
calls are logged too — the tokens were already spent, so a retry shows up as two lines.
Lesson-pack / quiz-bank hits are logged as zero-cost lines, so you can see exactly how
many calls the bundled content saved this machine.

Parents can query the summary (by engine, by task, last 20 entries):

```
GET /api/usage            # everything
GET /api/usage?days=30    # last 30 days only
```

This ledger is the foundation for per-task engine routing (`providerByTask` in the
configuration section): first see on paper what each kind of task really costs and how
often it succeeds, then decide who does what — e.g. quiz-bank batches go to a free local
Ollama model while photo questions stay with Claude.

## Notes

- See "Build your own release" below if you want to produce the installers yourself.
- Chinese/English: **the UI defaults to English** (aimed mainly at kids attending English-language
  schools); the "EN / 中" toggle in the top right switches everything — UI, worked examples, explanation
  language, and voice — in one click; it can also be changed in Settings. A language choice saved on a
  device takes priority over the default.
- Voice: uses the natural CosyVoice voice if configured (see above), otherwise falls back to the child's
  device's built-in browser voice (free, doesn't touch the server; Edge's online "Natural" voices sound
  best and are auto-preferred when available). That's why the Windows build (since v1.1.1) launches in an
  Edge app window when Edge is installed — with internet, ad-hoc "ask a question" explanations get a
  natural voice too; without Edge it opens the default browser as before.
- Diagrams (fraction bars, number lines, area grids, bar models) are drawn by the program itself, so they
  are never wrong — the AI only chooses which diagram to use and fills in the numbers.
- The AI occasionally makes arithmetic mistakes when explaining. The final answer is always shown
  prominently and separately — parents are encouraged to double-check it.

## Build your own release

### First: what is and isn't in this repo

Pre-generated content splits two ways. **Text is committed; binaries and live user state are not** —
otherwise the repo would carry hundreds of MB of audio plus a quiz file that changes every time a
child answers a question.

| Thing | In the repo? | Notes |
|---|---|---|
| Lesson pack `data/lessons/` (138) | ✅ yes | 1.2 MB of text — works straight after a clone |
| Unit tests `data/unit-tests/` (40) | ✅ yes | 328 KB of text |
| BC curriculum `data/curriculum/bc/` | ✅ yes | public government material |
| **Quiz bank `qbank.json` (1656 questions)** | ❌ **no** | every answered question writes `usedAt` — it is live state, and committing it would dirty the tree daily |
| **Voice pack `data/voice/` (1075 clips)** | ❌ **no** | 158 MB of binaries; once in git history it can never really be removed |
| User data `data/kids/`, `users.json` | ❌ no | children's learning records and accounts — never belongs in a public repo |
| Build output `build/` | ❌ no | also contains downloaded Node runtimes |

So: **a fresh clone runs and teaches fine** (the lesson pack is complete), but **to build a package
as complete as the published one you have to regenerate two things yourself**:

```bash
# Quiz bank: about 92 minutes, needs an AI engine
node tools/pregen.mjs --only quiz --concurrency 3

# Voice pack: about 3.5 hours, needs the CosyVoice daemon + ffmpeg
node tools/prevoice.mjs --langs zh,en
```

You can package without them — the app just falls back to writing quiz questions live (which needs
an engine) and to the robotic browser voice.

### The three steps

Generate the lessons, bake the voice, then package. Everything lives in `tools/`, and every step is
resumable (Ctrl-C, run it again, finished work is skipped).

```bash
# 1. Lessons + quiz banks + unit tests
#    138 lessons, 138 quiz banks, 40 test papers. Needs an AI engine.
#    Takes three or four hours — run it overnight.
node tools/pregen.mjs --concurrency 3

#    Got a local GPU and want to save subscription quota? Cheap engine generates,
#    strong engine reviews: Ollama writes, Claude checks the math (one review pass
#    costs far less than writing it), rejects regenerate once, still-failing items
#    wait for the next run. Compare the total bill in /api/usage.
node tools/pregen.mjs --provider ollama --judge claude

# 2. Pre-bake the voice (~540 clips per language, three or four hours, ~160 MB)
#    Needs the CosyVoice daemon running plus ffmpeg.
#    You can pass --langs zh for Chinese only, but note the UI defaults to
#    English, so new users land on English lessons — skip English here and
#    they get the robotic browser voice out of the box.
node tools/prevoice.mjs --langs zh,en

# 3. Package (downloads Node runtimes from nodejs.org and verifies SHA256)
node tools/pack.mjs --version 1.0.0
```

Output lands in `build/`: a Windows `setup.exe` and no-install `zip`, plus a macOS `tar.gz`.

Things worth knowing:

- **The Windows `setup.exe` needs Inno Setup**: `winget install JRSoftware.InnoSetup`. Without it the
  script just skips that step and still produces the no-install zip.
- **Neither package is code-signed.** Certificates cost money (a few hundred a year on Windows,
  $99/year from Apple), so first-run is gated by the OS — see "Just install it" above for how users
  get past it. If you plan to hand this to strangers, signing is the first money worth spending.
- **Book courses are excluded by default.** `tools/pregen.mjs --books` and `tools/pack.mjs --books`
  will include them, but the four AoPS titles are copyrighted textbooks — think carefully before
  publicly distributing finished lessons built against their table of contents. The BC curriculum is
  public government material and carries no such restriction. The books' own text
  (`data/curriculum/books/text/`) is never packaged under any flag — that's hard-coded.
- **Voice-pack filenames are hashed from the config.** `prevoice.mjs` always hashes using
  `config.example.json`, and `pack.mjs` ships that same file as `config.json`, so the two line up.
  If you change `tts.mode` / `speed` / `refAudio` on only one side, users will hit zero cached clips.
- User data (`data/kids/`, `users.json`) is created at runtime, so the uninstaller doesn't know about
  it and won't delete it — reinstalling picks up where the child left off.

## License

[MIT](LICENSE). The code and the pre-generated course content in this repo (lessons, quiz banks,
unit tests) are yours to use, modify and redistribute.

Two things are deliberately *not* covered, because they aren't mine to license:

- The **BC curriculum learning standards** the lessons are organized against are © Province of
  British Columbia. This project is not affiliated with or endorsed by the Province.
- The **AoPS textbook text** (`data/curriculum/books/text/`) is copyrighted. It is never committed
  here and never packaged — see "Build your own release" above.
