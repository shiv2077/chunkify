'use strict';

/* ---------- storage ---------- */

const STORAGE_KEY = 'chunkify:library';
const SETTINGS_KEY = 'chunkify:settings';
const STATS_KEY = 'chunkify:stats';

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

let library = readJson(STORAGE_KEY, []);
let settings = Object.assign(
  {
    apiKey: localStorage.getItem('chunkify:apiKey') || '', // migrate the old standalone key
    goalMinutes: 60,
    breaksEnabled: true,
    breakEvery: 2,
    breakSeconds: 60,
    autoComplete: true,
    recallEnabled: true,
    speed: 1,
    // model plumbing; all optional, all degrade to the app working as before
    helperBaseUrl: 'http://localhost:8935',
    genBaseUrl: 'http://localhost:11434/v1',
    genModel: 'qwen2.5:3b',
    cardsPerChunk: 4,
    reelFill: false,
  },
  readJson(SETTINGS_KEY, {})
);
// one-time migration: the generator default moved from a bare llama.cpp port
// to Ollama's, which is what the local setup actually installs
if (settings.genBaseUrl === 'http://localhost:8080/v1') settings.genBaseUrl = 'http://localhost:11434/v1';
if (settings.genModel === 'local-model') settings.genModel = 'qwen2.5:3b';

let stats = readJson(STATS_KEY, { days: {} });

function saveLibrary() { localStorage.setItem(STORAGE_KEY, JSON.stringify(library)); }
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function saveStats() { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }

/* ---------- focus stats (time studied per day + streak) ---------- */

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let statsDirty = false;

function addStudySeconds(seconds) {
  const k = dayKey(new Date());
  stats.days[k] = (stats.days[k] || 0) + seconds;
  statsDirty = true;
}

// flush at most every 5s so we aren't hitting localStorage on every 300ms poll
setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  saveStats();
  renderTodayStat();
}, 5000);

