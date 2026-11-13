const ascii = (bytes: Uint8Array, offset: number, text: string) => {
	if (bytes.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (bytes[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
	bytes.length >= signature.length &&
	signature.every((value, index) => bytes[index] === value);

const ISO_BOX_TYPES = ["ftyp", "moov", "mdat", "wide", "free", "skip"];
const WAVE64_RIFF_GUID = [
	0x72, 0x69, 0x66, 0x66, 0x2e, 0x91, 0xcf, 0x11, 0xa5, 0xd6, 0x28, 0xdb, 0x04,
	0xc1, 0x00, 0x00,
];
const TS_PACKET_BYTES = 188;
const M2TS_PACKET_BYTES = 192;
const M2TS_SYNC_OFFSET = 4;

export const MEDIA_CONTAINER_SNIFF_BYTES = 4096;

const ID3_HEADER_BYTES = 10;
const ID3_FOOTER_FLAG = 0x10;
const MAX_ID3_TAGS = 4;
const MIN_BYTES_AFTER_ID3 = 512;

function id3TagBytes(bytes: Uint8Array, offset: number) {
	if (
		bytes.length < offset + ID3_HEADER_BYTES ||
		!ascii(bytes, offset, "ID3") ||
		bytes[offset + 3] === 0xff ||
		bytes[offset + 4] === 0xff
	) {
		return null;
	}
	let size = 0;
	for (let index = offset + 6; index < offset + ID3_HEADER_BYTES; index++) {
		const value = bytes[index] ?? 0;
		if (value & 0x80) return null;
		size = size * 128 + value;
	}
	const footer =
		(bytes[offset + 5] ?? 0) & ID3_FOOTER_FLAG ? ID3_HEADER_BYTES : 0;
	return ID3_HEADER_BYTES + size + footer;
}

function id3TagsEnd(bytes: Uint8Array) {
	let end = 0;
	for (let tags = 0; tags < MAX_ID3_TAGS && end < bytes.length; tags++) {
		const tagBytes = id3TagBytes(bytes, end);
		if (tagBytes === null) break;
		end += tagBytes;
	}
	return end;
}

export function isSelfContainedMedia(bytes: Uint8Array) {
	if (bytes.length < 4) return false;
	const tagsEnd = id3TagsEnd(bytes);
	if (tagsEnd > 0) {
		return (
			tagsEnd >= bytes.length || !looksLikePlaylist(bytes.subarray(tagsEnd))
		);
	}
	if (ISO_BOX_TYPES.some((type) => ascii(bytes, 4, type))) return true;
	if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return true;
	if (ascii(bytes, 0, "RIFF")) {
		return ascii(bytes, 8, "WAVE") || ascii(bytes, 8, "AVI ");
	}
	if (ascii(bytes, 0, "FORM")) {
		return ascii(bytes, 8, "AIFF") || ascii(bytes, 8, "AIFC");
	}
	if (ascii(bytes, 0, "OggS")) return true;
	if (ascii(bytes, 0, "fLaC")) return true;
	if (ascii(bytes, 0, "caff")) return true;
	if (ascii(bytes, 0, "FLV")) return true;
	if (ascii(bytes, 0, "#!AMR")) return true;
	if (ascii(bytes, 0, "ID3")) return true;
	if (startsWith(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) {
		return true;
	}
	if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return true;
	if (
		bytes[0] === 0x47 &&
		bytes.length > TS_PACKET_BYTES &&
		bytes[TS_PACKET_BYTES] === 0x47
	) {
		return true;
	}
	if (
		bytes.length > M2TS_PACKET_BYTES + M2TS_SYNC_OFFSET &&
		bytes[M2TS_SYNC_OFFSET] === 0x47 &&
		bytes[M2TS_PACKET_BYTES + M2TS_SYNC_OFFSET] === 0x47
	) {
		return true;
	}
	if (startsWith(bytes, [0x00, 0x00, 0x01, 0xba])) return true;
	if (startsWith(bytes, WAVE64_RIFF_GUID)) return true;
	return false;
}

const SNIFF_TIMEOUT_MS = 30_000;

const PLAYLIST_MARKERS = [
	"#extm3u",
	"#ext-x-",
	"<?xml",
	"<mpd",
	"<smil",
	"<asx",
	"ffconcat version",
	"[playlist]",
	"v=0\n",
	"v=0\r",
	"http://",
	"https://",
];
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const PLAYLIST_MARKER_BYTES = 64;

export function looksLikePlaylist(bytes: Uint8Array): boolean {
	const tagsEnd = id3TagsEnd(bytes);
	if (tagsEnd > 0) {
		return tagsEnd < bytes.length && looksLikePlaylist(bytes.subarray(tagsEnd));
	}
	let start = startsWith(bytes, UTF8_BOM) ? UTF8_BOM.length : 0;
	while (
		start < bytes.length &&
		(bytes[start] === 0x20 ||
			bytes[start] === 0x09 ||
			bytes[start] === 0x0a ||
			bytes[start] === 0x0d)
	) {
		start++;
	}
	let text = "";
	const end = Math.min(bytes.length, start + PLAYLIST_MARKER_BYTES);
	for (let index = start; index < end; index++) {
		text += String.fromCharCode(bytes[index] ?? 0);
	}
	const lowered = text.toLowerCase();
	return PLAYLIST_MARKERS.some((marker) => lowered.startsWith(marker));
}

export type MediaSniff = "media" | "playlist" | "unknown";

export function sniffMedia(bytes: Uint8Array): MediaSniff {
	if (isSelfContainedMedia(bytes)) return "media";
	return looksLikePlaylist(bytes) ? "playlist" : "unknown";
}

export async function urlIsSelfContainedMedia(url: string) {
	return (await sniffMediaUrl(url)) === "media";
}

async function readSniffWindow(
	url: string,
	start: number,
	signal: AbortSignal,
) {
	const response = await fetch(url, {
		headers: {
			Range: `bytes=${start}-${start + MEDIA_CONTAINER_SNIFF_BYTES - 1}`,
		},
		signal,
	});
	if (start > 0 && (response.status === 200 || response.status === 416)) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Could not read the stored file (${response.status})`);
	}
	const reader = response.body.getReader();
	const window = new Uint8Array(MEDIA_CONTAINER_SNIFF_BYTES);
	let filled = 0;
	try {
		while (filled < window.length) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.length, window.length - filled);
			window.set(value.subarray(0, take), filled);
			filled += take;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return window.subarray(0, filled);
}

export async function sniffMediaUrl(
	url: string,
	timeoutMs: number = SNIFF_TIMEOUT_MS,
): Promise<MediaSniff> {
	const signal = AbortSignal.timeout(timeoutMs);
	let start = 0;
	let skippedTag = false;
	let window = await readSniffWindow(url, start, signal);
	for (let reads = 1; window && reads < MAX_ID3_TAGS; reads++) {
		const tagsEnd = id3TagsEnd(window);
		if (
			tagsEnd === 0 ||
			window.length < MEDIA_CONTAINER_SNIFF_BYTES ||
			window.length - tagsEnd >= MIN_BYTES_AFTER_ID3
		) {
			break;
		}
		start += tagsEnd;
		skippedTag = true;
		window = await readSniffWindow(url, start, signal);
	}
	if (!window) return "media";
	const found = sniffMedia(window);
	return skippedTag && found === "unknown" ? "media" : found;
}
