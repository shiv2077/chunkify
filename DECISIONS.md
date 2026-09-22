# Architecture decisions

Chunkify is a no-backend, localStorage single-page app served over `http://localhost:8934`.
The card foundry adds model calls to it. These are the decisions that shaped how.

Last updated 2026-09-22.

---

## ADR-001 — The helper holds the provider key

**Status:** accepted

### Context

Card verification and answer grading call a hosted chat-completions API. That call needs a
provider key. Chunkify has no server and no session: every byte it stores is in the browser's
`localStorage`, under an origin that any page served from the same host can reach, readable from
the devtools console, and included verbatim in the backup file the export feature writes to the
user's Downloads folder.

### Decision

The key lives in the environment of `helper.py`, a local process. The browser posts to
`POST http://localhost:8935/judge` with messages only. The helper attaches the key and forwards
the request. No code path returns the key to the browser, and `/health` reports only whether a key
is configured.

### Rejected alternative — the browser calls the provider directly

Putting the key in a settings field alongside the YouTube API key would have cost nothing to build
and removed a process from the stack. It fails on storage: the export feature serialises all three
localStorage keys into a file the user is told to back up and move between machines. A provider key
with billing attached would ride along in every backup, and the restore path would import someone
else's key on a shared file. Browser-side keys also cannot be rotated without touching every
browser profile that has one.

### Consequences

The judge is unavailable unless the helper runs, so every feature that depends on it is hidden
rather than broken. The key rotates by restarting one process. The backup file is safe to share.

---

## ADR-002 — The helper is a standard-library HTTP handler

**Status:** accepted

### Context

The helper does two things: fetch a transcript and forward a chat completion. Both are request-in,
JSON-out, and neither holds state between calls beyond an on-disk transcript cache.

### Decision

`helper.py` is a single file built on `http.server.ThreadingHTTPServer`, importing only the standard
library. It is started explicitly by `run.sh --helper` and is off by default. Transcripts are cached
as JSON files under `~/.cache/chunkify/transcripts`.

### Rejected alternative — FastAPI with Redis

FastAPI would have brought request validation, generated docs and async I/O; Redis would have given
a real cache with expiry. Together they would also have brought a dependency tree, a virtualenv to
keep in sync, a second daemon to run, and a service to debug when the app failed to start — for an
app whose defining property is that it is three files and a `python3 -m http.server`. The cache is a
transcript keyed by video ID. Transcripts do not change, so expiry is not a feature, and the
filesystem is already a key-value store with unlimited TTL.

### Consequences

The helper starts instantly and has nothing to install. It has no request validation beyond the
explicit checks in the handlers, no auth beyond binding to `127.0.0.1` and a fixed CORS origin, and
it is unsuitable for exposure beyond localhost. Transcript cache entries are evicted by deleting
files.

---

## ADR-003 — Local generator, hosted judge

**Status:** accepted

### Context

The foundry makes two kinds of call. Generation is high volume and low stakes: several candidate
cards per section, most of the total token spend, and a bad card is caught downstream. Verification
is low volume and decisive: it is the gate that decides what enters the review queue, and it judges
whether an answer is grounded in a segment — a discrimination task where a weak model's errors pass
straight through to the user's schedule.

This machine has an RTX 3060 Laptop GPU, of which 5.5 GiB is available for inference. That budget
runs a small quantised model locally at usable speed: `qwen2.5:3b` occupies 1.9 GB and generates a
section's worth of cards in seconds. It does not run a model large enough to be trusted as the arbiter of
what is worth studying, and the judge would be competing for the same VRAM as the generator.

### Decision

`role: "generate"` goes straight from the browser to a local OpenAI-compatible server on
`http://localhost:11434/v1`. That server is Ollama running `qwen2.5:3b`, installed under the user's
home directory. `role: "judge"` goes through the helper to a hosted model, `gpt-4o-mini` by default.
`llm.js` is the only file that knows which role goes where.

Ollama is the local server rather than llama.cpp built from source because it installs without root,
exposes the OpenAI-compatible route the app already speaks, and enforces a JSON schema as a decoding
grammar, which ADR-006 depends on.

### Rejected alternative — run both roles on the local model

One model, no key, no helper, no network, no per-token cost, and the whole feature works on a plane.
It was rejected because the 6144 MiB ceiling forces the generator and the judge to be the same small
model, which makes verification a model grading its own output against the same segment it just
read. That check agrees with itself, and a verification pass that cannot fail is not a gate. Keeping
the judge on a different and stronger model is what makes the verdict mean something.

### Consequences

