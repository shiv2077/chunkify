/* Self-check for the pure parsing/chunking logic. Open index.html#test and
   check the console (or the banner at the top of the page). */
'use strict';

if (location.hash === '#test') {
  const results = [];
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({ ok, line: `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}` });
  };

  eq('parse mm:ss', parseTimestampLine('0:00 Intro'), { seconds: 0, label: 'Intro' });
  eq('parse h:mm:ss', parseTimestampLine('1:08:25 Troubleshooting'), { seconds: 4105, label: 'Troubleshooting' });
  eq('parse strips leading dash', parseTimestampLine('5:23 - Setup'), { seconds: 323, label: 'Setup' });
  eq('parse rejects junk', parseTimestampLine('hello world'), null);
  eq('parse rejects 1:75', parseTimestampLine('1:75 Nope'), null);

  eq('empty paste errors', buildChunksFromTimestamps('', 600).error !== undefined, true);
  eq('single line is fine', buildChunksFromTimestamps('0:00 Only', 600).chunks.length, 1);
  eq('timestamps past the end error', buildChunksFromTimestamps('20:00 Late', 600).error !== undefined, true);
  eq(
    'sorted, deduped, ends chained',
    buildChunksFromTimestamps('5:00 B\n0:00 A\n5:00 dupe\n', 600).chunks.map((c) => [c.label, c.startSeconds, c.endSeconds]),
    [['A', 0, 300], ['B', 300, 600]]
  );

  const auto = buildAutoSplitChunks(650, 10);
  eq('autosplit labels', auto.chunks.map((c) => c.label), ['01', '02']);
  eq('autosplit last chunk is short', [auto.chunks[1].startSeconds, auto.chunks[1].endSeconds], [600, 650]);
  eq('autosplit zero length errors', buildAutoSplitChunks(650, 0).error !== undefined, true);

  eq('id from watch', extractVideoId('https://www.youtube.com/watch?t=9&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  eq('id from youtu.be', extractVideoId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
  eq('id from shorts', extractVideoId('youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  eq('id from embed', extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  eq('non-youtube rejected', extractVideoId('https://vimeo.com/12345'), null);

  // spaced review scheduling
  const DAY = 86400000;
  const days = (chunk) => Math.round((chunk.dueAt - Date.now()) / DAY);
  const rate = (chunk, ...ratings) => { for (const r of ratings) scheduleReview(chunk, r); return chunk; };

  eq('lost it comes back in minutes', days(rate({}, 1)), 0);
  eq('shaky comes back tomorrow', days(rate({}, 2)), 1);
  eq('first got it: 1 day', days(rate({}, 3)), 1);
  eq('gaps expand while you keep getting it', [1, 3, 7, 16].map((_, i) => days(rate({ reps: i }, 3))), [1, 3, 7, 16]);
  eq('gap caps at the longest interval', days(rate({ reps: 99 }, 3)), 35);
  eq('shaky walks the gap back down', days(rate({ reps: 2 }, 2, 3)), 3);
  eq('rating is remembered', rate({}, 3).lastRating, 3);

  const savedLibrary = library;
  library = [
    { id: 'v1', title: 'V', chunks: [
      { id: 'a', label: 'due now', dueAt: Date.now() - 1000 },
      { id: 'b', label: 'due later', dueAt: Date.now() + DAY },
      { id: 'c', label: 'overdue', dueAt: Date.now() - DAY },
      { id: 'd', label: 'never rated' },
    ] },
  ];
  eq('only rated + due sections queue up, oldest first', dueReviews().map((r) => r.chunk.id), ['c', 'a']);
  library = savedLibrary;

  // backup round-trip and validation
  const sampleLib = [{
    id: 'dQw4w9WgXcQ', url: 'u', title: 'T', thumbnailUrl: null, durationSeconds: 600,
    lastWatched: { chunkId: 'c1', positionSeconds: 12.5 },
    reels: [{ id: 'r1', title: 'A clip', hook: 'what you learn', startSeconds: 30, endSeconds: 70, createdAt: 1 }],
    chunks: [
      { id: 'c1', label: 'A', startSeconds: 0, endSeconds: 300, completed: true, note: '[1:00] hi' },
      { id: 'c2', label: 'B', startSeconds: 300, endSeconds: 600, completed: false, note: '', dueAt: 123, reps: 2, lastRating: 3 },
    ],
  }];
  const sampleStats = { days: { '2026-09-19': 1840 } };
  const roundTrip = (lib, sets, sts) => validateBackup(JSON.parse(JSON.stringify(buildBackup(lib, sets, sts))));

  eq('round-trip preserves the library exactly', roundTrip(sampleLib, settings, sampleStats).data.library, sampleLib);
  eq('round-trip preserves stats exactly', roundTrip(sampleLib, settings, sampleStats).data.stats, sampleStats);
  eq('round-trip keeps review fields', roundTrip(sampleLib, settings, sampleStats).data.library[0].chunks[1].reps, 2);
  eq('round-trip keeps reels', roundTrip(sampleLib, settings, sampleStats).data.library[0].reels,
    [{ id: 'r1', title: 'A clip', hook: 'what you learn', startSeconds: 30, endSeconds: 70, createdAt: 1 }]);
  eq('a video with reels but no cards still validates',
    validateBackup({ app: 'chunkify', version: 1, settings: {}, stats: { days: {} },
      library: [{ id: 'v', reels: [{ id: 'r', title: 't', startSeconds: 0, endSeconds: 20 }], chunks: [] }] }).error,
    undefined);
  eq('round-trip of an empty library is valid', roundTrip([], {}, { days: {} }).error, undefined);
  eq('export is self-identifying', [buildBackup([], {}, { days: {} }).app, buildBackup([], {}, { days: {} }).version], ['chunkify', 1]);

  const reject = (obj) => validateBackup(obj).error !== undefined;
  eq('rejects a non-object', reject('nope'), true);
  eq('rejects an array', reject([]), true);
  eq('rejects a foreign file', reject({ app: 'other', version: 1, library: [], settings: {}, stats: { days: {} } }), true);
  eq('rejects a future version', reject({ app: 'chunkify', version: 99, library: [], settings: {}, stats: { days: {} } }), true);
  eq('rejects a missing library', reject({ app: 'chunkify', version: 1, settings: {}, stats: { days: {} } }), true);
  eq('rejects missing stats.days', reject({ app: 'chunkify', version: 1, library: [], settings: {}, stats: {} }), true);
  eq('rejects non-numeric study seconds', reject({ app: 'chunkify', version: 1, library: [], settings: {}, stats: { days: { '2026-09-19': 'lots' } } }), true);

  const withChunks = (chunks) => ({ app: 'chunkify', version: 1, settings: {}, stats: { days: {} }, library: [{ id: 'v', chunks }] });
  eq('rejects a chunk with no id', reject(withChunks([{ startSeconds: 0, endSeconds: 10 }])), true);
  eq('rejects a non-numeric boundary', reject(withChunks([{ id: 'a', startSeconds: 0, endSeconds: 'ten' }])), true);
  eq('rejects a backwards chunk', reject(withChunks([{ id: 'a', startSeconds: 10, endSeconds: 5 }])), true);
  eq('rejects a gap between chunks', reject(withChunks([
    { id: 'a', startSeconds: 0, endSeconds: 10 }, { id: 'b', startSeconds: 20, endSeconds: 30 },
  ])), true);
  eq('rejects overlapping chunks', reject(withChunks([
    { id: 'a', startSeconds: 0, endSeconds: 20 }, { id: 'b', startSeconds: 10, endSeconds: 30 },
  ])), true);
  eq('accepts contiguous chunks', reject(withChunks([
    { id: 'a', startSeconds: 0, endSeconds: 10 }, { id: 'b', startSeconds: 10, endSeconds: 30 },
  ])), false);

  // calibration maths
  const O = (predicted, outcome) => ({ predicted, outcome });
  eq('brier of a perfect forecaster is 0', brierScore([O(1, 1), O(0, 0)]), 0);
  eq('brier of a perfectly wrong forecaster is 1', brierScore([O(0, 1), O(1, 0)]), 1);
  eq('brier of a hedge is 0.25', brierScore([O(0.5, 1), O(0.5, 0)]), 0.25);
  eq('brier of no data is null', brierScore([]), null);
  eq('base rate brier uses the observed mean', baseRateBrier([O(0.9, 1), O(0.9, 0)]), 0.25);

  eq('bins cover 0..1', reliabilityBins([], 5).map((b) => [b.lo, b.hi]),
    [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1]]);
  eq('empty bins report null, not zero', reliabilityBins([], 5)[0].observedRate, null);
  eq('a prediction of exactly 1.0 lands in the last bin', reliabilityBins([O(1, 1)], 5)[4].n, 1);
  eq('bin observed rate is the failure fraction',
    reliabilityBins([O(0.1, 1), O(0.1, 0), O(0.1, 0), O(0.1, 0)], 5)[0].observedRate, 0.25);
  // 10 predictions of 0.1 with exactly 1 failure is what "calibrated" means
  eq('perfectly calibrated predictions give ~0 error',
    Math.round(expectedCalibrationError(
      [O(0.1, 1)].concat(Array.from({ length: 9 }, () => O(0.1, 0))), 5) * 1000) / 1000, 0);
  eq('a confident-but-wrong forecaster shows a large gap',
    expectedCalibrationError([O(0.9, 0), O(0.9, 0)], 5), 0.9);
  eq('calibration error of no data is null', expectedCalibrationError([]), null);

  // model-output cleanup
  eq('strips an echoed quote from an answer',
    stripQuoteEcho("A number between 0 and 1. quote: 'each neuron holds a number'"), 'A number between 0 and 1.');
  eq('strips an echoed source label', stripQuoteEcho('The output layer. source: "the last layer"'), 'The output layer.');
  eq('leaves a clean answer alone', stripQuoteEcho('16 neurons'), '16 neurons');
  eq('does not eat the word quote in prose', stripQuoteEcho('He gave a quote about neurons'), 'He gave a quote about neurons');

  eq('short text is untouched', tidyTruncation('16 neurons', 220), '16 neurons');
  eq('a properly ended sentence is untouched',
    tidyTruncation('x'.repeat(219) + '.', 220), 'x'.repeat(219) + '.');
  // sentence end must fall past the halfway mark to be worth keeping
  eq('a mid-word cut falls back to the last sentence',
    tidyTruncation('A'.repeat(150) + '. ' + 'B'.repeat(66), 220), 'A'.repeat(150) + '.');
  eq('an early sentence end is not worth keeping, so it cuts at a word',
    tidyTruncation('Hi. ' + 'word '.repeat(42) + 'dangl', 220), ('Hi. ' + 'word '.repeat(42)).trim() + '\u2026');
  eq('with no sentence end it cuts at a word and marks it',
    tidyTruncation('word '.repeat(43) + 'dangl', 220), ('word '.repeat(43)).trim() + '\u2026');
  eq('a trailing comma is not left behind',
    /[,;:]\u2026$/.test(tidyTruncation('alpha beta, '.padEnd(219, 'z'), 220)), false);

  // a reply cut off mid-JSON is a token limit, not malformed output
  eq('truncated JSON is reported as cut off',
    (() => { try { parseJsonReply('{"cards":[{"prompt":"a"'); return 'no throw'; }
             catch (e) { return /cut off/.test(e.message); } })(), true);
  eq('a reply with no JSON at all says so',
    (() => { try { parseJsonReply('I cannot help with that'); return 'no throw'; }
             catch (e) { return /no JSON/.test(e.message); } })(), true);
  eq('fenced JSON still parses', parseJsonReply('here:\n```json\n{"a":1}\n```'), { a: 1 });

  // reels: raw model output -> clips that are safe to play
  const segs = Array.from({ length: 30 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: 'x' }));
  const reels = (raw, duration = 300) => buildReels(raw, segs, duration).map((r) => [r.title, r.startSeconds, r.endSeconds]);

  eq('snaps both edges to transcript lines',
    reels([{ title: 'A', startSeconds: 12, endSeconds: 47 }]), [['A', 10, 50]]);
  eq('a clip longer than the cap is truncated',
    reels([{ title: 'A', startSeconds: 0, endSeconds: 280 }]), [['A', 0, 75]]);
  eq('a clip shorter than the floor is extended',
    reels([{ title: 'A', startSeconds: 10, endSeconds: 15 }]), [['A', 10, 30]]);
  eq('clips are clamped inside the video',
    reels([{ title: 'A', startSeconds: 280, endSeconds: 9999 }]), [['A', 280, 300]]);
  eq('an overlapping clip is dropped, the earlier one wins',
    reels([{ title: 'A', startSeconds: 0, endSeconds: 40 }, { title: 'B', startSeconds: 30, endSeconds: 80 }]),
    [['A', 0, 40]]);
  eq('touching but not overlapping is fine',
    reels([{ title: 'A', startSeconds: 0, endSeconds: 40 }, { title: 'B', startSeconds: 40, endSeconds: 80 }]),
    [['A', 0, 40], ['B', 40, 80]]);
  eq('out-of-order clips come back in order',
    reels([{ title: 'B', startSeconds: 100, endSeconds: 140 }, { title: 'A', startSeconds: 0, endSeconds: 40 }]),
    [['A', 0, 40], ['B', 100, 140]]);
  eq('a clip with no title is dropped', reels([{ startSeconds: 0, endSeconds: 40 }]), []);
  eq('non-numeric times are dropped', reels([{ title: 'A', startSeconds: 'soon', endSeconds: 40 }]), []);
  eq('a backwards clip is dropped', reels([{ title: 'A', startSeconds: 90, endSeconds: 30 }]), []);
  eq('junk input gives no clips', buildReels(null, segs, 300), []);
  eq('every clip gets an id', buildReels([{ title: 'A', startSeconds: 0, endSeconds: 40 }], segs, 300)[0].id.startsWith('id-'), true);

  eq('passes cover the whole video, not just the start',
    reelPasses(segs, 300).length, 1);
  eq('a long video is split into passes',
    reelPasses(Array.from({ length: 120 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: 'x' })), 1200).length, 4);
  eq('every segment lands in exactly one pass',
    reelPasses(segs, 300).reduce((n, p) => n + p.length, 0), segs.length);
  eq('the last pass reaches the end of the transcript',
    (() => { const ps = reelPasses(segs, 300); return ps[ps.length - 1].slice(-1)[0].start; })(), 290);

  eq('clip count scales with length but stays sane',
    [reelCountFor(120), reelCountFor(1140), reelCountFor(7200)], [3, 10, 12]);
  eq('timed transcript is budgeted',
    timedTranscript([{ start: 5, text: 'hello' }, { start: 9, text: 'world' }], 12), '[5] hello');

  eq('format h:mm:ss', formatTime(4105), '1:08:25');
  eq('format m:ss', formatTime(323), '5:23');

  const failed = results.filter((r) => !r.ok).length;
  console.log(results.map((r) => r.line).join('\n'));
  const banner = document.createElement('pre');
  banner.style.cssText = `margin:0;padding:1rem;font:12px/1.6 ui-monospace,monospace;background:${failed ? '#3a1414' : '#12301c'};color:#eee;white-space:pre-wrap`;
  banner.textContent = `${results.length - failed}/${results.length} passed\n\n` + results.map((r) => r.line).join('\n');
  document.body.prepend(banner);
}