// consecutive days with at least a minute of study; today counts only once started
function currentStreak() {
  const d = new Date();
  let streak = 0;
  if ((stats.days[dayKey(d)] || 0) < 60) d.setDate(d.getDate() - 1);
  while ((stats.days[dayKey(d)] || 0) >= 60) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

const goalRingEl = document.getElementById('goal-ring');
const todayMinutesEl = document.getElementById('today-minutes');
const todayGoalEl = document.getElementById('today-goal');
const streakCountEl = document.getElementById('streak-count');

function renderTodayStat() {
  const seconds = stats.days[dayKey(new Date())] || 0;
  const minutes = Math.floor(seconds / 60);
  const pct = Math.min(100, Math.round((minutes / Math.max(1, settings.goalMinutes)) * 100));
  todayMinutesEl.textContent = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  todayGoalEl.textContent = `of ${settings.goalMinutes}m today`;
  goalRingEl.setAttribute('stroke-dasharray', `${pct} ${100 - pct}`);
  goalRingEl.style.stroke = pct >= 100 ? 'var(--success)' : 'var(--accent)';
  streakCountEl.textContent = currentStreak();
}

/* ---------- spaced review ---------- */

// Rating a section schedules the next time it resurfaces. Lost it -> same
// session; shaky -> tomorrow; got it -> an expanding gap (1, 3, 7, 16, 35 days).
const GOOD_GAPS_DAYS = [1, 3, 7, 16, 35];
const DAY_MS = 86400000;

function scheduleReview(chunk, rating) {
  chunk.lastRating = rating;
  if (rating === 1) {
    chunk.reps = 0;
    chunk.dueAt = Date.now() + 10 * 60 * 1000;
  } else if (rating === 2) {
    chunk.reps = Math.max(0, (chunk.reps || 0) - 1);
    chunk.dueAt = Date.now() + DAY_MS;
  } else {
    const reps = chunk.reps || 0;
    chunk.dueAt = Date.now() + GOOD_GAPS_DAYS[Math.min(reps, GOOD_GAPS_DAYS.length - 1)] * DAY_MS;
    chunk.reps = reps + 1;
  }
}

// every rated section across the whole library that is due now, soonest first
function dueReviews(now = Date.now()) {
  const due = [];
  for (const video of library) {
    for (const chunk of video.chunks) {
      if (chunk.dueAt && chunk.dueAt <= now) due.push({ video, chunk });
    }
  }
  return due.sort((x, y) => x.chunk.dueAt - y.chunk.dueAt);
}

/* ---------- small helpers ---------- */

function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function formatTime(totalSeconds) {
  totalSeconds = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMinutes(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// one regex covering watch?v=, youtu.be/, embed/, shorts/
const YT_ID_RE = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

function extractVideoId(url) {
  const match = (url || '').trim().match(YT_ID_RE);
  return match ? match[1] : null;
}

// fetch the video's description via the YouTube Data API; null on any failure
function fetchVideoDescription(videoId) {
  if (!settings.apiKey) return Promise.resolve(null);
  return fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${settings.apiKey}`)
    .then((res) => (res.ok ? res.json() : Promise.reject()))
    .then((data) => (data.items && data.items[0] ? data.items[0].snippet.description : null))
    .catch(() => null);
}

/* ---------- YouTube IFrame API loading ---------- */

let ytApiPromise = null;

function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }
    window.onYouTubeIframeAPIReady = () => resolve();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

/* ---------- single player instance ---------- */

let player = null;
let playerReadyResolvers = [];
let cuedResolvers = [];
let pollTimer = null;
let currentVideo = null;      // library entry currently open
let currentChunkIndex = -1;
let lastSavedAt = 0;
let chunksSinceBreak = 0;
let breakTimer = null;

function ensurePlayer() {
  return loadYouTubeApi().then(() => {
    if (player) return player;
    return new Promise((resolve) => {
      playerReadyResolvers.push(resolve);
      player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        playerVars: { rel: 0, playsinline: 1 },
        events: {
          onReady: () => {
            playerReadyResolvers.forEach((r) => r(player));
            playerReadyResolvers = [];
          },
          onStateChange: onPlayerStateChange,
        },
      });
    });
  });
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.CUED) {
    cuedResolvers.forEach((r) => r());
    cuedResolvers = [];
  }
  if (e.data === YT.PlayerState.PLAYING) {
    player.setPlaybackRate(Number(settings.speed) || 1);
    startPolling();
  }
  if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) {
    stopPolling();
    persistLastWatched(true);
  }
}

// cue a video (no autoplay) and resolve once duration is readable
function cueAndGetDuration(videoId) {
  return ensurePlayer().then((p) => {
    return new Promise((resolve) => {
      cuedResolvers.push(() => {
        pollForDuration(p, resolve);
      });
      p.cueVideoById(videoId);
    });
  });
}

function pollForDuration(p, resolve, attemptsLeft = 15) {
  const d = p.getDuration ? p.getDuration() : 0;
  if (d && d > 0) {
    resolve(d);
    return;
  }
  if (attemptsLeft <= 0) {
    resolve(0);
    return;
  }
  setTimeout(() => pollForDuration(p, resolve, attemptsLeft - 1), 200);
}

/* ---------- chunk generation ---------- */

// "0:00 Intro" / "1:08:25 Troubleshooting" -> {seconds,label}
function parseTimestampLine(line) {
  const m = line.trim().match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?\s+(.+)$/);
  if (!m) return null;
  let h, min, sec;
  if (m[3] !== undefined) {
    h = parseInt(m[1], 10); min = parseInt(m[2], 10); sec = parseInt(m[3], 10);
  } else {
    h = 0; min = parseInt(m[1], 10); sec = parseInt(m[2], 10);
  }
  if (min > 59 || sec > 59) return null;
  const label = m[4].trim().replace(/^[-–—:]\s*/, '').trim();
  if (!label) return null;
  return { seconds: h * 3600 + min * 60 + sec, label };
}

function buildChunksFromTimestamps(text, durationSeconds) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const p = parseTimestampLine(line);
    if (p) parsed.push(p);
  }
  if (parsed.length === 0) {
    return { error: 'No valid timestamps found. Use lines like "0:00 Intro" or "1:08:25 Troubleshooting".' };
  }

  // sort ascending, drop exact duplicate times (keep first label seen)
  parsed.sort((a, b) => a.seconds - b.seconds);
  const deduped = [];
  for (const p of parsed) {
    if (deduped.length === 0 || deduped[deduped.length - 1].seconds !== p.seconds) {
      deduped.push(p);
    }
  }

  const chunks = [];
  for (let i = 0; i < deduped.length; i++) {
    const start = deduped[i].seconds;
    const end = i < deduped.length - 1 ? deduped[i + 1].seconds : durationSeconds;
    if (end - start <= 0) continue; // guard against zero/negative duration chunks
    chunks.push({ id: uid(), label: deduped[i].label, startSeconds: start, endSeconds: end, completed: false, note: '' });
  }

  if (chunks.length === 0) {
    return { error: 'Timestamps did not produce any valid sections (check they are before the video ends).' };
  }
  return { chunks };
}

function buildAutoSplitChunks(durationSeconds, chunkLenMinutes) {
  const secs = Math.floor(chunkLenMinutes * 60);
  if (!durationSeconds || durationSeconds <= 0 || secs <= 0) return { error: 'Unknown duration or invalid length.' };
  const chunks = [];
  let start = 0;
  let index = 1;
  while (start < durationSeconds) {
    const end = Math.min(start + secs, durationSeconds);
    if (end - start <= 0) break;
    chunks.push({ id: uid(), label: String(index).padStart(2, '0'), startSeconds: start, endSeconds: end, completed: false, note: '' });
    start = end;
    index++;
  }
  if (chunks.length === 0) return { error: 'Could not generate chunks.' };
  return { chunks };
}

/* ---------- view switching ---------- */

const libraryView = document.getElementById('library-view');
const videoView = document.getElementById('video-view');

function showLibrary() {
  stopPolling();
  persistLastWatched(true);
  endBreak();
  if (player && player.pauseVideo) player.pauseVideo();
  currentVideo = null;
  currentChunkIndex = -1;
  videoView.classList.add('hidden');
  libraryView.classList.remove('hidden');
  renderLibrary();
}

function showVideoView() {
  libraryView.classList.add('hidden');
  videoView.classList.remove('hidden');
}

/* ---------- library rendering ---------- */

const libraryListEl = document.getElementById('library-list');
const libraryEmptyEl = document.getElementById('library-empty');
const librarySummaryEl = document.getElementById('library-summary');

function renderLibrary() {
  libraryListEl.innerHTML = '';
  libraryEmptyEl.classList.toggle('hidden', library.length > 0);

  let doneChunks = 0;
  let totalChunks = 0;
  let remainingSeconds = 0;

  for (const video of library) {
    const card = document.createElement('div');
    const completed = video.chunks.filter((c) => c.completed).length;
    const total = video.chunks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    doneChunks += completed;
    totalChunks += total;
    remainingSeconds += video.chunks.reduce((sum, c) => sum + (c.completed ? 0 : c.endSeconds - c.startSeconds), 0);

    card.className = 'library-card' + (total > 0 && completed === total ? ' done' : '');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${video.title}`);

    const thumb = video.thumbnailUrl
      ? `<img class="thumb" src="${video.thumbnailUrl}" alt="" loading="lazy">`
      : `<div class="thumb-placeholder">No thumbnail</div>`;
    const durationLabel = video.durationSeconds ? formatTime(video.durationSeconds) : '';

    card.innerHTML = `
      <div class="thumb-wrap">
        ${thumb}
        ${durationLabel ? `<span class="duration-pill">${durationLabel}</span>` : ''}
        <button class="delete-btn icon-btn" title="Remove video" aria-label="Remove video"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="card-body">
        <p class="card-title"></p>
        <div class="card-meta">
          <span>${total > 0 ? `${completed}/${total} sections` : 'no sections yet'}</span>
          <span>${total > 0 ? (completed === total ? 'done' : `${pct}%`) : ''}</span>
        </div>
        ${total > 0 ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
      </div>
    `;
    card.querySelector('.card-title').textContent = video.title;
    card.querySelector('.delete-btn').setAttribute('aria-label', `Remove ${video.title}`);

    card.addEventListener('click', (e) => {
      if (e.target.closest('.delete-btn')) return;
      openVideo(video.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      openVideo(video.id);
    });
    card.querySelector('.delete-btn').addEventListener('click', () => {
      if (!confirm('Remove this video and its sections?')) return;
      library = library.filter((v) => v.id !== video.id);
      saveLibrary();
      renderLibrary();
    });

    libraryListEl.appendChild(card);
  }

  renderReviewPanel();

  librarySummaryEl.textContent = totalChunks
    ? `${doneChunks}/${totalChunks} sections done` + (remainingSeconds >= 1 ? ` · ${formatMinutes(remainingSeconds)} left` : ' · all caught up')
    : '';
}

const reviewPanelEl = document.getElementById('review-panel');
const reviewListEl = document.getElementById('review-list');
const reviewSummaryEl = document.getElementById('review-summary');
const RATING_LABEL = { 1: 'lost it', 2: 'shaky', 3: 'got it' };

function renderReviewPanel() {
  const due = dueReviews();
  const cards = dueCards();
  reviewPanelEl.classList.toggle('hidden', due.length === 0 && cards.length === 0);
  reviewListEl.innerHTML = '';
  if (due.length === 0 && cards.length === 0) return;

  const parts = [];
  if (due.length) parts.push(`${due.length} section${due.length === 1 ? '' : 's'} to re-watch`);
  if (cards.length) parts.push(`${cards.length} card${cards.length === 1 ? '' : 's'} due`);
  reviewSummaryEl.textContent = parts.join(' · ');

  for (const { video, chunk } of due.slice(0, 8)) {
    const row = document.createElement('button');
    row.className = 'review-item rating-' + (chunk.lastRating || 2);
    row.innerHTML = `
      <span class="review-dot"></span>
      <span class="review-text">
        <b class="review-chunk"></b>
        <small class="review-video"></small>
      </span>
      <span class="review-meta">${RATING_LABEL[chunk.lastRating] || ''} &middot; ${formatMinutes(chunk.endSeconds - chunk.startSeconds)}</span>
    `;
    row.querySelector('.review-chunk').textContent = chunk.label;
    row.querySelector('.review-video').textContent = video.title;
    row.addEventListener('click', () => openVideo(video.id, chunk.id));
    reviewListEl.appendChild(row);
  }

  // cards are grouped by the section that owns them; opening one starts there
  const bySection = new Map();
  for (const entry of cards) {
    if (!bySection.has(entry.chunk.id)) bySection.set(entry.chunk.id, { entry, count: 0 });
    bySection.get(entry.chunk.id).count++;
  }
  for (const { entry, count } of Array.from(bySection.values()).slice(0, 8)) {
    const row = document.createElement('button');
    row.className = 'review-item review-cards';
    row.innerHTML = `
      <span class="review-dot"></span>
      <span class="review-text">
        <b class="review-chunk"></b>
        <small class="review-video"></small>
      </span>
      <span class="review-meta">${count} card${count === 1 ? '' : 's'}</span>
    `;
    row.querySelector('.review-chunk').textContent = entry.chunk.label;
    row.querySelector('.review-video').textContent = entry.video.title;
    row.addEventListener('click', () => openVideo(entry.video.id, entry.chunk.id));
    reviewListEl.appendChild(row);
  }
}

/* ---------- add video form ---------- */

const addForm = document.getElementById('add-form');
const urlInput = document.getElementById('url-input');
const urlError = document.getElementById('url-error');

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  urlError.classList.add('hidden');
  const url = urlInput.value.trim();
  const id = extractVideoId(url);
  if (!id) {
    urlError.textContent = "That doesn't look like a YouTube URL. Try a watch, youtu.be, embed, or shorts link.";
    urlError.classList.remove('hidden');
    return;
  }
  if (library.some((v) => v.id === id)) {
    urlError.textContent = 'That video is already in your library.';
    urlError.classList.remove('hidden');
    return;
  }

  const video = {
    id,
    url,
    title: url,
    thumbnailUrl: null,
    durationSeconds: null,
    chunks: [],
    lastWatched: null,
  };
  library.unshift(video);
  saveLibrary();
  urlInput.value = '';
  renderLibrary();

  // fetch title/thumbnail in the background; never block adding the video on it
  fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
    .then((res) => (res.ok ? res.json() : Promise.reject()))
    .then((data) => {
      video.title = data.title || url;
      video.thumbnailUrl = data.thumbnail_url || null;
      saveLibrary();
      renderLibrary();
    })
    .catch(() => {
      // fallback already in place: title = url, no thumbnail
    });
});