Verification requires the helper, a key and a network round trip. Generation is free and private.
The split is a routing decision in one module, so moving the judge to a local model later — when a
larger model fits — changes a setting, not a code path.

---

## ADR-004 — Cards live on the chunk

**Status:** accepted

### Context

Chunkify stores everything under three localStorage keys: `chunkify:library`, `chunkify:settings`
and `chunkify:stats`. Cards are generated per section, reviewed per section, and meaningless without
the section's time range and transcript window.

### Decision

Cards are a `cards` array on the chunk object, inside `chunkify:library`. Each card carries its own
`dueAt`, `reps` and `lastRating` — the same field names chunks already use — so `scheduleReview()`
schedules a card without being changed or knowing it is scheduling one.

### Rejected alternative — a fourth storage key, `chunkify:cards`

A separate key would have kept the library object small and let cards be cleared without touching
study history. It was rejected because it introduces a foreign key. Every chunk deletion, every
section split by the Mark button, and every library restore from backup would have to fix up a
second store, and any path that missed one would orphan cards or point them at a time range that no
longer exists. Nesting makes those operations correct by construction: deleting a chunk deletes its
cards, and the export already serialises the whole library, so backup and restore covered cards on
the day they were added without a line of new code.

### Consequences

`chunkify:library` grows with every generated card, against a localStorage quota shared by the whole
origin. Cards cannot be queried without walking the library, which `dueCards()` does on every render
of the library view. Both are acceptable at the scale one person's video library reaches.

---

## ADR-005 — Only verified cards enter the review queue

**Status:** accepted

### Context

The generator produces candidates. Some are answerable only with outside knowledge, some state an
answer the segment does not support, and some repeat a card already in the deck. A card that enters
the queue gets scheduled, resurfaces for months, and trains the user on whatever it asserts.

### Decision

Every candidate is verified before it counts. A card is verified when the judge finds it answerable
from the segment, grounded in the segment, and not a duplicate. Only then does it receive a `dueAt`,
and only a `dueAt` puts it in `dueCards()`. Rejected candidates are stored with their failed checks
and the judge's stated reason, shown struck back in the section's card list, and deletable.

### Rejected alternative — show every generated card and let the user delete the bad ones

This is one fewer model call per card, no judge dependency for generation, and it treats the user as
the arbiter, which they are. It was rejected because it inverts the cost. Reviewing a card takes a
few seconds; noticing that a plausible-looking card is subtly ungrounded takes longer than that and
requires rewatching the segment. Unverified cards would also enter the queue immediately, so the
cost of a bad card is not one bad review but a scheduled series of them stretching out to the 35-day
interval. The judge pass moves that work to the point of generation, where it happens once.

### Consequences

Generating cards for a section costs one generation call plus one judge call per candidate, and
takes proportionally longer. Yield is below the number of cards requested, and the gap between
requested and verified is the number `eval_foundry.py` reports as generation yield and verification
pass rate. Storing rejections makes a bad prompt visible as a pattern of stated reasons rather than
as cards that quietly never appeared.

---

## ADR-006 — The output schema is enforced, not described

**Status:** accepted

### Context

Every card carries a predicted difficulty and the transcript quote it came from. Difficulty is the
input to the calibration measurement, and the quote is what resolves a card to a timestamp.

A 3B model asked in prose for five fields returns the two or three it considers interesting. When
`difficulty` is absent the parser substitutes 0.5, so every card gets an identical prediction, the
reliability curve collapses to a single point, and the Brier score measures nothing. The failure is
silent: cards still appear and still schedule.

### Decision

Generation, verification and grading each send a JSON schema in `response_format`, which the
provider enforces as a decoding grammar rather than a request. The generation schema additionally
bounds `prompt`, `answer` and `quote` with `maxLength`. Strings that hit the cap are trimmed back to
the last complete sentence, or failing that the last complete word.

### Rejected alternative — describe the shape in the prompt and validate afterwards

Putting the shape in the system message costs nothing and works with any provider. It was rejected
because validating afterwards only converts a silent wrong answer into a visible failed one: there
is nothing useful to do with a card that came back without a difficulty except throw it away, and
the model will omit the field again on the retry. Length was the sharper case. Told to keep a cloze
to one short sentence, the model pasted whole paragraphs, overran the token limit, and returned JSON
with no closing brace. Every section long enough to trigger it failed outright. Enforcing length in
the grammar took generation yield from 66.7% to 100% across the same three sections.

### Consequences

The generation schema's length keywords reach only the local generator, because strict mode on
hosted providers accepts a narrower subset. The verification and grading schemas stay within that
subset so they can be judged by either. A reply that still arrives truncated now reports itself as
cut off rather than as malformed JSON.

---

