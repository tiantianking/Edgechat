import { durableObjectHealth } from '../maintenance/do-health.ts';
import { isVerifiedInternalRequest } from '../verified-identity.js';

const FILE_PREFIX = 'file:';
const MAX_STORED_BYTES = 1536 * 1024;

interface StoredFile {
	bytes: Uint8Array;
	uploadedAt: number;
}

interface Storage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string | string[]): Promise<boolean | number>;
}

interface State { storage: Storage }

function storageKey(request: Request) {
	const path = new URL(request.url).pathname;
	if (!path.startsWith('/objects/')) return null;
	try {
		const key = decodeURIComponent(path.slice('/objects/'.length));
		return key ? `${FILE_PREFIX}${key}` : null;
	} catch {
		return null;
	}
}

export class FileStore {
	state: State;
	constructor(state: State) { this.state = state; }

	async fetch(request: Request) {
		const health = durableObjectHealth(request, 'FileStore');
		if (health) return health;
		if (!isVerifiedInternalRequest(request)) {
			return Response.json({ error: 'Unauthorized' }, { status: 401 });
		}
		const key = storageKey(request);
		if (!key) return new Response('Not Found', { status: 404 });

		if (request.method === 'PUT') {
			const body = await request.arrayBuffer();
			if (body.byteLength > MAX_STORED_BYTES) {
				return Response.json({ error: 'File too large' }, { status: 413 });
			}
			await this.state.storage.put(key, {
				bytes: new Uint8Array(body),
				uploadedAt: Date.now(),
			} satisfies StoredFile);
			return Response.json({ ok: true }, { status: 201 });
		}

		if (request.method === 'GET') {
			const file = await this.state.storage.get<StoredFile>(key);
			if (!file) return new Response('Not Found', { status: 404 });
			return new Response(file.bytes, {
				headers: { 'x-uploaded-at': String(file.uploadedAt) },
			});
		}

		if (request.method === 'DELETE') {
			await this.state.storage.delete(key);
			return Response.json({ ok: true });
		}

		return new Response('Method Not Allowed', { status: 405 });
	}
}

export const FILE_STORE_LIMITS = Object.freeze({ maxStoredBytes: MAX_STORED_BYTES });