document.getElementById('back-btn').addEventListener('click', showLibrary);
document.getElementById('brand-link').addEventListener('click', (e) => {
  e.preventDefault();
  if (currentVideo) showLibrary();
});

/* ---------- settings dialog ---------- */

const settingsDialog = document.getElementById('settings-dialog');
const setGoal = document.getElementById('set-goal');
const setBreaks = document.getElementById('set-breaks');
const setBreakEvery = document.getElementById('set-break-every');
const setBreakSeconds = document.getElementById('set-break-seconds');
const setAutoComplete = document.getElementById('set-autocomplete');
const setRecall = document.getElementById('set-recall');
const setApiKey = document.getElementById('set-api-key');
const setHelperUrl = document.getElementById('set-helper-url');
const setGenUrl = document.getElementById('set-gen-url');
const setGenModel = document.getElementById('set-gen-model');
const setCardsPerChunk = document.getElementById('set-cards-per-chunk');
const helperStatusEl = document.getElementById('helper-status');

// shown live in the settings dialog so a dead helper is obvious, not mysterious
function renderHelperStatus() {
  helperStatusEl.textContent = 'Checking helper…';
  helperStatusEl.className = 'hint';
  helperHealth({ refresh: true }).then((health) => {
    if (!health) {
      helperStatusEl.textContent = 'Helper not running. Card generation and answer grading stay hidden; everything else works. Start it with ./run.sh --helper';
      return;
    }
    const transcripts = health.transcript ? `transcripts via ${health.transcript}` : 'no transcript backend installed';
    const judge = health.judge ? `judge ready (${health.judgeModel})` : 'no judge key set';
    helperStatusEl.textContent = `Helper running — ${transcripts}; ${judge}.`;
  });
}

