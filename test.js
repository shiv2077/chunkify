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

  eq('format h:mm:ss', formatTime(4105), '1:08:25');
  eq('format m:ss', formatTime(323), '5:23');

  const failed = results.filter((r) => !r.ok).length;
  console.log(results.map((r) => r.line).join('\n'));
  const banner = document.createElement('pre');
  banner.style.cssText = `margin:0;padding:1rem;font:12px/1.6 ui-monospace,monospace;background:${failed ? '#3a1414' : '#12301c'};color:#eee;white-space:pre-wrap`;
  banner.textContent = `${results.length - failed}/${results.length} passed\n\n` + results.map((r) => r.line).join('\n');
  document.body.prepend(banner);
}
