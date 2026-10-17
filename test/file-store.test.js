import assert from 'node:assert/strict';
import test from 'node:test';

import { FileStore, FILE_STORE_LIMITS } from '../worker/src/do/FileStore.ts';
import {
  deleteStoredFile,
  fileStoreShardName,
  getStoredFile,
  hasFileStorage,
  putStoredFile,
} from '../worker/src/file-storage.js';

function harness() {
  const values = new Map();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) {
      if (Array.isArray(key)) {
        let deleted = 0;
        for (const item of key) deleted += values.delete(item) ? 1 : 0;
        return deleted;
      }
      return values.delete(key);
    },
  };
  const object = new FileStore({ storage });
  const names = [];
  const namespace = {
    idFromName(name) { names.push(name); return name; },
    get() { return { fetch: (request) => object.fetch(request) }; },
  };
  return { env: { FILE_STORE: namespace }, names, values };
}

test('Durable Object attachment storage round-trips and deletes encrypted bytes', async () => {
  const h = harness();
  const key = '42/1792214400000-example.bin';
  const source = Uint8Array.from([9, 8, 7, 6]);
  assert.equal(hasFileStorage(h.env), true);
  await putStoredFile(h.env, key, source);
  const stored = await getStoredFile(h.env, key);
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), source);
  assert.equal(stored.uploaded instanceof Date, true);
  assert.deepEqual(h.names, ['user:42:2026-10-17', 'user:42:2026-10-17']);
  await deleteStoredFile(h.env, key);
  assert.equal(await getStoredFile(h.env, key), null);
});

test('Durable Object attachment storage rejects direct oversized writes', async () => {
  const h = harness();
  const oversized = new Uint8Array(FILE_STORE_LIMITS.maxStoredBytes + 1);
  await assert.rejects(
    () => putStoredFile(h.env, '1/1792214400000-big.bin', oversized),
    /附件存储写入失败 \(413\)/,
  );
  assert.equal(h.values.size, 0);
});

test('attachment shards isolate users and UTC upload days', () => {
  assert.equal(fileStoreShardName('1/1792214400000-a.webp'), 'user:1:2026-10-17');
  assert.equal(fileStoreShardName('2/1792214400000-a.webp'), 'user:2:2026-10-17');
  assert.equal(fileStoreShardName('telegram/-1001/9-a.ogg'), 'telegram:-1001:legacy');
});
