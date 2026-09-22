#!/usr/bin/env python3
"""Offline evaluation of the card foundry.

Takes a Chunkify backup export, runs generate + verify over a fixed sample of
sections, and reports whether the foundry is producing usable cards.

Determinism: the sample is chosen by sorting, never by sampling. Model calls run
at temperature 0 and every response is cached on disk under a hash of its exact
request, so a second run over the same input reproduces the first run's output
byte for byte without calling a model at all. Nothing wall-clock enters the
report. Pass --no-cache to force fresh calls.

    python eval_foundry.py chunkify-backup-2026-09-19.json --sample 5

Prompts and schemas come from prompts.json, the same file the browser reads, so
this evaluation always runs what the app runs.

Standard library only. Needs the helper running for transcripts and the judge,
and a local OpenAI-compatible server (Ollama) for generation.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

CACHE_DIR = os.path.expanduser(os.environ.get("CHUNKIFY_CACHE_DIR", "~/.cache/chunkify"))
EVAL_CACHE = os.path.join(CACHE_DIR, "eval-cache")

PROMPTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts.json")

with open(PROMPTS_PATH, encoding="utf-8") as _fh:
    PROMPTS = json.load(_fh)


def fill_template(tpl, **vars):
    """{{name}} -> vars[name]; the same substitution cards.js does."""
    return re.sub(r"\{\{(\w+)\}\}", lambda m: str(vars.get(m.group(1), m.group(0))), str(tpl))


def prompt_messages(spec, **vars):
    return [
        {"role": "system", "content": spec["system"]},
        {"role": "user", "content": fill_template(spec["user"], **vars)},
    ]


QUOTE_ECHO_RE = re.compile(r"""\s*(?:quote|source)\s*[:=]\s*["'\u2018\u201c].*$""", re.I | re.S)


def strip_quote_echo(s):
    return QUOTE_ECHO_RE.sub("", str(s)).strip()


def tidy_truncation(s, cap):
    """maxLength is a hard cut; fall back to the last full sentence or word."""
    if len(s) < cap - 4 or s.endswith((".", "!", "?")):
        return s
    sentence = max(s.rfind("."), s.rfind("!"), s.rfind("?"))
    if sentence > cap * 0.5:
        return s[:sentence + 1]
    word = s.rfind(" ")
    return (s[:word] if word > cap * 0.5 else s).rstrip(" ,;:") + "\u2026"


# ---------- transport ----------

def post_json(url, payload, timeout=180):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def get_json(url, timeout=180):
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return json.loads(res.read().decode())


def chat(messages, *, url, model, max_tokens, schema=None, schema_name="reply", use_cache=True):
    """One chat-completions call, cached by the exact request it makes."""
    payload = {
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": (
            {"type": "json_schema", "json_schema": {"name": schema_name, "strict": True, "schema": schema}}
            if schema else {"type": "json_object"}
        ),
    }
    # the helper picks the judge model; only the generator is named by the client
    if model:
        payload["model"] = model
    key = hashlib.sha256(json.dumps([url, payload], sort_keys=True).encode()).hexdigest()
    path = os.path.join(EVAL_CACHE, f"{key}.json")

    if use_cache and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)["content"]

    data = post_json(url, payload)
    content = data["choices"][0]["message"]["content"]
    os.makedirs(EVAL_CACHE, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"content": content}, fh)
    return content


def parse_json_reply(text):
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    body = fenced.group(1) if fenced else text
    start = min(
        (i for i in (body.find("["), body.find("{")) if i != -1),
        default=-1,
    )
    if start == -1:
        raise ValueError("model reply contained no JSON")
    end = max(body.rfind("]"), body.rfind("}"))
    # no closing bracket after the opening one means the reply stopped mid-JSON,
    # which is a token limit, not malformed output
    if end < start:
        raise ValueError("model reply was cut off before it finished (raise max_tokens or lower --cards)")
    return json.loads(body[start:end + 1])


# ---------- foundry, mirroring cards.js ----------

def transcript_window(segments, start, end):
    return [s for s in segments if s["end"] > start and s["start"] < end]


def window_text(window):
    return " ".join(s["text"] for s in window)


def clamp01(n):
    try:
        v = float(n)
    except (TypeError, ValueError):
        return 0.5
    return min(1.0, max(0.0, v))


