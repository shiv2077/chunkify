'use strict';

/* The card foundry.

   Generate: for one section, pull that section's transcript window and ask the
   local generator for N candidate cards, each carrying a predicted difficulty
   and the transcript span it came from.

   Verify: a judge pass over every candidate, checking three things — is it
   answerable from the segment alone, is the answer actually grounded in the
   segment, and is it a duplicate of a card that already exists. The verdict and
   its reason are stored either way, so a rejection is inspectable rather than
   silent. Only verified cards get a dueAt, which is what puts them in the queue.

   Cards live on the chunk, beside the fields that were already there. They use
   the same dueAt/reps/lastRating names as chunks, so scheduleReview() schedules
   a card without knowing it is one. */

/* Prompts and output schemas live in prompts.json, which eval_foundry.py reads
   from disk. One file, two readers: a prompt cannot drift out of step with the
   evaluation that is supposed to describe it. Loaded lazily so a fetch failure
   breaks only the foundry, never app startup. */

let promptsPromise = null;

function prompts() {
  if (promptsPromise) return promptsPromise;
  promptsPromise = fetch('prompts.json')
    .then((res) => {
      if (!res.ok) throw new Error(`prompts.json returned ${res.status}`);
      return res.json();
    })
    .catch((err) => {
      promptsPromise = null; // let the next attempt retry
      throw new Error(`Could not load prompts.json (${err.message})`);
    });
  return promptsPromise;
}

// {{name}} -> vars.name, for the templates in prompts.json
function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole);
}

// one prompts.json entry -> the arguments chatJson wants
function promptCall(spec, vars, role) {
  return {
    messages: [
      { role: 'system', content: spec.system },
      { role: 'user', content: fillTemplate(spec.user, vars) },
    ],
    options: { role, maxTokens: spec.maxTokens, schema: spec.schema, schemaName: spec.schemaName },
  };
}

/* ---------- transcript ---------- */

const transcriptCache = new Map();

function transcriptFor(videoId) {
  if (transcriptCache.has(videoId)) return transcriptCache.get(videoId);
  const base = String(settings.helperBaseUrl || '').replace(/\/$/, '');
  const p = fetch(`${base}/transcript?videoId=${encodeURIComponent(videoId)}`, { signal: AbortSignal.timeout(120000) })
    .then((res) => res.json().catch(() => ({})).then((data) => {
      if (!res.ok) throw new Error(data.error || `Transcript request failed (${res.status})`);
      return data.segments || [];
    }))
    .catch((err) => {
      transcriptCache.delete(videoId); // a failure should not be cached forever
      if (err instanceof TypeError) throw new Error('Helper is not running (start it with ./run.sh --helper)');
      throw err;
    });
  transcriptCache.set(videoId, p);
  return p;
}

// every transcript segment overlapping this section, in order
function transcriptWindow(segments, startSeconds, endSeconds) {
  return segments.filter((s) => s.end > startSeconds && s.start < endSeconds);
}

function windowText(window) {
  return window.map((s) => s.text).join(' ');
}

