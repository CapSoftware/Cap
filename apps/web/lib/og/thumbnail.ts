// Satori has no working `background-size: cover` (non-matching aspect ratios
// leave gaps and remote URLs can render blank), so the thumbnail is loaded
// here, measured from its header, and drawn at an explicit cover size.

export type ImageSize = { width: number; height: number };

export type OgThumbnail = ImageSize & { src: string };

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 12 * 1024 * 1024;

const pngSize = (buf: Buffer): ImageSize | undefined => {
	if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return;
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

const gifSize = (buf: Buffer): ImageSize | undefined => {
	if (buf.length < 10 || buf.toString("ascii", 0, 3) !== "GIF") return;
	return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
};

const webpSize = (buf: Buffer): ImageSize | undefined => {
	if (
		buf.length < 30 ||
		buf.toString("ascii", 0, 4) !== "RIFF" ||
		buf.toString("ascii", 8, 12) !== "WEBP"
	)
		return;
	const chunk = buf.toString("ascii", 12, 16);
	if (chunk === "VP8 ")
		return {
			width: buf.readUInt16LE(26) & 0x3fff,
			height: buf.readUInt16LE(28) & 0x3fff,
		};
	if (chunk === "VP8L") {
		const bits = buf.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (chunk === "VP8X")
		return {
			width: buf.readUIntLE(24, 3) + 1,
			height: buf.readUIntLE(27, 3) + 1,
		};
};

const jpegSize = (buf: Buffer): ImageSize | undefined => {
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return;
	let offset = 2;
	while (offset + 9 < buf.length) {
		if (buf[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = buf[offset + 1] ?? 0;
		if (marker === 0xff) {
			offset++;
			continue;
		}
		const isStartOfFrame =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (isStartOfFrame)
			return {
				height: buf.readUInt16BE(offset + 5),
				width: buf.readUInt16BE(offset + 7),
			};
		offset += 2 + buf.readUInt16BE(offset + 2);
	}
};

export const imageSize = (buf: Buffer): ImageSize | undefined => {
	const size = pngSize(buf) ?? jpegSize(buf) ?? webpSize(buf) ?? gifSize(buf);
	if (!size || size.width <= 0 || size.height <= 0) return;
	return size;
};

const mimeType = (buf: Buffer) => {
	if (pngSize(buf)) return "image/png";
	if (webpSize(buf)) return "image/webp";
	if (gifSize(buf)) return "image/gif";
	return "image/jpeg";
};

const readSource = async (url: string): Promise<Buffer | undefined> => {
	if (url.startsWith("data:")) {
		const comma = url.indexOf(",");
		if (comma === -1 || !url.slice(0, comma).endsWith(";base64")) return;
		return Buffer.from(url.slice(comma + 1), "base64");
	}
	if (!/^https?:\/\//i.test(url)) return;
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) return;
	const length = Number(res.headers.get("content-length") ?? 0);
	if (length > MAX_BYTES) return;
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_BYTES) return;
	return buf;
};

export const loadOgThumbnail = async (
	url: string,
): Promise<OgThumbnail | undefined> => {
	try {
		const buf = await readSource(url);
		if (!buf) return;
		const size = imageSize(buf);
		if (!size) return;
		return {
			...size,
			src: url.startsWith("data:")
				? url
				: `data:${mimeType(buf)};base64,${buf.toString("base64")}`,
		};
	} catch {
		return;
	}
};

export const coverRect = (image: ImageSize, box: ImageSize) => {
	const scale = Math.max(box.width / image.width, box.height / image.height);
	const width = Math.ceil(image.width * scale);
	const height = Math.ceil(image.height * scale);
	return {
		width,
		height,
		left: Math.floor((box.width - width) / 2),
		top: Math.floor((box.height - height) / 2),
	};
};
