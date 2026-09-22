function exifOrientation(bytes: Uint8Array, start: number, end: number) {
	const tiff = start + 6;
	if (
		start + 6 > end ||
		bytes[start] !== 69 ||
		bytes[start + 1] !== 120 ||
		bytes[start + 2] !== 105 ||
		bytes[start + 3] !== 102 ||
		bytes[start + 4] !== 0 ||
		bytes[start + 5] !== 0 ||
		tiff + 8 > end
	) {
		return 1;
	}
	const little = bytes[tiff] === 73 && bytes[tiff + 1] === 73;
	const big = bytes[tiff] === 77 && bytes[tiff + 1] === 77;
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
			view.getUint16(entry, little) === 274 &&
			view.getUint16(entry + 2, little) === 3 &&
			view.getUint32(entry + 4, little) === 1
		) {
			const orientation = view.getUint16(entry + 8, little);
			return orientation >= 1 && orientation <= 8 ? orientation : 1;
		}
	}
	return 1;
}

async function jpegOrientation(blob: Blob) {
	if (blob.type !== "image/jpeg") return 1;
	const bytes = new Uint8Array(
		await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer(),
	);
	if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return 1;
	let cursor = 2;
	while (cursor + 4 <= bytes.length) {
		if (bytes[cursor] !== 255) return 1;
		while (bytes[cursor] === 255) cursor++;
		const marker = bytes[cursor++];
		if (marker === 218 || marker === 217 || marker === undefined) break;
		if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
		if (cursor + 2 > bytes.length) break;
		const length = (bytes[cursor] << 8) | bytes[cursor + 1];
		if (length < 2 || cursor + length > bytes.length) break;
		if (marker === 225) {
			const orientation = exifOrientation(bytes, cursor + 2, cursor + length);
			if (orientation !== 1) return orientation;
		}
		cursor += length;
	}
	return 1;
}

export async function restoreRawJpegOrientation(
	bitmap: ImageBitmap,
	blob: Blob,
) {
	const orientation = await jpegOrientation(blob);
	if (orientation === 1) return bitmap;
	const swapped = orientation >= 5;
	const width = swapped ? bitmap.height : bitmap.width;
	const height = swapped ? bitmap.width : bitmap.height;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Editor background orientation is unavailable");
	switch (orientation) {
		case 2:
			context.setTransform(-1, 0, 0, 1, width, 0);
			break;
		case 3:
			context.setTransform(-1, 0, 0, -1, width, height);
			break;
		case 4:
			context.setTransform(1, 0, 0, -1, 0, height);
			break;
		case 5:
			context.setTransform(0, 1, 1, 0, 0, 0);
			break;
		case 6:
			context.setTransform(0, -1, 1, 0, 0, height);
			break;
		case 7:
			context.setTransform(0, -1, -1, 0, width, height);
			break;
		case 8:
			context.setTransform(0, 1, -1, 0, width, 0);
			break;
	}
	context.drawImage(bitmap, 0, 0);
	const raw = await createImageBitmap(canvas);
	bitmap.close();
	return raw;
}