// Locate the model's quote in the window so a card points at a real time span.
// Falls back to the whole section when the quote does not match.
function spanForQuote(window, quote, fallbackStart, fallbackEnd) {
  const needle = String(quote || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (needle.length >= 8) {
    const hits = window.filter((s) => {
      const hay = s.text.toLowerCase();
      return needle.includes(hay) || hay.includes(needle.slice(0, 40));
    });
    if (hits.length) {
      return {
        startSeconds: hits[0].start,
        endSeconds: hits[hits.length - 1].end,
        text: windowText(hits),
      };
    }
  }
  return { startSeconds: fallbackStart, endSeconds: fallbackEnd, text: windowText(window).slice(0, 600) };
}

/* ---------- generate ---------- */

// Small models sometimes echo the quote into the prompt or answer text even
// when the schema gives it its own field. Cut the echo rather than show it.
function stripQuoteEcho(s) {
  return String(s).replace(/\s*(?:quote|source)\s*[:=]\s*["'\u2018\u201c].*$/is, '').trim();
}

// The schema's maxLength is a hard cut, so a long answer can end mid-word.
// Fall back to the last full sentence, else the last full word.
function tidyTruncation(s, cap) {
  if (s.length < cap - 4 || /[.!?]$/.test(s)) return s;
  const sentence = Math.max(s.lastIndexOf('.'), s.lastIndexOf('!'), s.lastIndexOf('?'));
  if (sentence > cap * 0.5) return s.slice(0, sentence + 1);
  const word = s.lastIndexOf(' ');
  return (word > cap * 0.5 ? s.slice(0, word) : s).replace(/[\s,;:]+$/, '') + '…';
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

function generateCandidates(chunk, window, count) {
  const text = windowText(window);
  if (text.trim().length < 80) return Promise.reject(new Error('Transcript for this section is too short to build cards from.'));

  return prompts().then((p) => {
    const { messages, options } = promptCall(p.generate, {
      label: chunk.label, text: text.slice(0, 6000), count,
    }, 'generate');

    return chatJson(messages, options).then((reply) => {
      const raw = Array.isArray(reply) ? reply : reply.cards;
      if (!Array.isArray(raw)) throw new Error('Generator did not return a card list.');
      return raw
        .filter((c) => c && typeof c.prompt === 'string' && typeof c.answer === 'string' && stripQuoteEcho(c.prompt) && stripQuoteEcho(c.answer))
        .slice(0, count)
        .map((c) => ({
          id: uid(),
          type: c.type === 'cloze' ? 'cloze' : 'open',
          prompt: tidyTruncation(stripQuoteEcho(c.prompt), 220),
          answer: tidyTruncation(stripQuoteEcho(c.answer), 220),
          difficulty: clamp01(c.difficulty),
          source: spanForQuote(window, c.quote, chunk.startSeconds, chunk.endSeconds),
          createdAt: Date.now(),
          history: [],
        }));
    });
  });
}

/* ---------- verify ---------- */

function verifyCandidate(card, segmentText, existingPrompts) {
  return prompts().then((p) => {
    const { messages, options } = promptCall(p.verify, {
      segment: segmentText.slice(0, 6000),
      prompt: card.prompt,
      answer: card.answer,
      existing: existingPrompts.length ? existingPrompts.map((x) => `- ${x}`).join('\n') : '(none)',
    }, 'judge');

    return chatJson(messages, options).then((v) => ({
      answerable: v.answerable === true,
      grounded: v.grounded === true,
      duplicate: v.duplicate === true,
      reason: typeof v.reason === 'string' ? v.reason.trim() : '',
    }));
  });
}

function applyVerdict(card, checks) {
  card.checks = checks;
  card.reason = checks.reason;
  card.verifiedAt = Date.now();
  card.verdict = checks.answerable && checks.grounded && !checks.duplicate ? 'verified' : 'rejected';
  // only a verified card gets a due date, and only a due date puts it in the queue
  if (card.verdict === 'verified' && !card.dueAt) {
    card.dueAt = Date.now();
    card.reps = 0;
  }
  return card;
}

/* Full run for one section: transcript -> generate -> verify -> persist. */
function runFoundry(video, chunk, onStatus) {
  const say = (msg) => { if (onStatus) onStatus(msg); };
  const count = Math.min(10, Math.max(1, Number(settings.cardsPerChunk) || 4));

  say('Fetching transcript…');
  return transcriptFor(video.id)
    .then((segments) => {
      const window = transcriptWindow(segments, chunk.startSeconds, chunk.endSeconds);
      if (!window.length) throw new Error('No transcript lines fall inside this section.');
      say(`Generating ${count} candidates…`);
      return generateCandidates(chunk, window, count).then((cands) => ({ cands, segmentText: windowText(window) }));
    })
    .then(({ cands, segmentText }) => {
      if (!cands.length) throw new Error('Generator produced no usable cards.');
      const existing = (chunk.cards || []).filter((c) => c.verdict === 'verified').map((c) => c.prompt);

      // sequential: the judge sees each accepted card, so it can catch
      // duplicates inside this batch and not just against the stored deck
      let done = 0;
      return cands.reduce(
        (chain, card) =>
          chain.then((acc) => {
            say(`Verifying ${++done} of ${cands.length}…`);
            return verifyCandidate(card, segmentText, existing.concat(acc.filter((c) => c.verdict === 'verified').map((c) => c.prompt)))
              .then((checks) => acc.concat(applyVerdict(card, checks)))
              .catch((err) => acc.concat(applyVerdict(card, {
                answerable: false, grounded: false, duplicate: false,
                reason: `Verification failed: ${err.message}`,
              })));
          }),
        Promise.resolve([])
      );
    })
    .then((cards) => {
      chunk.cards = (chunk.cards || []).concat(cards);
      saveLibrary();
      const kept = cards.filter((c) => c.verdict === 'verified').length;
      say(`${kept} of ${cards.length} verified.`);
      return cards;
    });
}

/* ---------- queue ---------- */

function verifiedCards(chunk) {
  return (chunk.cards || []).filter((c) => c.verdict === 'verified');
}

// every verified card that is due now, across the whole library, soonest first
function dueCards(now = Date.now()) {
  const due = [];
  for (const video of library) {
    for (const chunk of video.chunks) {
      for (const card of verifiedCards(chunk)) {
        if (card.dueAt && card.dueAt <= now) due.push({ video, chunk, card });
      }
    }
  }
  return due.sort((x, y) => x.card.dueAt - y.card.dueAt);
}

// the card to put in front of the user when this section's recall check opens
function nextCardForChunk(chunk, now = Date.now()) {
  const cards = verifiedCards(chunk);
  if (!cards.length) return null;
  const due = cards.filter((c) => c.dueAt && c.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  return due[0] || cards.slice().sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))[0];
}

/* ---------- per-section card UI ---------- */

function renderChunkCards(wrap, video, chunk) {
  wrap.innerHTML = '';

  const bar = document.createElement('div');
  bar.className = 'cards-bar';
  const genBtn = document.createElement('button');
  genBtn.className = 'secondary cards-gen-btn';
  genBtn.textContent = (chunk.cards && chunk.cards.length) ? 'Generate more' : 'Generate cards';
  const status = document.createElement('span');
  status.className = 'cards-status';
  bar.append(genBtn, status);
  wrap.appendChild(bar);

  genBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    genBtn.disabled = true;
    runFoundry(video, chunk, (msg) => { status.textContent = msg; })
      .then(() => {
        genBtn.disabled = false;
        renderChunkCards(wrap, video, chunk);
        renderSideProgress();
      })
      .catch((err) => {
        genBtn.disabled = false;
        status.textContent = err.message;
        status.classList.add('cards-error');
      });
  });

  const list = document.createElement('div');
  list.className = 'cards-list';
  for (const card of chunk.cards || []) {
    const row = document.createElement('div');
    row.className = 'card-row ' + (card.verdict === 'verified' ? 'verified' : 'rejected');

    const head = document.createElement('div');
    head.className = 'card-head';
    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.textContent = card.type === 'cloze' ? 'cloze' : 'open';
    const diff = document.createElement('span');
    diff.className = 'card-diff';
    diff.textContent = `d ${card.difficulty.toFixed(2)}`;
    diff.title = 'Predicted chance of failing this on first recall';
    const jump = document.createElement('button');
    jump.className = 'stamp-chip';
    jump.textContent = formatTime(card.source.startSeconds);
    jump.title = 'Play the transcript span this card came from';
    jump.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (player && player.seekTo) { player.seekTo(card.source.startSeconds, true); player.playVideo(); }
    });
    head.append(badge, diff, jump);

    const prompt = document.createElement('p');
    prompt.className = 'card-prompt';
    prompt.textContent = card.prompt;

    const answer = document.createElement('p');
    answer.className = 'card-answer';
    answer.textContent = card.answer;

    row.append(head, prompt, answer);

    if (card.verdict !== 'verified') {
      const why = document.createElement('p');
      why.className = 'card-why';
      const failed = [];
      if (card.checks && !card.checks.answerable) failed.push('not answerable from the segment');
      if (card.checks && !card.checks.grounded) failed.push('answer not grounded in the segment');
      if (card.checks && card.checks.duplicate) failed.push('duplicate');
      why.textContent = `Rejected — ${failed.join(', ') || 'unverified'}. ${card.reason || ''}`.trim();
      row.appendChild(why);
    }

    const del = document.createElement('button');
    del.className = 'icon-btn card-del';
    del.textContent = '×';
    del.title = 'Delete card';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      chunk.cards = chunk.cards.filter((c) => c.id !== card.id);
      saveLibrary();
      renderChunkCards(wrap, video, chunk);
    });
    row.appendChild(del);

    list.appendChild(row);
  }
  wrap.appendChild(list);
}