def generate_candidates(chunk, window, count, *, gen_url, gen_model, use_cache):
    text = window_text(window)
    if len(text.strip()) < 80:
        raise ValueError("transcript window too short")

    spec = PROMPTS["generate"]
    messages = prompt_messages(spec, label=chunk["label"], text=text[:6000], count=count)
    reply = parse_json_reply(chat(messages, url=f"{gen_url}/chat/completions", model=gen_model,
                                 max_tokens=spec["maxTokens"], schema=spec["schema"],
                                 schema_name=spec["schemaName"], use_cache=use_cache))
    raw = reply if isinstance(reply, list) else reply.get("cards", [])
    out = []
    for c in raw[:count]:
        if not isinstance(c, dict):
            continue
        prompt = tidy_truncation(strip_quote_echo(c.get("prompt", "")), 220)
        answer = tidy_truncation(strip_quote_echo(c.get("answer", "")), 220)
        if not prompt or not answer:
            continue
        out.append({
            "type": "cloze" if c.get("type") == "cloze" else "open",
            "prompt": prompt,
            "answer": answer,
            "difficulty": clamp01(c.get("difficulty")),
        })
    return out


def verify_candidate(card, segment_text, existing, *, helper_url, judge_model, use_cache):
    spec = PROMPTS["verify"]
    messages = prompt_messages(
        spec,
        segment=segment_text[:6000],
        prompt=card["prompt"],
        answer=card["answer"],
        existing="\n".join(f"- {p}" for p in existing) if existing else "(none)",
    )
    v = parse_json_reply(chat(messages, url=f"{helper_url}/judge", model=None,
                             max_tokens=spec["maxTokens"], schema=spec["schema"],
                             schema_name=spec["schemaName"], use_cache=use_cache))
    return {
        "answerable": v.get("answerable") is True,
        "grounded": v.get("grounded") is True,
        "duplicate": v.get("duplicate") is True,
    }


# ---------- calibration over outcomes already in the export ----------

def collect_outcomes(library):
    out = []
    for video in library:
        for chunk in video.get("chunks", []):
            for card in chunk.get("cards", []):
                for h in card.get("history", []):
                    if isinstance(h.get("predicted"), (int, float)) and h.get("outcome") in (0, 1):
                        out.append((float(h["predicted"]), int(h["outcome"])))
    return out


def brier(outcomes):
    if not outcomes:
        return None
    return sum((p - o) ** 2 for p, o in outcomes) / len(outcomes)


def expected_calibration_error(outcomes, bins=5):
    if not outcomes:
        return None
    buckets = [[] for _ in range(bins)]
    for p, o in outcomes:
        buckets[min(bins - 1, int(p * bins))].append((p, o))
    total = len(outcomes)
    err = 0.0
    for b in buckets:
        if not b:
            continue
        mean_p = sum(p for p, _ in b) / len(b)
        obs = sum(o for _, o in b) / len(b)
        err += (len(b) / total) * abs(mean_p - obs)
    return err


# ---------- sample selection ----------

