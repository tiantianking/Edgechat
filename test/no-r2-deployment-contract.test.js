import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('production defaults preserve no-R2 image storage and one-day retention', () => {
  const config = source('wrangler.example.toml');
  assert.match(config, /^MESSAGE_RETENTION_DAYS = "1"$/m);
  assert.match(config, /^MAX_FILE_SIZE = "1310720"$/m);
  assert.match(config, /^FILE_STORAGE_BUDGET_BYTES = "3000000000"$/m);
  assert.match(config, /^ALLOWED_FILE_TYPES = "image\/,audio\/"$/m);
  assert.match(config, /name = "FILE_STORE"\s+class_name = "FileStore"/);
  assert.match(config, /tag = "v6"\s+new_sqlite_classes = \["FileStore"\]/);
});

test('upload path and composer preserve Durable Object fallback and browser compression', () => {
  const upload = source('worker/src/api/upload.js');
  const queue = source('frontend/src/composables/useAttachmentQueue.js');
  const composer = source('frontend/src/components/chat/MessageComposer.vue');
  assert.match(upload, /hasFileStorage\(c\.env\)/);
  assert.match(upload, /putStoredFile\(env, key, encryptedFile/);
  assert.match(queue, /compressImageForUpload\(entry\.file\)/);
  assert.match(composer, /accept="image\/\*"/);
});

test('cron keeps frequent rescue separate from the once-daily retention sweep', () => {
  const worker = source('worker/src/index.js');
  assert.match(worker, /if \(shouldRunDailyGc\(controller\.scheduledTime\)\)/);
  assert.match(worker, /getUTCHours\(\) === 19 && time\.getUTCMinutes\(\) === 0/);
});