/* ---------- free-recall grading ---------- */

const RATING_WORD = { 1: 'Lost it', 2: 'Shaky', 3: 'Got it' };

/* Grade a typed answer against the card's reference answer.
   Returns { rating, reason } — a suggestion the user accepts or overrides. */
function gradeFreeRecall(card, typedAnswer) {
  return prompts().then((p) => {
    const { messages, options } = promptCall(p.grade, {
      prompt: card.prompt,
      answer: card.answer,
      segment: (card.source && card.source.text ? card.source.text : '').slice(0, 2000),
      typed: String(typedAnswer).slice(0, 2000),
    }, 'judge');

    return chatJson(messages, options).then((v) => {
      const rating = [1, 2, 3].includes(Number(v.rating)) ? Number(v.rating) : 2;
      return { rating, reason: typeof v.reason === 'string' ? v.reason.trim() : '' };
    });
  });
}

/* One graded answer, kept for the calibration view: what the generator
   predicted versus what actually happened. */
function recordCardOutcome(card, rating, { suggested = null, typedAnswer = '' } = {}) {
  card.history = card.history || [];
  card.history.push({
    at: Date.now(),
    predicted: card.difficulty,     // predicted P(fail)
    outcome: rating < 3 ? 1 : 0,    // observed fail
    rating,
    suggested,
    graded: suggested !== null,
    overridden: suggested !== null && suggested !== rating,
    answerLength: String(typedAnswer).length,
  });
  scheduleReview(card, rating);     // same scheduler the sections use
}

