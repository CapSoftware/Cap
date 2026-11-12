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

export function isSelfContainedMedia(bytes: Uint8Array) {
	if (bytes.length < 4) return false;
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

export function looksLikePlaylist(bytes: Uint8Array) {
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

export async function sniffMediaUrl(
	url: string,
	timeoutMs: number = SNIFF_TIMEOUT_MS,
): Promise<MediaSniff> {
	const response = await fetch(url, {
		headers: { Range: `bytes=0-${MEDIA_CONTAINER_SNIFF_BYTES - 1}` },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok || !response.body) {
		throw new Error(`Could not read the stored file (${response.status})`);
	}
	const reader = response.body.getReader();
	const head = new Uint8Array(MEDIA_CONTAINER_SNIFF_BYTES);
	let filled = 0;
	try {
		while (filled < head.length) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.length, head.length - filled);
			head.set(value.subarray(0, take), filled);
			filled += take;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return sniffMedia(head.subarray(0, filled));
}
