'use strict';

/* Reels: the same video, cut into short clips that stand on their own.

   Nothing is downloaded and nothing is re-encoded, exactly as with sections. A
   reel is a {startSeconds, endSeconds} pair plus a title, played by seeking a
   YouTube player to that range inside a 9:16 frame. That keeps the app's one
   hard constraint — no backend, no media handling — and it means a reel costs
   nothing but a row in localStorage.

   Reels hang off the video rather than the chunk: a good clip is wherever it
   is, and does not respect a section boundary. They have no dueAt and never
   enter the review queue. This is the watch-it path, not the study path, so it
   also does not count toward the daily focus goal. */

const REEL_MIN_SECONDS = 20;
const REEL_MAX_SECONDS = 75;

/* ---------- building reels from what the model returned ---------- */

// Snap a time to the transcript line containing it, so a clip starts on a
// sentence rather than mid-word. Falls back to the raw time.
function snapToSegment(segments, seconds, edge) {
  const hit = segments.find((s) => seconds >= s.start && seconds < s.end);
  if (!hit) return seconds;
  if (edge === 'start') return hit.start;
  // An end landing exactly on a line's start means "up to here", so leave it.
  // Extending it would swallow the next line and, with it, the clip that
  // begins there.
  return seconds === hit.start ? seconds : hit.end;
}

/* Turn raw model output into clips that are safe to play: real numbers, inside
   the video, snapped to transcript lines, length-bounded, non-overlapping and
   in order. Pure, so the rules are testable without a model. */
function buildReels(rawClips, segments, durationSeconds, opts = {}) {
  const min = opts.minSeconds || REEL_MIN_SECONDS;
  const max = opts.maxSeconds || REEL_MAX_SECONDS;
  const limit = durationSeconds > 0 ? durationSeconds : Infinity;
  if (!Array.isArray(rawClips)) return [];

  const candidates = [];
  for (const raw of rawClips) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title == null ? '' : raw.title).trim();
    if (!title) continue;

    let start = Number(raw.startSeconds);
    let end = Number(raw.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    start = Math.max(0, Math.min(start, limit));
    end = Math.max(0, Math.min(end, limit));
    if (end <= start) continue;

    start = Math.max(0, snapToSegment(segments, start, 'start'));
    end = Math.min(limit, snapToSegment(segments, end, 'end'));
    if (end <= start) continue;

    // too long is a worse failure than too short: a reel that runs on is not a reel
    if (end - start > max) end = start + max;
    if (end - start < min) end = Math.min(limit, start + min);
    if (end - start < min / 2) continue; // ran out of video

    candidates.push({ title, hook: String(raw.hook == null ? '' : raw.hook).trim(), startSeconds: start, endSeconds: end });
  }

  candidates.sort((a, b) => a.startSeconds - b.startSeconds);

  const kept = [];
  for (const c of candidates) {
    const last = kept[kept.length - 1];
    if (last && c.startSeconds < last.endSeconds) continue; // overlaps the previous clip
    kept.push(Object.assign({ id: uid(), createdAt: Date.now() }, c));
  }
  return kept;
}

/* ---------- generating them ---------- */

function reelCountFor(durationSeconds) {
  // roughly one clip per two minutes, kept within what one sitting tolerates
  return Math.max(3, Math.min(12, Math.round((durationSeconds || 600) / 120)));
}

// transcript as "[seconds] text" lines, which is what the prompt asks the model
// to pick its boundaries from
function timedTranscript(segments, budget = 9000) {
  const lines = segments.map((s) => `[${Math.round(s.start)}] ${s.text}`);
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > budget) break;
    out += (out ? '\n' : '') + line;
  }
  return out;
}

/* Split the transcript into passes of roughly this long. One prompt over a
   whole talk does not work: the transcript is far larger than a small model's
   context, so the tail is cut off and every clip comes from the opening
   minutes. Asking pass by pass keeps each prompt small and, more importantly,
   guarantees the clips are spread across the whole video. */
const REEL_PASS_SECONDS = 300;

function reelPasses(segments, durationSeconds) {
  const total = durationSeconds || (segments.length ? segments[segments.length - 1].end : 0);
  const passCount = Math.max(1, Math.round(total / REEL_PASS_SECONDS));
  const span = total / passCount;
  const passes = [];
  for (let i = 0; i < passCount; i++) {
    const from = i * span;
    const to = i === passCount - 1 ? Infinity : (i + 1) * span;
    const slice = segments.filter((s) => s.start >= from && s.start < to);
    if (slice.length) passes.push(slice);
  }
  return passes;
}