// every graded outcome across the library, oldest first
function gradedOutcomes() {
  const out = [];
  for (const video of library) {
    for (const chunk of video.chunks) {
      for (const card of chunk.cards || []) {
        for (const h of card.history || []) {
          if (Number.isFinite(h.predicted) && (h.outcome === 0 || h.outcome === 1)) out.push(h);
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ---------- calibration ---------- */

/* The whole point of storing a predicted difficulty is being able to ask
   whether it meant anything. Difficulty is a claim about P(fail); these
   measure that claim against what actually happened. */

// mean squared error between predicted P(fail) and the 0/1 outcome; lower is better
function brierScore(outcomes) {
  if (!outcomes.length) return null;
  return outcomes.reduce((sum, o) => sum + (o.predicted - o.outcome) ** 2, 0) / outcomes.length;
}

// what a coin-flip-free baseline would score: always predict the base rate
function baseRateBrier(outcomes) {
  if (!outcomes.length) return null;
  const base = outcomes.reduce((s, o) => s + o.outcome, 0) / outcomes.length;
  return outcomes.reduce((sum, o) => sum + (base - o.outcome) ** 2, 0) / outcomes.length;
}

function reliabilityBins(outcomes, binCount = 5) {
  const bins = Array.from({ length: binCount }, (_, i) => ({
    lo: i / binCount,
    hi: (i + 1) / binCount,
    n: 0,
    predictedSum: 0,
    outcomeSum: 0,
  }));
  for (const o of outcomes) {
    const idx = Math.min(binCount - 1, Math.floor(o.predicted * binCount));
    bins[idx].n++;
    bins[idx].predictedSum += o.predicted;
    bins[idx].outcomeSum += o.outcome;
  }
  return bins.map((b) => ({
    lo: b.lo,
    hi: b.hi,
    n: b.n,
    meanPredicted: b.n ? b.predictedSum / b.n : null,
    observedRate: b.n ? b.outcomeSum / b.n : null,
  }));
}

// expected calibration error: bin-size-weighted gap between predicted and observed
function expectedCalibrationError(outcomes, binCount = 5) {
  if (!outcomes.length) return null;
  return reliabilityBins(outcomes, binCount)
    .filter((b) => b.n > 0)
    .reduce((sum, b) => sum + (b.n / outcomes.length) * Math.abs(b.meanPredicted - b.observedRate), 0);
}

/* ---------- calibration view ---------- */

const calibrationDialog = document.getElementById('calibration-dialog');
const calibrationBody = document.getElementById('calibration-body');

function reliabilitySvg(bins) {
  const S = 220, PAD = 28, span = S - PAD * 2;
  const x = (v) => PAD + v * span;
  const y = (v) => S - PAD - v * span;
  const points = bins.filter((b) => b.n > 0);
  const maxN = Math.max(1, ...points.map((b) => b.n));

  const dots = points
    .map((b) => {
      const r = 3 + 5 * (b.n / maxN);
      return `<circle cx="${x(b.meanPredicted).toFixed(1)}" cy="${y(b.observedRate).toFixed(1)}" r="${r.toFixed(1)}" fill="var(--accent-2)"><title>predicted ${b.meanPredicted.toFixed(2)}, observed ${b.observedRate.toFixed(2)}, n=${b.n}</title></circle>`;
    })
    .join('');
  const path = points.length > 1
    ? `<polyline points="${points.map((b) => `${x(b.meanPredicted).toFixed(1)},${y(b.observedRate).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>`
    : '';

  return `
    <svg class="calib-plot" viewBox="0 0 ${S} ${S}" role="img" aria-label="Reliability curve: predicted difficulty against observed failure rate">
      <rect x="${PAD}" y="${PAD}" width="${span}" height="${span}" fill="none" stroke="var(--border)"/>
      <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="3 3"/>
      ${path}${dots}
      <text x="${PAD}" y="${S - 8}" fill="var(--text-dim)" font-size="9">0.0</text>
      <text x="${S - PAD - 14}" y="${S - 8}" fill="var(--text-dim)" font-size="9">1.0</text>
      <text x="${S / 2 - 34}" y="${S - 8}" fill="var(--text-dim)" font-size="9">predicted</text>
      <text x="4" y="${PAD + 8}" fill="var(--text-dim)" font-size="9">1.0</text>
      <text x="4" y="${S - PAD}" fill="var(--text-dim)" font-size="9">0.0</text>
    </svg>`;
}

function renderCalibration() {
  const outcomes = gradedOutcomes();
  calibrationBody.innerHTML = '';

  if (outcomes.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No graded cards yet. Generate cards on a section, then answer the recall check to start measuring whether predicted difficulty matches reality.';
    calibrationBody.appendChild(p);
    return;
  }

  const brier = brierScore(outcomes);
  const base = baseRateBrier(outcomes);
  const ece = expectedCalibrationError(outcomes);
  const failRate = outcomes.reduce((s, o) => s + o.outcome, 0) / outcomes.length;
  const bins = reliabilityBins(outcomes);

  const stats = document.createElement('div');
  stats.className = 'calib-stats';
  stats.innerHTML = `
    <div class="calib-stat"><b>${brier.toFixed(3)}</b><small>Brier score</small></div>
    <div class="calib-stat"><b>${base.toFixed(3)}</b><small>base-rate Brier</small></div>
    <div class="calib-stat"><b>${ece.toFixed(3)}</b><small>calibration error</small></div>
    <div class="calib-stat"><b>${outcomes.length}</b><small>graded answers</small></div>
  `;
  calibrationBody.appendChild(stats);

  const verdict = document.createElement('p');
  verdict.className = 'hint';
  verdict.textContent = brier < base
    ? `Predicted difficulty beats just guessing the average (${(failRate * 100).toFixed(0)}% of answers were wrong). Points near the dashed line are well calibrated.`
    : `Predicted difficulty is not beating a flat guess of the average (${(failRate * 100).toFixed(0)}% of answers were wrong). Points above the dashed line mean the generator is under-predicting difficulty.`;
  calibrationBody.appendChild(verdict);

  const plotWrap = document.createElement('div');
  plotWrap.className = 'calib-plot-wrap';
  plotWrap.innerHTML = reliabilitySvg(bins);
  calibrationBody.appendChild(plotWrap);

  const table = document.createElement('table');
  table.className = 'calib-table';
  table.innerHTML = '<thead><tr><th>predicted</th><th>n</th><th>mean pred.</th><th>observed fail</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const b of bins) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${b.lo.toFixed(1)}–${b.hi.toFixed(1)}</td>
      <td>${b.n}</td>
      <td>${b.meanPredicted === null ? '—' : b.meanPredicted.toFixed(2)}</td>
      <td>${b.observedRate === null ? '—' : b.observedRate.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  calibrationBody.appendChild(table);
}

document.getElementById('calibration-btn').addEventListener('click', () => {
  renderCalibration();
  calibrationDialog.showModal();
});
document.getElementById('calibration-close').addEventListener('click', () => calibrationDialog.close());
