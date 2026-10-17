export const IMAGE_UPLOAD_TARGET_BYTES = 1200 * 1024;
export const IMAGE_UPLOAD_MAX_DIMENSION = 1920;

function outputName(name) {
	const stem = String(name || 'image').replace(/\.[^.]+$/, '') || 'image';
	return `${stem}.webp`;
}

function canvasBlob(canvas, type, quality) {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => blob ? resolve(blob) : reject(new Error('图片压缩失败，请换一张图片重试')),
			type,
			quality,
		);
	});
}

export function compressImageForUpload(file, {
	targetBytes = IMAGE_UPLOAD_TARGET_BYTES,
	maxDimension = IMAGE_UPLOAD_MAX_DIMENSION,
} = {}) {
	if (!String(file?.type || '').startsWith('image/') || file.type === 'image/svg+xml') return file;
	if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
	return compressSupportedImage(file, { targetBytes, maxDimension });
}

async function compressSupportedImage(file, { targetBytes, maxDimension }) {
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	try {
		const largest = Math.max(bitmap.width, bitmap.height);
		if (file.size <= targetBytes && largest <= maxDimension) return file;

		let scale = Math.min(1, maxDimension / largest);
		let quality = 0.84;
		let best = null;
		for (let attempt = 0; attempt < 7; attempt += 1) {
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext('2d', { alpha: true });
			if (!context) throw new Error('图片压缩失败，请换一张图片重试');
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await canvasBlob(canvas, 'image/webp', quality);
			if (!best || blob.size < best.size) best = blob;
			if (blob.size <= targetBytes) {
				return new File([blob], outputName(file.name), {
					type: 'image/webp',
					lastModified: Date.now(),
				});
			}
			if (quality > 0.62) quality -= 0.1;
			else {
				scale *= 0.8;
				quality = 0.76;
			}
		}
		if (best?.size <= targetBytes) {
			return new File([best], outputName(file.name), { type: 'image/webp', lastModified: Date.now() });
		}
		throw new Error('图片压缩后仍然过大，请换一张图片重试');
	} finally {
		bitmap.close?.();
	}
}
