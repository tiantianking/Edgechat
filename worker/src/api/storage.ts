import { runAuthorizedBatch } from '../rbac/authorization.ts';
import { ApiError } from '../errors.js';
import { summarizeR2Objects } from '../storage-statistics.js';
import { listStorageOwners } from '../data/users.js';

async function saveSnapshot(db, authorizationContext, snapshot) {
  await runAuthorizedBatch(db, authorizationContext, [db.prepare(`INSERT INTO site_settings (setting_key, setting_value)
    VALUES ('admin_storage_snapshot', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`).bind(JSON.stringify(snapshot))]);
}

async function scanDurableObjectStorage(db) {
  const { results } = await db.prepare(`SELECT owner_user_id, COUNT(*) AS object_count,
      COALESCE(SUM(size), 0) AS bytes, MAX(created_at) AS latest_uploaded_at
    FROM uploaded_files uf
    WHERE NOT EXISTS (
      SELECT 1 FROM pending_r2_delete pending WHERE pending.object_key = uf.object_key
    )
    GROUP BY owner_user_id`).all();
  return results.map((row) => ({
    ownerKey: `user:${Number(row.owner_user_id)}`,
    ownerType: 'user',
    ownerId: Number(row.owner_user_id),
    objectCount: Number(row.object_count || 0),
    bytes: Number(row.bytes || 0),
    latestUploadedAt: row.latest_uploaded_at ? new Date(`${row.latest_uploaded_at}Z`).toISOString() : null,
  }));
}

export function registerStorageRoutes(app) {
  app.get('/api/admin/storage', async (c) => {
    const row = await c.env.DB.prepare("SELECT setting_value FROM site_settings WHERE setting_key = 'admin_storage_snapshot'").first();
    return c.json(row ? JSON.parse(row.setting_value) : { items: [], users: [], scannedAt: null });
  });
  app.post('/api/admin/storage/scan', async (c) => {
    if (!c.env.FILES && !c.env.FILE_STORE) throw new ApiError('当前部署没有绑定 R2，无法统计存储空间', 503);
    const cursor = c.req.query('cursor') || '';
    const key = `storage-scan:${c.get('session').userId}`;
    let state = cursor ? JSON.parse(await c.env.SESSIONS.get(key) || 'null') : null;
    if (cursor && (!state || state.cursor !== cursor || state.pages >= 100)) throw new ApiError('扫描游标无效或超过单次扫描范围', 400);
    const db = c.get('authorizationDatabase');
    if (!cursor) {
      await runAuthorizedBatch(db, c.get('authorizationContext'), [], {
        sql: "NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE actor_id = ? AND action = 'storage.scan' AND created_at > datetime('now', '-1 minute'))",
        params: [c.get('session').userId],
      });
      state = { pages: 0, items: {}, users: await listStorageOwners(db) };
    }
    if (c.env.FILE_STORE) {
      if (cursor) throw new ApiError('扫描游标无效或超过单次扫描范围', 400);
      const items = await scanDurableObjectStorage(db);
      const snapshot = { items, users: state.users, scannedAt: new Date().toISOString() };
      await saveSnapshot(db, c.get('authorizationContext'), snapshot);
      return c.json({ items, users: state.users, scannedObjects: items.reduce((sum, item) => sum + item.objectCount, 0), truncated: false, cursor: null });
    }
    const listed = await c.env.FILES.list({ limit: 1000, ...(cursor ? { cursor } : {}), include: [] });
    const items = summarizeR2Objects(listed.objects);
    for (const item of items) {
      const previous = state.items[item.ownerKey];
      state.items[item.ownerKey] = previous ? { ...item, bytes: previous.bytes + item.bytes,
        objectCount: previous.objectCount + item.objectCount, latestUploadedAt: [previous.latestUploadedAt, item.latestUploadedAt].filter(Boolean).sort().pop() || null } : item;
    }
    state.pages++;
    state.cursor = listed.truncated ? listed.cursor : null;
    if (listed.truncated) await c.env.SESSIONS.put(key, JSON.stringify(state), { expirationTtl: 600 });
    else {
      const snapshot = { items: Object.values(state.items), users: state.users, scannedAt: new Date().toISOString() };
      await saveSnapshot(db, c.get('authorizationContext'), snapshot);
      await c.env.SESSIONS.delete(key);
    }
    return c.json({ items, users: cursor ? undefined : state.users, scannedObjects: listed.objects.length, truncated: listed.truncated, cursor: state.cursor });
  });
}