document.getElementById('settings-btn').addEventListener('click', () => {
  setGoal.value = settings.goalMinutes;
  setBreaks.checked = settings.breaksEnabled;
  setBreakEvery.value = settings.breakEvery;
  setBreakSeconds.value = settings.breakSeconds;
  setAutoComplete.checked = settings.autoComplete;
  setRecall.checked = settings.recallEnabled;
  setApiKey.value = settings.apiKey;
  setHelperUrl.value = settings.helperBaseUrl;
  setGenUrl.value = settings.genBaseUrl;
  setGenModel.value = settings.genModel;
  setCardsPerChunk.value = settings.cardsPerChunk;
  renderHelperStatus();
  settingsDialog.showModal();
});

document.getElementById('settings-cancel').addEventListener('click', () => settingsDialog.close('cancel'));

settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  settings.goalMinutes = Math.max(5, parseInt(setGoal.value, 10) || 60);
  settings.breaksEnabled = setBreaks.checked;
  settings.breakEvery = Math.max(1, parseInt(setBreakEvery.value, 10) || 2);
  settings.breakSeconds = Math.max(10, parseInt(setBreakSeconds.value, 10) || 60);
  settings.autoComplete = setAutoComplete.checked;
  settings.recallEnabled = setRecall.checked;
  settings.apiKey = setApiKey.value.trim();
  settings.helperBaseUrl = setHelperUrl.value.trim();
  settings.genBaseUrl = setGenUrl.value.trim();
  settings.genModel = setGenModel.value.trim() || 'local-model';
  settings.cardsPerChunk = Math.min(10, Math.max(1, parseInt(setCardsPerChunk.value, 10) || 4));
  saveSettings();
  localStorage.removeItem('chunkify:apiKey');
  forgetHelperHealth();
  renderTodayStat();
});

/* ---------- video / player view ---------- */

const videoTitleEl = document.getElementById('video-title');
const playerControlsEl = document.getElementById('player-controls');
const chunkSetupEl = document.getElementById('chunk-setup');
const chunkListEl = document.getElementById('chunk-list');
const sideProgressEl = document.getElementById('side-progress');
const resumeBannerEl = document.getElementById('resume-banner');
const resumeTextEl = document.getElementById('resume-text');
const autodetectHintEl = document.getElementById('autodetect-hint');
const chunkSourceNoteEl = document.getElementById('chunk-source-note');
const redoSetupBtn = document.getElementById('redo-setup-btn');
const speedSelect = document.getElementById('speed-select');

speedSelect.value = String(settings.speed);
speedSelect.addEventListener('change', () => {
  settings.speed = Number(speedSelect.value);
  saveSettings();
  if (player && player.setPlaybackRate) player.setPlaybackRate(settings.speed);
});

redoSetupBtn.addEventListener('click', () => {
  if (!confirm('Clear current sections and set them up again?')) return;
  currentVideo.chunks = [];
  currentVideo.lastWatched = null;
  saveLibrary();
  currentChunkIndex = -1;
  resumeBannerEl.classList.add('hidden');
  renderChunkSetupVisibility();
  renderChunkList();
});

function openVideo(videoId, startChunkId = null) {
  currentVideo = library.find((v) => v.id === videoId);
  if (!currentVideo) return;
  currentChunkIndex = -1;
  chunksSinceBreak = 0;
  stopPolling();
  endBreak();

  videoTitleEl.textContent = currentVideo.title;
  showVideoView();
  autodetectHintEl.classList.add('hidden');
  chunkSourceNoteEl.classList.add('hidden');
  renderChunkSetupVisibility();
  renderChunkList();
  updateResumeBanner();
  renderReelsButton();

  cueAndGetDuration(currentVideo.id).then((duration) => {
    if (duration && duration > 0) {
      currentVideo.durationSeconds = duration;
      saveLibrary();
    }
    renderAutosplitHint();
    playerControlsEl.classList.toggle('hidden', currentVideo.chunks.length === 0);
    if (currentVideo.chunks.length === 0) tryAutoDetectChapters(currentVideo);
    if (startChunkId) {
      const idx = currentVideo.chunks.findIndex((c) => c.id === startChunkId);
      if (idx !== -1) {
        resumeBannerEl.classList.add('hidden');
        setActiveChunk(idx, { play: true });
      }
    }
  });
}

