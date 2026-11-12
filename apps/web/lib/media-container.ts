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
	return false;
}
