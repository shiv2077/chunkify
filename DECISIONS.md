# Architecture decisions

Chunkify is a no-backend, localStorage single-page app served over `http://localhost:8934`.
The card foundry adds model calls to it. These are the decisions that shaped how.

Last updated 2026-09-19.

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

This machine has an RTX 3060 Laptop GPU with 6144 MiB of VRAM. That budget runs a small quantised
model locally at usable speed. It does not run a model large enough to be trusted as the arbiter of
what is worth studying, and the judge would be competing for the same VRAM as the generator.

### Decision

`role: "generate"` goes straight from the browser to a llama.cpp OpenAI-compatible server on
`http://localhost:8080/v1`. `role: "judge"` goes through the helper to a hosted model, `gpt-4o-mini`
by default. Both endpoints and both model names are settings. `llm.js` is the only file that knows
which role goes where.

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
