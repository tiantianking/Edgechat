import { createInternalHeaders } from './verified-identity.js';

const FILE_PATH_PREFIX = '/objects/';

export function hasFileStorage(env) {
	return Boolean(env?.FILE_STORE || env?.FILES);
}

export function fileStoreShardName(key) {
	const cleanKey = String(key || '');
	const timestamp = cleanKey.match(/(?:^|\/)(\d{13})-/)?.[1];
	const day = timestamp
		? new Date(Number(timestamp)).toISOString().slice(0, 10)
		: 'legacy';
	const segments = cleanKey.split('/');
	const owner = segments[0] === 'telegram'
		? `telegram:${segments[1] || 'unknown'}`
		: `user:${segments[0] || 'unknown'}`;
	return `${owner}:${day}`;
}

function fileStoreStub(env, key) {
	const id = env.FILE_STORE.idFromName(fileStoreShardName(key));
	return env.FILE_STORE.get(id);
}

function fileStoreRequest(key, init = {}) {
	return new Request(`https://internal${FILE_PATH_PREFIX}${encodeURIComponent(key)}`, {
		...init,
		headers: createInternalHeaders(init.headers),
	});
}

export async function putStoredFile(env, key, bytes, options = {}) {
	if (env.FILE_STORE) {
		const response = await fileStoreStub(env, key).fetch(fileStoreRequest(key, {
			method: 'PUT',
			body: bytes,
		}));
		if (!response.ok) throw new Error(`附件存储写入失败 (${response.status})`);
		return;
	}
	if (env.FILES) {
		await env.FILES.put(key, bytes, options);
		return;
	}
	throw new Error('当前部署没有可用的附件存储');
}

export async function getStoredFile(env, key) {
	if (env.FILE_STORE) {
		const response = await fileStoreStub(env, key).fetch(fileStoreRequest(key));
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`附件存储读取失败 (${response.status})`);
		const uploadedAt = Number(response.headers.get('x-uploaded-at') || 0);
		return {
			uploaded: uploadedAt ? new Date(uploadedAt) : null,
			customMetadata: {},
			writeHttpMetadata() {},
			arrayBuffer: () => response.arrayBuffer(),
		};
	}
	return env.FILES ? env.FILES.get(key) : null;
}

export async function deleteStoredFile(env, key) {
	if (env.FILE_STORE) {
		const response = await fileStoreStub(env, key).fetch(fileStoreRequest(key, { method: 'DELETE' }));
		if (!response.ok && response.status !== 404) {
			throw new Error(`附件存储删除失败 (${response.status})`);
		}
		return;
	}
	if (env.FILES) await env.FILES.delete(key);
	else throw new Error('当前部署没有可用的附件存储');
}