// pull the video description via the YouTube Data API and reuse the timestamp
// parser to build chunks from any chapter markers already in it (e.g. "0:00 Intro")
function tryAutoDetectChapters(video) {
  autodetectHintEl.textContent = settings.apiKey
    ? 'Checking the video description for chapters…'
    : 'Tip: add a YouTube API key in settings to auto-detect this video\'s chapters instead of pasting them.';
  autodetectHintEl.classList.remove('hidden');

  fetchVideoDescription(video.id).then((description) => {
    if (currentVideo !== video || video.chunks.length > 0) return; // video changed or user already set chunks up
    if (!description) {
      if (settings.apiKey) autodetectHintEl.textContent = 'No chapters found in the video description.';
      return;
    }
    const result = buildChunksFromTimestamps(description, video.durationSeconds);
    if (result.error || result.chunks.length < 2) {
      autodetectHintEl.textContent = 'No chapters found in the video description.';
      return;
    }
    video.chunks = result.chunks;
    saveLibrary();
    autodetectHintEl.classList.add('hidden');
    chunkSourceNoteEl.textContent = `Auto-detected ${result.chunks.length} chapters.`;
    chunkSourceNoteEl.classList.remove('hidden');
    finishChunkCreation();
  });
}

function renderChunkSetupVisibility() {
  const hasChunks = currentVideo.chunks.length > 0;
  chunkSetupEl.classList.toggle('hidden', hasChunks);
  playerControlsEl.classList.toggle('hidden', !hasChunks);
  redoSetupBtn.classList.toggle('hidden', !hasChunks);
  if (!hasChunks) chunkSourceNoteEl.classList.add('hidden');
}

function updateResumeBanner() {
  const lw = currentVideo.lastWatched;
  if (lw && currentVideo.chunks.some((c) => c.id === lw.chunkId)) {
    const chunk = currentVideo.chunks.find((c) => c.id === lw.chunkId);
    resumeTextEl.textContent = `Pick up in "${chunk.label}" at ${formatTime(lw.positionSeconds)}`;
    resumeBannerEl.classList.remove('hidden');
  } else {
    resumeBannerEl.classList.add('hidden');
  }
}

document.getElementById('resume-btn').addEventListener('click', () => {
  const lw = currentVideo.lastWatched;
  resumeBannerEl.classList.add('hidden');
  if (!lw) return;
  const idx = currentVideo.chunks.findIndex((c) => c.id === lw.chunkId);
  if (idx === -1) return;
  setActiveChunk(idx, { seekTo: lw.positionSeconds, play: true });
});
document.getElementById('dismiss-resume-btn').addEventListener('click', () => {
  resumeBannerEl.classList.add('hidden');
  const firstUndone = currentVideo.chunks.findIndex((c) => !c.completed);
  setActiveChunk(firstUndone === -1 ? 0 : firstUndone, { play: true });
});

/* ---------- chunk list rendering ---------- */

let noteSaveTimer = null;

function renderSideProgress() {
  const chunks = currentVideo ? currentVideo.chunks : [];
  if (chunks.length === 0) {
    sideProgressEl.innerHTML = '';
    return;
  }
  const done = chunks.filter((c) => c.completed).length;
  const left = chunks.reduce((sum, c) => sum + (c.completed ? 0 : c.endSeconds - c.startSeconds), 0);
  const pct = Math.round((done / chunks.length) * 100);
  sideProgressEl.innerHTML = `
    <div class="sp-top"><span><b>${done}</b> of ${chunks.length} sections</span><span>${left >= 1 ? `${formatMinutes(left)} left` : 'all done'}</span></div>
    <div class="sp-bar"><div class="sp-fill" style="width:${pct}%"></div></div>
  `;
}

function renderChunkList() {
  chunkListEl.innerHTML = '';
  currentVideo.chunks.forEach((chunk, index) => {
    const item = document.createElement('div');
    item.className = 'chunk-item' + (index === currentChunkIndex ? ' active' : '') + (chunk.completed ? ' completed' : '');

    item.innerHTML = `
      <div class="chunk-row">
        <input type="checkbox" ${chunk.completed ? 'checked' : ''} title="Mark completed">
        <span class="chunk-index">${index + 1}</span>
        <div class="chunk-info">
          <div class="chunk-label"></div>
          <div class="chunk-time">${formatTime(chunk.startSeconds)} &ndash; ${formatTime(chunk.endSeconds)} &middot; ${formatMinutes(chunk.endSeconds - chunk.startSeconds)}</div>
        </div>
        <div class="chunk-actions">
          <button class="icon-btn cards-btn ${verifiedCards(chunk).length ? 'has-cards' : ''}" title="Cards" aria-label="Cards"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v6H7zM7 14h10v6H7z"/></svg></button>
          <button class="icon-btn note-btn ${chunk.note ? 'has-note' : ''}" title="Notes" aria-label="Notes"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM8 9h8M8 13h8"/></svg></button>
          <button class="icon-btn rename-btn" title="Rename" aria-label="Rename"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5 4 4M5 19l3.5-.8L18.7 8 16 5.3 5.8 15.5 5 19Z"/></svg></button>
          <button class="icon-btn delete-chunk-btn" title="Delete" aria-label="Delete"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
        </div>
      </div>
      <div class="chunk-note hidden"><textarea rows="3" placeholder="Notes for this section…"></textarea></div>
      <div class="chunk-cards hidden"></div>
    `;
    item.querySelector('.chunk-label').textContent = chunk.label;

    const checkbox = item.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', (e) => {
      chunk.completed = e.target.checked;
      saveLibrary();
      item.classList.toggle('completed', chunk.completed);
      renderSideProgress();
    });

    const noteWrap = item.querySelector('.chunk-note');
    const noteArea = noteWrap.querySelector('textarea');
    noteArea.value = chunk.note || '';
    item.querySelector('.note-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      noteWrap.classList.toggle('hidden');
      if (!noteWrap.classList.contains('hidden')) noteArea.focus();
    });
    noteArea.addEventListener('click', (e) => e.stopPropagation());
    noteArea.addEventListener('input', () => {
      chunk.note = noteArea.value;
      item.querySelector('.note-btn').classList.toggle('has-note', !!chunk.note);
      renderNoteStamps(noteWrap, chunk);
      clearTimeout(noteSaveTimer);
      noteSaveTimer = setTimeout(saveLibrary, 400);
    });
    noteArea.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      noteArea.blur();
      if (player && player.playVideo) player.playVideo();
    });
    renderNoteStamps(noteWrap, chunk);

    const cardsWrap = item.querySelector('.chunk-cards');
    item.querySelector('.cards-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = cardsWrap.classList.contains('hidden');
      cardsWrap.classList.toggle('hidden');
      if (opening) renderChunkCards(cardsWrap, currentVideo, chunk); // build on demand, not on every list render
    });
    cardsWrap.addEventListener('click', (e) => e.stopPropagation());

    item.querySelector('.rename-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const next = prompt('Rename section', chunk.label);
      if (next && next.trim()) {
        chunk.label = next.trim();
        saveLibrary();
        renderChunkList();
      }
    });

    item.querySelector('.delete-chunk-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${chunk.label}"? Its time range will be merged into the neighboring section.`)) return;
      deleteChunk(index);
    });

    item.querySelector('.chunk-row').addEventListener('click', () => setActiveChunk(index, { seekTo: chunk.startSeconds, play: true }));

    chunkListEl.appendChild(item);
  });
  renderSideProgress();
}

