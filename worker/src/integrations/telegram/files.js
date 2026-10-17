import {
	normalizeContentType,
	safeFilenameExtension,
	sanitizeFilename,
} from "../../attachment-metadata.js";
import { decryptAttachment, encryptAttachment } from "../../encryption.js";
import { deleteStoredFile, getStoredFile, hasFileStorage, putStoredFile } from "../../file-storage.js";
import { downloadTelegramFile, getTelegramFile } from "./client.js";

export const TELEGRAM_BRIDGE_FILE_LIMIT = 16 * 1024 * 1024;
export const TELEGRAM_FILE_SKIP_REASON = Object.freeze({
	TOO_LARGE: "too_large",
	STORAGE_UNAVAILABLE: "storage_unavailable",
	NOT_FOUND: "not_found",
});
const FILE_RESPONSE_CACHE_CONTROL = "private, no-store";

function telegramObjectKey({ telegramChatId, telegramMessageId, filename }) {
	const extension = safeFilenameExtension(filename);
	return `telegram/${telegramChatId}/${telegramMessageId}-${crypto.randomUUID()}${extension}`;
}

function telegramFileLimit(env) {
	const configured = Number(env.MAX_FILE_SIZE || TELEGRAM_BRIDGE_FILE_LIMIT);
	return Math.min(TELEGRAM_BRIDGE_FILE_LIMIT, Number.isFinite(configured) ? configured : TELEGRAM_BRIDGE_FILE_LIMIT);
}

export async function importTelegramAttachment(env, {
	botToken,
	telegramChatId,
	telegramMessageId,
	attachment,
}) {
	if (!attachment) return { attachment: null, skipReason: null };
	if (!hasFileStorage(env)) {
		return {
			attachment: null,
			skipReason: TELEGRAM_FILE_SKIP_REASON.STORAGE_UNAVAILABLE,
		};
	}
	const fileLimit = telegramFileLimit(env);
	if (attachment.fileSize > fileLimit) {
		return { attachment: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
	}

	const telegramFile = await getTelegramFile(botToken, attachment.fileId);
	const resolvedSize = Number(telegramFile.file_size || attachment.fileSize || 0);
	if (resolvedSize > fileLimit) {
		return { attachment: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
	}
	const bytes = await downloadTelegramFile(
		botToken,
		telegramFile.file_path,
		fileLimit,
	);
	const name = sanitizeFilename(attachment.fileName);
	const type = normalizeContentType(attachment.mimeType) || "application/octet-stream";
	const key = telegramObjectKey({ telegramChatId, telegramMessageId, filename: name });
	// Telegram 只负责传输，正式附件在进入消息前即转换为 EdgeChat 自有加密对象。
	const encrypted = await encryptAttachment(env, bytes, key);
	await putStoredFile(env, key, encrypted, {
		httpMetadata: { contentType: type, cacheControl: FILE_RESPONSE_CACHE_CONTROL },
		customMetadata: { filename: name, edgechatEncryption: "v1", source: "telegram" },
	});
	return {
		attachment: {
			key,
			name,
			type,
			size: bytes.byteLength,
				...(attachment.kind === "voice" || attachment.kind === "audio"
					? {
						kind: attachment.kind,
						durationMs: attachment.durationMs || 0,
						...(attachment.kind === "voice" ? { waveform: [] } : {}),
					}
					: {}),
		},
		skipReason: null,
	};
}

export async function loadEdgeChatAttachment(env, attachment) {
	if (!attachment) {
		return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.NOT_FOUND };
	}
	const fileLimit = telegramFileLimit(env);
	if (Number(attachment.size) > fileLimit) {
		return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
	}
	if (!hasFileStorage(env)) {
		return {
			file: null,
			skipReason: TELEGRAM_FILE_SKIP_REASON.STORAGE_UNAVAILABLE,
		};
	}
	const object = await getStoredFile(env, attachment.key);
	if (!object) {
		return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.NOT_FOUND };
	}
	const decrypted = await decryptAttachment(env, await object.arrayBuffer(), attachment.key);
	if (decrypted.bytes.byteLength > fileLimit) {
		return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
	}
	return {
		file: {
			bytes: decrypted.bytes,
			name: sanitizeFilename(attachment.name),
				type: normalizeContentType(attachment.type) || "application/octet-stream",
				size: decrypted.bytes.byteLength,
				kind: attachment.kind,
				durationMs: Number(attachment.durationMs || 0),
			},
		skipReason: null,
	};
}

export async function deleteImportedTelegramAttachment(env, attachment) {
	if (!attachment?.key || !hasFileStorage(env)) return;
	try {
		await deleteStoredFile(env, attachment.key);
	} catch (error) {
		console.warn(JSON.stringify({
			message: "telegram orphan attachment delete failed",
			objectKey: attachment.key,
			error: error instanceof Error ? error.message : String(error),
		}));
	}
}