function generateReels(video, onStatus) {
  const say = (m) => { if (onStatus) onStatus(m); };
  say('Fetching transcript…');

  return transcriptFor(video.id).then((segments) => {
    if (!segments.length) throw new Error('No transcript available for this video.');

    const want = reelCountFor(video.durationSeconds);
    const passes = reelPasses(segments, video.durationSeconds);
    const perPass = Math.max(1, Math.ceil(want / passes.length));

    return prompts().then((p) => {
      // sequential: one small model, one GPU, and a queue is not faster
      return passes.reduce((chain, slice, i) => chain.then((acc) => {
        say(`Finding clips, pass ${i + 1} of ${passes.length}…`);
        const { messages, options } = promptCall(p.reels, {
          title: video.title,
          timed: timedTranscript(slice, 6000),
          count: perPass,
          minSeconds: REEL_MIN_SECONDS,
          maxSeconds: REEL_MAX_SECONDS,
        }, 'generate');

        return chatJson(messages, options)
          .then((reply) => acc.concat(Array.isArray(reply) ? reply : (reply.clips || [])))
          .catch(() => acc); // one bad pass should not lose the rest
      }), Promise.resolve([]))
        .then((raw) => {
          const reels = buildReels(raw, segments, video.durationSeconds);
          if (!reels.length) throw new Error('The model did not return any usable clips.');
          video.reels = reels;
          saveLibrary();
          say(`${reels.length} clips ready.`);
          return reels;
        });
    });
  });
}

/* ---------- the deck ---------- */

const reelDeck = document.getElementById('reel-deck');
const reelStage = document.getElementById('reel-stage');
const reelTitleEl = document.getElementById('reel-title');
const reelHookEl = document.getElementById('reel-hook');
const reelPosEl = document.getElementById('reel-pos');
const reelDotsEl = document.getElementById('reel-dots');
const reelBarEl = document.getElementById('reel-bar');

let reelPlayer = null;
let reelTimer = null;
let reelList = [];
let reelIndex = 0;
let reelVideo = null;

function reelDeckOpen() {
  return !reelDeck.classList.contains('hidden');
}

function ensureReelPlayer() {
  return loadYouTubeApi().then(() => {
    if (reelPlayer) return reelPlayer;
    return new Promise((resolve) => {
      reelPlayer = new YT.Player('reel-player', {
        height: '100%',
        width: '100%',
        // no chrome: a reel is watched, not scrubbed, and we draw our own bar
        playerVars: { rel: 0, playsinline: 1, controls: 0, modestbranding: 1, disablekb: 1 },
        events: { onReady: () => resolve(reelPlayer) },
      });
    });
  });
}

function renderReelMeta() {
  const reel = reelList[reelIndex];
  if (!reel) return;
  reelTitleEl.textContent = reel.title;
  reelHookEl.textContent = reel.hook || '';
  reelPosEl.textContent = `${reelIndex + 1} / ${reelList.length}`;

  reelDotsEl.innerHTML = '';
  reelList.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.className = 'reel-dot' + (i === reelIndex ? ' on' : '');
    dot.title = reelList[i].title;
    dot.addEventListener('click', () => showReel(i));
    reelDotsEl.appendChild(dot);
  });
}

function showReel(index) {
  if (index < 0 || index >= reelList.length) return;
  reelIndex = index;
  const reel = reelList[index];
  renderReelMeta();
  reelBarEl.style.width = '0%';
  if (reelPlayer && reelPlayer.seekTo) {
    reelPlayer.seekTo(reel.startSeconds, true);
    reelPlayer.playVideo();
  }
  startReelPolling();
}

function nextReel() {
  if (reelIndex < reelList.length - 1) showReel(reelIndex + 1);
  else if (reelPlayer && reelPlayer.pauseVideo) reelPlayer.pauseVideo();
}

function prevReel() {
  if (reelIndex > 0) showReel(reelIndex - 1);
}

function startReelPolling() {
  clearInterval(reelTimer);
  reelTimer = setInterval(() => {
    if (!reelPlayer || !reelPlayer.getCurrentTime) return;
    const reel = reelList[reelIndex];
    if (!reel) return;
    const t = reelPlayer.getCurrentTime();
    const span = reel.endSeconds - reel.startSeconds;
    reelBarEl.style.width = `${Math.max(0, Math.min(100, ((t - reel.startSeconds) / span) * 100))}%`;
    if (t >= reel.endSeconds - 0.15) nextReel();
  }, 250);
}