def pick_sample(library, size):
    """Deterministic: sort every section, take the first N. No randomness."""
    rows = []
    for video in library:
        for chunk in video.get("chunks", []):
            rows.append((str(video.get("id", "")), float(chunk.get("startSeconds", 0)), str(chunk.get("id", "")), video, chunk))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    return [(v, c) for _, _, _, v, c in rows[:size]]


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description="Evaluate the Chunkify card foundry over an exported library.")
    ap.add_argument("backup", help="a chunkify-backup-*.json export")
    ap.add_argument("--sample", type=int, default=5, help="sections to evaluate (default 5)")
    ap.add_argument("--cards", type=int, default=4, help="cards requested per section (default 4)")
    ap.add_argument("--helper", default="http://localhost:8935", help="helper base URL")
    ap.add_argument("--gen-url", default="http://localhost:11434/v1", help="local OpenAI-compatible base URL (Ollama)")
    ap.add_argument("--gen-model", default="qwen2.5:3b")
    ap.add_argument("--judge-model", default=None,
                    help="informational only; the helper picks the judge model it holds a key for")
    ap.add_argument("--no-cache", action="store_true", help="ignore the response cache and call the models")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = ap.parse_args()

    helper = args.helper.rstrip("/")
    gen_url = args.gen_url.rstrip("/")
    use_cache = not args.no_cache

    with open(args.backup, encoding="utf-8") as fh:
        backup = json.load(fh)
    if backup.get("app") != "chunkify":
        sys.exit(f"{args.backup} is not a Chunkify backup.")

    library = backup.get("library", [])
    sample = pick_sample(library, args.sample)
    if not sample:
        sys.exit("The backup contains no sections to evaluate.")

    requested = 0
    produced = 0
    verified = 0
    difficulties = []
    verified_difficulties = []
    fail_counts = {"answerable": 0, "grounded": 0, "duplicate": 0}
    errors = []
    per_section = []

    for video, chunk in sample:
        label = f"{video.get('id', '?')}/{chunk.get('label', '?')}"
        requested += args.cards
        try:
            data = get_json(f"{helper}/transcript?videoId={urllib.parse.quote(video['id'])}")
            window = transcript_window(data.get("segments", []), chunk["startSeconds"], chunk["endSeconds"])
            if not window:
                raise ValueError("no transcript lines in this section")
            segment_text = window_text(window)
            cands = generate_candidates(chunk, window, args.cards,
                                        gen_url=gen_url, gen_model=args.gen_model, use_cache=use_cache)
        except (urllib.error.URLError, ValueError, KeyError, OSError) as e:
            errors.append(f"{label}: {e}")
            per_section.append({"section": label, "produced": 0, "verified": 0, "error": str(e)})
            continue

        produced += len(cands)
        kept = []
        for card in cands:
            difficulties.append(card["difficulty"])
            try:
                checks = verify_candidate(card, segment_text, [c["prompt"] for c in kept],
                                          helper_url=helper, judge_model=args.judge_model, use_cache=use_cache)
            except (urllib.error.URLError, ValueError, KeyError, OSError) as e:
                errors.append(f"{label}: verification failed: {e}")
                continue
            if not checks["answerable"]:
                fail_counts["answerable"] += 1
            if not checks["grounded"]:
                fail_counts["grounded"] += 1
            if checks["duplicate"]:
                fail_counts["duplicate"] += 1
            if checks["answerable"] and checks["grounded"] and not checks["duplicate"]:
                kept.append(card)
                verified_difficulties.append(card["difficulty"])

        verified += len(kept)
        per_section.append({"section": label, "produced": len(cands), "verified": len(kept)})

    outcomes = collect_outcomes(library)
    mean = lambda xs: (sum(xs) / len(xs)) if xs else None

    report = {
        "input": os.path.basename(args.backup),
        "sections_evaluated": len(sample),
        "cards_requested": requested,
        "cards_produced": produced,
        "cards_verified": verified,
        "generation_yield": (produced / requested) if requested else None,
        "verification_pass_rate": (verified / produced) if produced else None,
        "mean_predicted_difficulty": mean(difficulties),
        "mean_predicted_difficulty_verified": mean(verified_difficulties),
        "rejections": fail_counts,
        "graded_outcomes": len(outcomes),
        "brier_score": brier(outcomes),
        "calibration_error": expected_calibration_error(outcomes),
        "per_section": per_section,
        "errors": errors,
    }

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return

    pct = lambda v: "—" if v is None else f"{v * 100:.1f}%"
    num = lambda v: "—" if v is None else f"{v:.3f}"

    print(f"card foundry evaluation — {report['input']}")
    print(f"  sections evaluated      {report['sections_evaluated']}")
    print(f"  cards requested         {requested}")
    print(f"  cards produced          {produced}")
    print(f"  cards verified          {verified}")
    print(f"  generation yield        {pct(report['generation_yield'])}")
    print(f"  verification pass rate  {pct(report['verification_pass_rate'])}")
    print(f"  mean predicted difficulty")
    print(f"    all candidates        {num(report['mean_predicted_difficulty'])}")
    print(f"    verified only         {num(report['mean_predicted_difficulty_verified'])}")
    print("  rejected for")
    print(f"    not answerable        {fail_counts['answerable']}")
    print(f"    not grounded          {fail_counts['grounded']}")
    print(f"    duplicate             {fail_counts['duplicate']}")
    print(f"  graded outcomes in file {len(outcomes)}")
    print(f"    brier score           {num(report['brier_score'])}")
    print(f"    calibration error     {num(report['calibration_error'])}")
    if per_section:
        print("  per section")
        for row in per_section:
            suffix = f"  [{row['error']}]" if row.get("error") else ""
            print(f"    {row['verified']}/{row['produced']}  {row['section']}{suffix}")
    if errors:
        print(f"  {len(errors)} error(s) above")


if __name__ == "__main__":
    main()