// every "[mm:ss]" in a note becomes a chip that seeks back to that moment
const NOTE_STAMP_RE = /\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]/g;

function renderNoteStamps(noteWrap, chunk) {
  let strip = noteWrap.querySelector('.note-stamps');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'note-stamps';
    noteWrap.appendChild(strip);
  }
  strip.innerHTML = '';
  for (const m of (chunk.note || '').matchAll(NOTE_STAMP_RE)) {
    const seconds = m[3] !== undefined
      ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
      : Number(m[1]) * 60 + Number(m[2]);
    const chip = document.createElement('button');
    chip.className = 'stamp-chip';
    chip.textContent = m[0].slice(1, -1);
    chip.title = 'Jump back here';
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (player && player.seekTo) {
        player.seekTo(seconds, true);
        player.playVideo();
      }
    });
    strip.appendChild(chip);
  }
}

function deleteChunk(index) {
  const chunks = currentVideo.chunks;
  const removed = chunks[index];
  if (chunks.length === 1) {
    chunks.splice(index, 1);
  } else if (index < chunks.length - 1) {
    chunks[index + 1].startSeconds = removed.startSeconds; // extend next chunk backward
    chunks.splice(index, 1);
  } else {
    chunks[index - 1].endSeconds = removed.endSeconds; // extend previous chunk forward
    chunks.splice(index, 1);
  }
  saveLibrary();
  currentChunkIndex = -1;
  renderChunkList();
  renderChunkSetupVisibility();
}

/* ---------- chunk creation UI ---------- */

const timestampsInput = document.getElementById('timestamps-input');
const timestampsError = document.getElementById('timestamps-error');
const createFromTimestampsBtn = document.getElementById('create-from-timestamps-btn');
const autosplitSelect = document.getElementById('autosplit-select');
const autosplitCustom = document.getElementById('autosplit-custom');
const autosplitBtn = document.getElementById('autosplit-btn');
const autosplitHint = document.getElementById('autosplit-hint');

autosplitSelect.addEventListener('change', () => {
  autosplitCustom.classList.toggle('hidden', autosplitSelect.value !== 'custom');
});

function renderAutosplitHint() {
  if (currentVideo.durationSeconds) {
    autosplitHint.textContent = `Video length: ${formatTime(currentVideo.durationSeconds)}`;
    autosplitBtn.disabled = false;
  } else {
    autosplitHint.textContent = "Couldn't read video duration yet.";
    autosplitBtn.disabled = true;
  }
}

createFromTimestampsBtn.addEventListener('click', () => {
  timestampsError.classList.add('hidden');
  if (!currentVideo.durationSeconds) {
    timestampsError.textContent = 'Still loading video duration, try again in a moment.';
    timestampsError.classList.remove('hidden');
    return;
  }
  const result = buildChunksFromTimestamps(timestampsInput.value, currentVideo.durationSeconds);
  if (result.error) {
    timestampsError.textContent = result.error;
    timestampsError.classList.remove('hidden');
    return;
  }
  currentVideo.chunks = result.chunks;
  saveLibrary();
  finishChunkCreation();
});

autosplitBtn.addEventListener('click', () => {
  const minutes = autosplitSelect.value === 'custom' ? parseFloat(autosplitCustom.value) : parseFloat(autosplitSelect.value);
  if (!minutes || minutes <= 0) {
    autosplitHint.textContent = 'Enter a valid chunk length in minutes.';
    return;
  }
  const result = buildAutoSplitChunks(currentVideo.durationSeconds, minutes);
  if (result.error) {
    autosplitHint.textContent = result.error;
    return;
  }
  currentVideo.chunks = result.chunks;
  saveLibrary();
  finishChunkCreation();
});

function finishChunkCreation() {
  renderChunkSetupVisibility();
  renderChunkList();
}

/* ---------- breaks ---------- */

const breakOverlay = document.getElementById('break-overlay');
const breakCountEl = document.getElementById('break-count');
let breakResume = null;