## ADR-007 — The helper chooses the judge model

**Status:** accepted

### Context

ADR-001 puts the provider key in the helper. The model name travelled separately: it was a setting
in the browser, sent with each request, and the helper used its own configured model only as a
fallback.

Those two facts contradict each other. The key determines which provider can be reached and
therefore which models exist. A browser holding `gpt-4o-mini` in a settings field, pointed at a
helper configured for a local provider, produces a request for a model that provider has never
heard of. That is not hypothetical: it is what happened the first time the full pipeline ran, and
every card in the batch was rejected with a 404 recorded as its verification reason.

### Decision

The helper uses its own `CHUNKIFY_JUDGE_MODEL` and ignores any model the client names. The browser
sends messages and nothing else. The judge model input is gone from settings; the settings dialog
reports the model the helper says it is using, read from `/health`.

### Rejected alternative — keep the model in the browser and let the helper fall back

Leaving it client-side lets the model change without restarting the helper, and settings already
held the generator's model, so the two read symmetrically. The symmetry is false. The generator is
keyless and local, so naming its model from the browser costs nothing if it is wrong — the request
simply fails against a server the user controls. The judge is reached through a credential the
browser cannot see, and a model name is only meaningful alongside that credential. Configuration
that depends on the key belongs with the key.

### Consequences

Changing the judge model means an environment variable and a helper restart. The app cannot
misreport which model judged a card, because it no longer holds an opinion about it.

---

## ADR-008 — Prompts live in one file that both readers load

**Status:** accepted

### Context

The card foundry runs in the browser from `cards.js`. `eval_foundry.py` measures that foundry from
the command line, in Python, and its whole purpose is to report what the app does. It began with its
own copy of every prompt and schema, under a comment asking whoever edited one to edit the other.

That comment is not a mechanism. The copies diverge the first time someone tunes a prompt in a hurry,
and when they do the evaluation keeps producing confident numbers about a version of the foundry
that no longer exists. A measurement tool that can silently describe the wrong thing is worse than
none, because it is believed.

### Decision

`prompts.json` holds every system message, user template, token limit and output schema. The browser
fetches it lazily, the first time a model call is made. `eval_foundry.py` reads it from disk at
import. Templates use `{{name}}` placeholders, and both sides implement the same substitution.

### Rejected alternative — generate the Python copy from the JavaScript one

A small build step could have kept a generated file in sync and left `cards.js` as the single
authored source. It was rejected because it adds a build step to an app whose defining property is
that it has none: the file you edit is the file that runs. Generation also fails open. A stale
generated file looks exactly like a fresh one, so the failure mode is the same silent divergence,
merely with an extra command to forget to run.

### Consequences

A prompt change lands in the app and the evaluation at the same moment, with no step to remember.
Card generation now depends on a second HTTP request, served from the same origin as the page, and a
failure to load it reports itself and leaves the rest of the app working. The two substitution
implementations are the remaining duplication; they are five lines each and covered by a test that
renders every template in both and compares.

---

## ADR-009 — A reel is a time range, not a file

**Status:** accepted

### Context

A long talk is hard to start. The same material as a stack of short, self-contained clips is easy,
and that framing is what people already reach for. The obvious way to build it is the way every
other tool does: download the video, cut it, crop it to 9:16, write out files.

### Decision

A reel is `{startSeconds, endSeconds}` plus a title and a one-line hook, stored on the video beside
its sections. Playing one seeks a YouTube player to that range inside a 9:16 frame, which crops the
sides in fill mode or letterboxes the whole frame in fit mode. The clip boundaries are snapped to
transcript lines so a reel starts and ends on a sentence. The model proposes clips in passes of
about five minutes, so its suggestions cover the whole video rather than the opening minutes.

### Rejected alternative — download with yt-dlp and re-encode with ffmpeg

Real files can be posted, sent and watched offline, and cropping could follow the speaker rather
than the centre. It was rejected on every axis that matters here. It breaks the constraint the whole
app is built on: no downloads, no media handling, no backend, which is what keeps this a page and a
static server. It replaces a few bytes of JSON per clip with gigabytes on disk. It turns an instant
operation into a long one with a progress bar and a failure mode. And it redistributes someone
else's video, which streaming through the embedded player does not.

### Consequences

Reels cost nothing to store, appear as soon as the model answers, and keep the view count and the
creator's attribution where they belong. They cannot be exported, shared as files, or watched
offline. Cropping is a fixed centre cut, so a clip whose content sits at the edge of the frame is
better watched in fit mode, which is one button. Reels are for consumption, not study: they carry no
schedule, never enter the review queue, and do not count toward the daily focus goal.