function stopReelPolling() {
  clearInterval(reelTimer);
  reelTimer = null;
}

function openReelDeck(video) {
  if (!video.reels || !video.reels.length) return;
  reelVideo = video;
  reelList = video.reels;
  reelIndex = 0;
  reelDeck.classList.remove('hidden');
  document.body.classList.add('reel-open');
  reelStage.classList.toggle('fill', !!settings.reelFill);
  document.getElementById('reel-fitfill').textContent = settings.reelFill ? 'Fit' : 'Fill';

  // the study player stops; only one of the two ever plays
  if (player && player.pauseVideo) player.pauseVideo();
  if (typeof stopPolling === 'function') stopPolling();

  renderReelMeta();
  ensureReelPlayer().then((p) => {
    p.loadVideoById({ videoId: video.id, startSeconds: reelList[0].startSeconds });
    showReel(0);
  });
}

function closeReelDeck() {
  stopReelPolling();
  if (reelPlayer && reelPlayer.pauseVideo) reelPlayer.pauseVideo();
  reelDeck.classList.add('hidden');
  document.body.classList.remove('reel-open');
  reelVideo = null;
}

document.getElementById('reel-close').addEventListener('click', closeReelDeck);
document.getElementById('reel-next').addEventListener('click', nextReel);
document.getElementById('reel-prev').addEventListener('click', prevReel);

// crop to fill the vertical frame, or letterbox the whole 16:9 inside it
document.getElementById('reel-fitfill').addEventListener('click', (e) => {
  const filling = reelStage.classList.toggle('fill');
  e.currentTarget.textContent = filling ? 'Fit' : 'Fill';
  settings.reelFill = filling;
  saveSettings();
});

// jump from a reel to that moment in the full video
document.getElementById('reel-open-full').addEventListener('click', () => {
  const reel = reelList[reelIndex];
  const video = reelVideo;
  closeReelDeck();
  if (!video || !reel) return;
  const idx = video.chunks.findIndex((c) => reel.startSeconds >= c.startSeconds && reel.startSeconds < c.endSeconds);
  if (idx !== -1) setActiveChunk(idx, { seekTo: reel.startSeconds, play: true });
});

document.addEventListener('keydown', (e) => {
  if (!reelDeckOpen()) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); nextReel(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); prevReel(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeReelDeck(); }
  else if (e.key === ' ') {
    e.preventDefault();
    if (!reelPlayer || !reelPlayer.getPlayerState) return;
    if (reelPlayer.getPlayerState() === YT.PlayerState.PLAYING) reelPlayer.pauseVideo();
    else reelPlayer.playVideo();
  }
});

// wheel and touch, so it feels like the thing it is imitating
let wheelLock = 0;
reelDeck.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) < 20 || Date.now() < wheelLock) return;
  wheelLock = Date.now() + 500;
  if (e.deltaY > 0) nextReel(); else prevReel();
}, { passive: true });

let touchStartY = null;
reelDeck.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
reelDeck.addEventListener('touchend', (e) => {
  if (touchStartY === null) return;
  const dy = e.changedTouches[0].clientY - touchStartY;
  touchStartY = null;
  if (Math.abs(dy) < 60) return;
  if (dy < 0) nextReel(); else prevReel();
}, { passive: true });

/* ---------- entry point in the video view ---------- */

const reelBtn = document.getElementById('reels-btn');
const reelStatusEl = document.getElementById('reels-status');

function renderReelsButton() {
  if (!currentVideo) return;
  const n = (currentVideo.reels || []).length;
  reelBtn.textContent = n ? `Reels (${n})` : 'Make reels';
  reelBtn.classList.remove('hidden');
  reelStatusEl.textContent = '';
  reelStatusEl.classList.remove('cards-error');
}

reelBtn.addEventListener('click', () => {
  if (!currentVideo) return;
  if ((currentVideo.reels || []).length) {
    openReelDeck(currentVideo);
    return;
  }
  reelBtn.disabled = true;
  generateReels(currentVideo, (m) => { reelStatusEl.textContent = m; })
    .then(() => {
      reelBtn.disabled = false;
      renderReelsButton();
      openReelDeck(currentVideo);
    })
    .catch((err) => {
      reelBtn.disabled = false;
      reelStatusEl.textContent = err.message;
      reelStatusEl.classList.add('cards-error');
    });
});

document.getElementById('reels-redo').addEventListener('click', () => {
  if (!currentVideo || !confirm('Throw away these clips and find them again?')) return;
  currentVideo.reels = [];
  saveLibrary();
  renderReelsButton();
});