function startBreak(secondsLeft, onDone) {
  breakResume = onDone;
  breakCountEl.textContent = secondsLeft;
  breakOverlay.classList.remove('hidden');
  clearInterval(breakTimer);
  breakTimer = setInterval(() => {
    secondsLeft--;
    breakCountEl.textContent = Math.max(0, secondsLeft);
    if (secondsLeft <= 0) skipBreak();
  }, 1000);
}

function endBreak() {
  recallOverlay.classList.add('hidden');
  recallResume = null;
  resetRecallAnswer();
  clearInterval(breakTimer);
  breakTimer = null;
  breakResume = null;
  breakOverlay.classList.add('hidden');
}

function skipBreak() {
  const resume = breakResume;
  endBreak();
  if (resume) resume();
}

document.getElementById('break-skip').addEventListener('click', skipBreak);
document.getElementById('break-end').addEventListener('click', () => {
  endBreak();
  showLibrary();
});

/* ---------- recall check ---------- */

const recallOverlay = document.getElementById('recall-overlay');
const recallQEl = document.getElementById('recall-q');
const recallAnswerBlock = document.getElementById('recall-answer-block');
const recallAnswerEl = document.getElementById('recall-answer');
const recallGradeBtn = document.getElementById('recall-grade');
const recallGradeStatus = document.getElementById('recall-grade-status');
const recallSuggestionEl = document.getElementById('recall-suggestion');
const recallSuggestionText = document.getElementById('recall-suggestion-text');
const recallAcceptBtn = document.getElementById('recall-accept');

let recallResume = null;     // what to do once the section has been rated
let recallCard = null;       // the card being asked, when the section has one
let recallSuggested = null;  // the judge's suggested rating, before the user acts

function resetRecallAnswer() {
  recallCard = null;
  recallSuggested = null;
  recallAnswerEl.value = '';
  recallGradeStatus.textContent = '';
  recallGradeStatus.classList.remove('cards-error');
  recallSuggestionEl.classList.add('hidden');
  recallAnswerBlock.classList.add('hidden');
}

function startRecall(chunk, onDone) {
  recallResume = onDone;
  resetRecallAnswer();

  // a verified card turns the open prompt into a specific question that can be graded
  recallCard = nextCardForChunk(chunk);
  if (recallCard) {
    recallQEl.textContent = recallCard.prompt;
    helperHealth().then((health) => {
      if (health && health.judge && recallResume) recallAnswerBlock.classList.remove('hidden');
    });
  } else {
    recallQEl.textContent = `What do you remember from "${chunk.label}"?`;
  }
  recallOverlay.classList.remove('hidden');
}

function gradeTypedAnswer() {
  const typed = recallAnswerEl.value.trim();
  if (!typed || !recallCard) return;
  recallGradeBtn.disabled = true;
  recallGradeStatus.classList.remove('cards-error');
  recallGradeStatus.textContent = 'Grading…';

  gradeFreeRecall(recallCard, typed)
    .then(({ rating, reason }) => {
      recallGradeBtn.disabled = false;
      recallGradeStatus.textContent = '';
      recallSuggested = rating;
      recallSuggestionText.textContent = `${RATING_WORD[rating]} — ${reason}`;
      recallSuggestionEl.className = 'recall-suggestion rating-' + rating;
      recallAcceptBtn.textContent = `Accept "${RATING_WORD[rating]}"`;
    })
    .catch((err) => {
      recallGradeBtn.disabled = false;
      recallGradeStatus.textContent = err.message;
      recallGradeStatus.classList.add('cards-error');
    });
}

recallGradeBtn.addEventListener('click', gradeTypedAnswer);
recallAcceptBtn.addEventListener('click', () => { if (recallSuggested) finishRecall(recallSuggested); });
recallAnswerEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); gradeTypedAnswer(); }
});

function finishRecall(rating) {
  if (!recallResume) return;
  const resume = recallResume;
  const card = recallCard;
  const suggested = recallSuggested;
  const typed = recallAnswerEl.value;
  recallResume = null;
  recallOverlay.classList.add('hidden');

  if (rating) {
    const chunk = currentVideo && currentVideo.chunks[currentChunkIndex];
    if (chunk) {
      scheduleReview(chunk, rating);
      // the card carries the calibration record: what was predicted, what happened
      if (card) recordCardOutcome(card, rating, { suggested, typedAnswer: typed });
      saveLibrary();
      renderChunkList();
    }
  }
  resetRecallAnswer();
  resume();
}

[3, 2, 1].forEach((rating) => {
  document.getElementById('recall-' + rating).addEventListener('click', () => finishRecall(rating));
});
document.getElementById('recall-skip').addEventListener('click', () => finishRecall(null));

/* ---------- playback: chunk navigation + polling ---------- */

function setActiveChunk(index, { seekTo = null, play = true } = {}) {
  if (!currentVideo || !player || !player.seekTo) return;
  if (index < 0 || index >= currentVideo.chunks.length) return;
  stopPolling();
  endBreak();
  currentChunkIndex = index;
  const chunk = currentVideo.chunks[index];
  const target = seekTo !== null ? seekTo : chunk.startSeconds;
  player.seekTo(target, true);
  if (play) player.playVideo();
  highlightActiveChunk();
  startPolling();
  persistLastWatched(true);
}

