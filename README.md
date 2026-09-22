# Chunkify

Turn a long YouTube video into something you can actually finish: short study
sections, spaced review, AI-generated flashcards with a verification gate, and a
vertical reel feed for the days you only want to watch.

Nothing is downloaded. A section and a reel are both just a start and end time
played through the embedded YouTube player, so the whole app is a static page
and a `python3 -m http.server`.

## Quick start

```bash
./run.sh              # app only, no AI features
./run.sh --helper     # app + transcripts + local model (the full thing)
```

Or click the Chunkify icon in your applications menu, which runs the second one.

The app opens in its own window at <http://localhost:8934>.

## What needs what

Everything degrades on its own. A missing piece hides its features; it never
breaks the app.

| Feature | Needs |
|---|---|
| Sections, notes, breaks, spaced review, backup | nothing |
| Auto-detect chapters from the description | a YouTube Data API key (Settings) |
| Reels | helper + local generator |
| Card generation | helper + local generator |
| Card verification, answer grading | helper + a judge |

Three processes when it is all running:

- **:8934** the app, a static file server
- **:8935** `helper.py`, transcripts and the judge proxy
- **:11434** Ollama, the local card and reel generator

## Setup

Transcripts:

```bash
pip install youtube-transcript-api      # or: pip install yt-dlp
```

Local generator. Installed here as v0.34.2, unpacked into your home directory
so it needs no root. Check
<https://github.com/ollama/ollama/releases> for the current version and asset
name — the Linux asset was `.tgz` and is now `.tar.zst`, so confirm before
copying this:

```bash
curl -fL -o /tmp/ollama.tar.zst \
  https://github.com/ollama/ollama/releases/download/v0.34.2/ollama-linux-amd64.tar.zst
mkdir -p ~/.local/ollama && tar --zstd -xf /tmp/ollama.tar.zst -C ~/.local/ollama
~/.local/ollama/bin/ollama pull qwen2.5:3b
```

`run.sh --helper` starts it from `~/.local/ollama/bin/ollama` automatically, or
from `$OLLAMA_BIN` if you put it elsewhere. `qwen2.5:3b` is chosen to leave room
on a 6 GB GPU; a bigger model is a one-line change in Settings.

### The judge

Verification and answer grading go through the helper so the API key never
touches the browser or a backup file. Put it in `~/.config/chunkify/env`, which
lives outside the repo and cannot be committed:

```bash
CHUNKIFY_JUDGE_KEY=sk-...
CHUNKIFY_JUDGE_MODEL=gpt-4o-mini
```

To judge locally instead — no key, no cost, but a much weaker gate, since the
same small model then both writes and approves the cards:

```bash
CHUNKIFY_JUDGE_KEY=local
CHUNKIFY_JUDGE_MODEL=qwen2.5:3b
CHUNKIFY_JUDGE_BASE_URL=http://localhost:11434/v1
```

The shipped default in that file is the local judge, so the whole app works
with no key at all. Settings always shows which judge the helper is actually
using, so the weaker gate is never silent.

## Using it

Paste a YouTube URL, then split the video into sections — paste timestamps,
auto-split by length, or let it read chapters from the description.

While watching: `←` `→` move between sections, `space` plays, `c` marks done,
`n` drops a timestamped note you can click to jump back.

When a section ends you get a recall check. Rate it and it schedules itself:
lost it comes back in ten minutes, shaky tomorrow, got it after 1, 3, 7, 16 then
35 days. Anything due appears at the top of the library.

**■ on a section** generates flashcards from that section's transcript. Each
candidate is checked by the judge for whether it is answerable from the segment,
grounded in it, and not a duplicate. Only cards that pass enter the review queue;
the rest stay visible with the reason they failed.

**Make reels** cuts the whole video into short vertical clips. Arrows or scroll
to move, `space` pauses, `Esc` closes, **Open** jumps to that moment in the full
video.

**📊** shows whether the difficulty predicted for each card matched what actually
happened, as a reliability curve and a Brier score.

**Back up regularly.** Everything lives in this browser's localStorage, so
clearing site data loses all of it. Settings → Download backup.

## Layout

| File | |
|---|---|
| `index.html` `style.css` | structure and presentation |
| `app.js` | sections, player, review scheduling, stats, settings |
| `cards.js` | flashcard generation, verification, grading, calibration |
| `reels.js` | clip selection and the vertical deck |
| `llm.js` | the only file that knows which model a call goes to |
| `backup.js` | export and import |
| `prompts.json` | every prompt and output schema, shared with the eval harness |
| `helper.py` | transcripts, judge proxy |
| `eval_foundry.py` | offline measurement of the card foundry |
| `check_prompts.py` | asserts both readers render prompts identically |
| `DECISIONS.md` | why it is built this way |

No framework, no bundler, no npm. The file you edit is the file that runs.

## Testing

```bash
./run.sh --serve-only
# then open http://localhost:8934/index.html#test
```

Headless:

```bash
google-chrome --headless --virtual-time-budget=6000 --dump-dom \
  "http://localhost:8934/index.html#test" | grep -o '[0-9]*/[0-9]* passed'
```

Check the two prompt readers agree:

```bash
python check_prompts.py
```

Measure the card foundry over an exported library. Responses are cached by
request hash, so a second run reproduces the first exactly:

```bash
python eval_foundry.py chunkify-backup-2026-09-23.json --sample 5
```

## When something is missing

Settings reports the helper's status in plain words. Beyond that:

- **"Helper is not running"** — start it with `./run.sh --helper`.
- **"Local generator is not answering"** — Ollama is down. `~/.local/ollama/bin/ollama serve`.
- **"No transcript backend installed"** — `pip install youtube-transcript-api`.
- **"No English transcript available"** — that video has no captions. Sections
  still work; cards and reels do not.
- **Every card rejected** — check which judge Settings reports. A judge pointed
  at a provider it has no key for fails every card.

Logs: `/tmp/chunkify-server.log`, `/tmp/chunkify-helper.log`, `/tmp/ollama.log`.
