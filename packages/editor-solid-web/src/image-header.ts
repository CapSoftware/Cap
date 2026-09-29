export type ImageHeader = {
	width: number;
	height: number;
	orientation: number;
};

function exifOrientation(bytes: Uint8Array, start: number, end: number) {
	const tiff = start + 6;
	if (
		tiff + 8 > end ||
		bytes[start] !== 0x45 ||
		bytes[start + 1] !== 0x78 ||
		bytes[start + 2] !== 0x69 ||
		bytes[start + 3] !== 0x66 ||
		bytes[start + 4] !== 0 ||
		bytes[start + 5] !== 0
	) {
		return 1;
	}
	const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
	const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
	if (!little && !big) return 1;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint16(tiff + 2, little) !== 42) return 1;
	const directory = tiff + view.getUint32(tiff + 4, little);
	if (directory < tiff + 8 || directory + 2 > end) return 1;
	const count = view.getUint16(directory, little);
	for (let index = 0; index < count; index++) {
		const entry = directory + 2 + index * 12;
		if (entry + 12 > end) break;
		if (
			view.getUint16(entry, little) === 0x0112 &&
			view.getUint16(entry + 2, little) === 3 &&
			view.getUint32(entry + 4, little) === 1
		) {
			const orientation = view.getUint16(entry + 8, little);
			return orientation >= 1 && orientation <= 8 ? orientation : 1;
		}
	}
	return 1;
}

function isStartOfFrame(marker: number) {
	return (
		marker >= 0xc0 &&
		marker <= 0xcf &&
		marker !== 0xc4 &&
		marker !== 0xc8 &&
		marker !== 0xcc
	);
}

function jpegHeader(bytes: Uint8Array): ImageHeader | null {
	let orientation = 1;
	let cursor = 2;
	while (cursor + 4 <= bytes.length) {
		if (bytes[cursor] !== 0xff) return null;
		while (bytes[cursor] === 0xff) cursor++;
		const marker = bytes[cursor++];
		if (marker === undefined || marker === 0xda || marker === 0xd9) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (cursor + 2 > bytes.length) break;
		const length = ((bytes[cursor] ?? 0) << 8) | (bytes[cursor + 1] ?? 0);
		if (length < 2 || cursor + length > bytes.length) break;
		if (marker === 0xe1 && orientation === 1) {
			orientation = exifOrientation(bytes, cursor + 2, cursor + length);
		} else if (isStartOfFrame(marker) && length >= 7) {
			const height = ((bytes[cursor + 3] ?? 0) << 8) | (bytes[cursor + 4] ?? 0);
			const width = ((bytes[cursor + 5] ?? 0) << 8) | (bytes[cursor + 6] ?? 0);
			return width > 0 && height > 0 ? { width, height, orientation } : null;
		}
		cursor += length;
	}
	return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngHeader(bytes: Uint8Array): ImageHeader | null {
	if (
		bytes.length < 24 ||
		bytes[12] !== 0x49 ||
		bytes[13] !== 0x48 ||
		bytes[14] !== 0x44 ||
		bytes[15] !== 0x52
	) {
		return null;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	return width > 0 && height > 0 ? { width, height, orientation: 1 } : null;
}

/// Size and EXIF orientation of a PNG or JPEG from its header, or null for
/// other formats and headers that cannot be read.
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		return jpegHeader(bytes);
	}
	if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
		return pngHeader(bytes);
	}
	return null;
}
