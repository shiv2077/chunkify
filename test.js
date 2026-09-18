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

  eq('format h:mm:ss', formatTime(4105), '1:08:25');
  eq('format m:ss', formatTime(323), '5:23');

  const failed = results.filter((r) => !r.ok).length;
  console.log(results.map((r) => r.line).join('\n'));
  const banner = document.createElement('pre');
  banner.style.cssText = `margin:0;padding:1rem;font:12px/1.6 ui-monospace,monospace;background:${failed ? '#3a1414' : '#12301c'};color:#eee;white-space:pre-wrap`;
  banner.textContent = `${results.length - failed}/${results.length} passed\n\n` + results.map((r) => r.line).join('\n');
  document.body.prepend(banner);
}