function highlightActiveChunk() {
  Array.from(chunkListEl.children).forEach((el, i) => {
    el.classList.toggle('active', i === currentChunkIndex);
    if (i === currentChunkIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

// finished the current chunk: mark done if enabled, then break or advance
function advanceFromCurrentChunk() {
  const chunk = currentVideo.chunks[currentChunkIndex];
  if (settings.autoComplete && chunk && !chunk.completed) {
    chunk.completed = true;
    saveLibrary();
    renderChunkList();
  }

  // ask for a recall rating first; the rest of the advance runs once it's answered
  if (settings.recallEnabled && chunk && !recallResume) {
    player.pauseVideo();
    stopPolling();
    startRecall(chunk, continueAfterChunk);
    return;
  }
  continueAfterChunk();
}

function continueAfterChunk() {
  const nextIndex = currentChunkIndex + 1;
  if (nextIndex >= currentVideo.chunks.length) {
    player.pauseVideo();
    stopPolling();
    return;
  }

  chunksSinceBreak++;
  if (settings.breaksEnabled && chunksSinceBreak >= settings.breakEvery) {
    chunksSinceBreak = 0;
    player.pauseVideo();
    stopPolling();
    startBreak(settings.breakSeconds, () => setActiveChunk(nextIndex, { play: true }));
    return;
  }
  setActiveChunk(nextIndex, { play: true });
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!player || !player.getCurrentTime || currentChunkIndex === -1 || !currentVideo) return;
    const chunk = currentVideo.chunks[currentChunkIndex];
    if (!chunk) return;
    if (player.getPlayerState() === YT.PlayerState.PLAYING) addStudySeconds(0.3);
    const t = player.getCurrentTime();
    if (t >= chunk.endSeconds - 0.15) {
      advanceFromCurrentChunk();
      return;
    }
    persistLastWatched(false);
  }, 300);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function persistLastWatched(force) {
  if (!currentVideo || currentChunkIndex === -1 || !player || !player.getCurrentTime) return;
  const now = Date.now();
  if (!force && now - lastSavedAt < 2000) return;
  lastSavedAt = now;
  const chunk = currentVideo.chunks[currentChunkIndex];
  if (!chunk) return;
  currentVideo.lastWatched = { chunkId: chunk.id, positionSeconds: player.getCurrentTime() };
  saveLibrary();
}

function goPrev() {
  if (currentChunkIndex > 0) setActiveChunk(currentChunkIndex - 1, { play: true });
}
function goNext() {
  if (currentVideo && currentChunkIndex < currentVideo.chunks.length - 1) setActiveChunk(currentChunkIndex + 1, { play: true });
}
function toggleCurrentComplete() {
  if (!currentVideo || currentChunkIndex === -1) return;
  const chunk = currentVideo.chunks[currentChunkIndex];
  chunk.completed = !chunk.completed;
  saveLibrary();
  renderChunkList();
}

document.getElementById('prev-btn').addEventListener('click', goPrev);
document.getElementById('next-btn').addEventListener('click', goNext);
document.getElementById('complete-btn').addEventListener('click', toggleCurrentComplete);

/* mark chapter: split the chunk currently playing at the current time */
document.getElementById('mark-chapter-btn').addEventListener('click', () => {
  if (!currentVideo || !player || !player.getCurrentTime) return;
  if (currentVideo.chunks.length === 0) return;
  const t = player.getCurrentTime();
  const idx = currentVideo.chunks.findIndex((c) => t > c.startSeconds && t < c.endSeconds);
  if (idx === -1) return;
  const chunk = currentVideo.chunks[idx];
  if (t - chunk.startSeconds < 1 || chunk.endSeconds - t < 1) {
    alert('Too close to an existing boundary to split here.');
    return;
  }
  const label = prompt('Label for new section', '');
  if (label === null) return;
  const newChunk = { id: uid(), label: label.trim() || 'New section', startSeconds: t, endSeconds: chunk.endSeconds, completed: false, note: '' };
  chunk.endSeconds = t;
  currentVideo.chunks.splice(idx + 1, 0, newChunk);
  saveLibrary();
  renderChunkList();
});

/* pause and drop a timestamped line into the current section's notes */
function jotTimestampedNote() {
  if (!currentVideo || currentChunkIndex === -1 || !player || !player.getCurrentTime) return;
  const item = chunkListEl.children[currentChunkIndex];
  if (!item) return;
  if (player.pauseVideo) player.pauseVideo();

  const chunk = currentVideo.chunks[currentChunkIndex];
  const stamp = `[${formatTime(player.getCurrentTime())}] `;
  const noteWrap = item.querySelector('.chunk-note');
  const noteArea = noteWrap.querySelector('textarea');
  noteWrap.classList.remove('hidden');
  noteArea.value = (chunk.note ? chunk.note.replace(/\s*$/, '') + '\n' : '') + stamp;
  chunk.note = noteArea.value;
  saveLibrary();
  noteArea.focus();
  noteArea.setSelectionRange(noteArea.value.length, noteArea.value.length);
}

/* ---------- keyboard shortcuts ---------- */

document.addEventListener('keydown', (e) => {
  if (!currentVideo || e.metaKey || e.ctrlKey || e.altKey) return;
  if (reelDeckOpen()) return;   // the reel deck has its own handler
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || settingsDialog.open) return;

  // a recall check owns the keyboard while it's up
  if (recallResume) {
    if ('123'.includes(e.key)) finishRecall(4 - Number(e.key));
    else if (e.key === 'Escape') finishRecall(null);
    e.preventDefault();
    return;
  }

  if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
  else if (e.key.toLowerCase() === 'c') { toggleCurrentComplete(); }
  else if (e.key.toLowerCase() === 'n') { e.preventDefault(); jotTimestampedNote(); }
  else if (e.key === 'Escape' && breakTimer) { skipBreak(); }
  else if (e.key === ' ') {
    if (!player || !player.getPlayerState) return;
    e.preventDefault();
    if (breakTimer) { skipBreak(); return; }
    if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
    else if (currentChunkIndex === -1) setActiveChunk(0, { play: true });
    else player.playVideo();
  }
});

window.addEventListener('beforeunload', () => {
  persistLastWatched(true);
  if (statsDirty) saveStats();
});

/* ---------- init ---------- */

renderTodayStat();
renderLibrary();
