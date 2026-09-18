'use strict';

/* Backup: export all three storage keys to a file, and restore from one.
   Everything the app knows lives in localStorage, so a cleared browser profile
   is total data loss without this. Import validates before it writes; a
   malformed file must never partially overwrite a good library. */

const BACKUP_VERSION = 1;

function buildBackup(lib, sets, sts) {
  return {
    app: 'chunkify',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    library: lib,
    settings: sets,
    stats: sts,
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Returns { data } on success or { error } with a message fit to show the user.
// Checks structure and the contiguity invariant, never repairs silently.
function validateBackup(obj) {
  if (!isPlainObject(obj)) return { error: 'That file is not a Chunkify backup (expected a JSON object).' };
  if (obj.app !== 'chunkify') return { error: 'That file is not a Chunkify backup (missing the "chunkify" marker).' };
  if (typeof obj.version !== 'number' || obj.version > BACKUP_VERSION) {
    return { error: `Backup version ${obj.version} is newer than this app understands (${BACKUP_VERSION}).` };
  }
  if (!Array.isArray(obj.library)) return { error: 'Backup is missing its "library" list.' };
  if (!isPlainObject(obj.settings)) return { error: 'Backup is missing its "settings" object.' };
  if (!isPlainObject(obj.stats) || !isPlainObject(obj.stats.days)) {
    return { error: 'Backup is missing its "stats.days" object.' };
  }

  for (const value of Object.values(obj.stats.days)) {
    if (!Number.isFinite(value)) return { error: 'Backup has a non-numeric value in stats.days.' };
  }

  for (let i = 0; i < obj.library.length; i++) {
    const video = obj.library[i];
    const where = `Video ${i + 1}`;
    if (!isPlainObject(video)) return { error: `${where} is not an object.` };
    if (typeof video.id !== 'string' || !video.id) return { error: `${where} has no id.` };
    if (!Array.isArray(video.chunks)) return { error: `${where} has no "chunks" list.` };

    for (let j = 0; j < video.chunks.length; j++) {
      const chunk = video.chunks[j];
      const at = `${where}, section ${j + 1}`;
      if (!isPlainObject(chunk)) return { error: `${at} is not an object.` };
      if (typeof chunk.id !== 'string' || !chunk.id) return { error: `${at} has no id.` };
      if (!Number.isFinite(chunk.startSeconds) || !Number.isFinite(chunk.endSeconds)) {
        return { error: `${at} has a non-numeric start or end time.` };
      }
      if (chunk.endSeconds <= chunk.startSeconds) return { error: `${at} ends before it starts.` };
      // sections must tile the video with no gaps or overlaps
      if (j > 0 && video.chunks[j - 1].endSeconds !== chunk.startSeconds) {
        return { error: `${at} does not start where the previous one ends.` };
      }
    }
  }

  return { data: { library: obj.library, settings: obj.settings, stats: obj.stats } };
}

/* ---------- UI ---------- */

const backupDownloadBtn = document.getElementById('backup-download');
const backupFileInput = document.getElementById('backup-file');
const backupMsgEl = document.getElementById('backup-msg');

function backupMessage(text, kind) {
  backupMsgEl.textContent = text;
  backupMsgEl.className = kind === 'error' ? 'error' : 'hint';
}

backupDownloadBtn.addEventListener('click', () => {
  const json = JSON.stringify(buildBackup(library, settings, stats), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `chunkify-backup-${dayKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  const sections = library.reduce((n, v) => n + v.chunks.length, 0);
  backupMessage(`Downloaded ${library.length} video(s), ${sections} section(s).`);
});

backupFileInput.addEventListener('change', () => {
  const file = backupFileInput.files && backupFileInput.files[0];
  if (!file) return;
  backupFileInput.value = ''; // let the same file be picked again after a failure

  file.text().then((text) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      backupMessage('That file is not valid JSON, so nothing was changed.', 'error');
      return;
    }
    const result = validateBackup(parsed);
    if (result.error) {
      backupMessage(result.error + ' Nothing was changed.', 'error');
      return;
    }
    const incoming = result.data.library.length;
    if (!confirm(`Replace your current library (${library.length} video(s)) with the backup's ${incoming} video(s)? This cannot be undone.`)) {
      backupMessage('Restore cancelled. Nothing was changed.');
      return;
    }

    library = result.data.library;
    settings = Object.assign({}, settings, result.data.settings);
    stats = result.data.stats;
    saveLibrary();
    saveSettings();
    saveStats();
    renderTodayStat();
    renderLibrary();
    backupMessage(`Restored ${incoming} video(s). Reopen settings to see the restored values.`);
  });
});
