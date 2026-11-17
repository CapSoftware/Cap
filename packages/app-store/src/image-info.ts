export type ImageFormat = "png" | "jpeg" | "webp";

export type ImageInfo = {
	format: ImageFormat;
	width: number;
	height: number;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(bytes: Uint8Array): ImageInfo | null {
	if (bytes.length < 24) return null;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (bytes[i] !== PNG_SIGNATURE[i]) return null;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunkType = String.fromCharCode(...bytes.subarray(12, 16));
	if (chunkType !== "IHDR") return null;
	return {
		format: "png",
		width: view.getUint32(16),
		height: view.getUint32(20),
	};
}

const JPEG_SOF_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpeg(bytes: Uint8Array): ImageInfo | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 2;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) return null;
		const marker = bytes[offset + 1] ?? 0;
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		const length = view.getUint16(offset + 2);
		if (length < 2) return null;
		if (JPEG_SOF_MARKERS.has(marker)) {
			if (offset + 9 > bytes.length) return null;
			return {
				format: "jpeg",
				height: view.getUint16(offset + 5),
				width: view.getUint16(offset + 7),
			};
		}
		offset += 2 + length;
	}
	return null;
}

function readWebp(bytes: Uint8Array): ImageInfo | null {
	if (bytes.length < 30) return null;
	const riff = String.fromCharCode(...bytes.subarray(0, 4));
	const webp = String.fromCharCode(...bytes.subarray(8, 12));
	if (riff !== "RIFF" || webp !== "WEBP") return null;
	const chunk = String.fromCharCode(...bytes.subarray(12, 16));
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (chunk === "VP8X") {
		const width =
			1 +
			((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
		const height =
			1 +
			((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
		return { format: "webp", width, height };
	}
	if (chunk === "VP8 ") {
		return {
			format: "webp",
			width: view.getUint16(26, true) & 0x3fff,
			height: view.getUint16(28, true) & 0x3fff,
		};
	}
	if (chunk === "VP8L") {
		const b0 = bytes[21] ?? 0;
		const b1 = bytes[22] ?? 0;
		const b2 = bytes[23] ?? 0;
		const b3 = bytes[24] ?? 0;
		return {
			format: "webp",
			width: 1 + (((b1 & 0x3f) << 8) | b0),
			height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
		};
	}
	return null;
}

export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
	return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

export const formatForPath = (path: string): ImageFormat | null => {
	const lower = path.toLowerCase();
	if (lower.endsWith(".png")) return "png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpeg";
	if (lower.endsWith(".webp")) return "webp";
	return null;
};
