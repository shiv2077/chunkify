#!/usr/bin/env python3
"""Chunkify's optional local helper.

Two things the browser cannot do on its own:

  GET  /transcript?videoId=ID   timed transcript segments for a video
  POST /judge                   a chat-completions call whose API key stays here

The key is read from the environment and never leaves this process. The browser
is told nothing about it. If this helper is not running, Chunkify hides every
feature that depends on it and works exactly as it always has.

Standard library only. Transcript fetching uses youtube-transcript-api if it is
installed, otherwise yt-dlp, otherwise it reports which to install.

Environment:
  CHUNKIFY_HELPER_PORT    default 8935
  CHUNKIFY_ALLOW_ORIGIN   default http://localhost:8934
  CHUNKIFY_JUDGE_BASE_URL default https://api.openai.com/v1
  CHUNKIFY_JUDGE_MODEL    default gpt-4o-mini
  CHUNKIFY_JUDGE_KEY      required for /judge; falls back to OPENAI_API_KEY
  CHUNKIFY_CACHE_DIR      default ~/.cache/chunkify
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("CHUNKIFY_HELPER_PORT", "8935"))
ALLOW_ORIGIN = os.environ.get("CHUNKIFY_ALLOW_ORIGIN", "http://localhost:8934")
JUDGE_BASE_URL = os.environ.get("CHUNKIFY_JUDGE_BASE_URL", "https://api.openai.com/v1").rstrip("/")
JUDGE_MODEL = os.environ.get("CHUNKIFY_JUDGE_MODEL", "gpt-4o-mini")
JUDGE_KEY = os.environ.get("CHUNKIFY_JUDGE_KEY") or os.environ.get("OPENAI_API_KEY", "")
CACHE_DIR = os.path.expanduser(os.environ.get("CHUNKIFY_CACHE_DIR", "~/.cache/chunkify"))
TRANSCRIPT_CACHE = os.path.join(CACHE_DIR, "transcripts")

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
MAX_BODY_BYTES = 1 << 20


# ---------- transcripts ----------

def _have_module(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def transcript_backend():
    """Which transcript source is available, or None."""
    if _have_module("youtube_transcript_api"):
        return "youtube-transcript-api"
    if shutil.which("yt-dlp") or _have_module("yt_dlp"):
        return "yt-dlp"
    return None


def _from_transcript_api(video_id):
    from youtube_transcript_api import YouTubeTranscriptApi

    # the library renamed its entry point; support both spellings
    if hasattr(YouTubeTranscriptApi, "get_transcript"):
        raw = YouTubeTranscriptApi.get_transcript(video_id, languages=["en", "en-US", "en-GB"])
    else:
        fetched = YouTubeTranscriptApi().fetch(video_id, languages=["en", "en-US", "en-GB"])
        raw = fetched.to_raw_data()

    return [
        {
            "start": round(float(e["start"]), 3),
            "end": round(float(e["start"]) + float(e.get("duration", 0)), 3),
            "text": " ".join(str(e["text"]).split()),
        }
        for e in raw
        if str(e.get("text", "")).strip()
    ]


def _from_yt_dlp(video_id):
    """Auto-subtitles via yt-dlp's json3 format."""
    exe = shutil.which("yt-dlp")
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "sub")
        cmd = [
            "--write-auto-subs", "--write-subs", "--skip-download",
            "--sub-langs", "en.*", "--sub-format", "json3",
            "-o", out, f"https://www.youtube.com/watch?v={video_id}",
        ]
        argv = [exe] + cmd if exe else [sys.executable, "-m", "yt_dlp"] + cmd
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=120)

        files = [f for f in os.listdir(tmp) if f.endswith(".json3")]
        if not files:
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            raise RuntimeError(detail[-1] if detail else "yt-dlp returned no subtitle track")

        with open(os.path.join(tmp, files[0]), encoding="utf-8") as fh:
            data = json.load(fh)

    segments = []
    for event in data.get("events", []):
        text = " ".join("".join(s.get("utf8", "") for s in event.get("segs", [])).split())
        if not text:
            continue
        start = float(event.get("tStartMs", 0)) / 1000.0
        segments.append({
            "start": round(start, 3),
            "end": round(start + float(event.get("dDurationMs", 0)) / 1000.0, 3),
            "text": text,
        })
    return segments


def get_transcript(video_id):
    """Cached on disk: a transcript never changes, and the eval harness reruns."""
    os.makedirs(TRANSCRIPT_CACHE, exist_ok=True)
    path = os.path.join(TRANSCRIPT_CACHE, f"{video_id}.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    backend = transcript_backend()
    if backend is None:
        raise RuntimeError(
            "No transcript backend installed. Run: pip install youtube-transcript-api  (or: pip install yt-dlp)"
        )

    segments = _from_transcript_api(video_id) if backend == "youtube-transcript-api" else _from_yt_dlp(video_id)
    if not segments:
        raise RuntimeError(f"No English transcript available for {video_id}")

    payload = {"videoId": video_id, "source": backend, "segments": segments}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return payload


# ---------- judge ----------

def call_judge(body):
    if not JUDGE_KEY:
        raise PermissionError("No judge key configured. Set CHUNKIFY_JUDGE_KEY before starting the helper.")

    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("Request needs a non-empty 'messages' list.")

    # The helper owns which provider and model it talks to, because it owns the
    # key that goes with them. A client naming a model it cannot authenticate
    # for is how you get a request for gpt-4o-mini sent to a local server.
    payload = {
        "model": JUDGE_MODEL,
        "messages": messages,
        "temperature": body.get("temperature", 0),
    }
    if body.get("response_format"):
        payload["response_format"] = body["response_format"]
    if body.get("max_tokens"):
        payload["max_tokens"] = body["max_tokens"]

    req = urllib.request.Request(
        f"{JUDGE_BASE_URL}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {JUDGE_KEY}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        raise RuntimeError(f"Judge provider returned {e.code}: {detail}")


# ---------- server ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "chunkify-helper"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, status, obj):
        raw = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)

        if url.path == "/health":
            self._send(200, {
                "ok": True,
                "transcript": transcript_backend(),
                "judge": bool(JUDGE_KEY),
                "judgeModel": JUDGE_MODEL,
            })
            return

        if url.path == "/transcript":
            video_id = urllib.parse.parse_qs(url.query).get("videoId", [""])[0]
            if not VIDEO_ID_RE.match(video_id):
                self._send(400, {"error": "videoId must be an 11-character YouTube id."})
                return
            try:
                self._send(200, get_transcript(video_id))
            except Exception as e:
                self._send(502, {"error": str(e)})
            return

        self._send(404, {"error": "Unknown endpoint."})

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/judge":
            self._send(404, {"error": "Unknown endpoint."})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(400, {"error": "Request body missing or too large."})
            return

        try:
            body = json.loads(self.rfile.read(length).decode())
        except json.JSONDecodeError:
            self._send(400, {"error": "Request body is not valid JSON."})
            return

        try:
            self._send(200, call_judge(body))
        except PermissionError as e:
            self._send(503, {"error": str(e)})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            self._send(502, {"error": str(e)})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    backend = transcript_backend()
    print(f"chunkify helper on http://localhost:{PORT}", flush=True)
    print(f"  transcripts : {backend or 'unavailable (pip install youtube-transcript-api)'}", flush=True)
    print(f"  judge       : {JUDGE_MODEL if JUDGE_KEY else 'unavailable (set CHUNKIFY_JUDGE_KEY)'}", flush=True)
    print(f"  cors origin : {ALLOW_ORIGIN}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
