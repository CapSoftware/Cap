export const MEETING_CLIP_SAMPLE_RATE = 16_000;
export const MEETING_CLIP_MAX_SECONDS = 120;
export const MEETING_CLIP_MAX_BYTES = 4_000_000;
export const MEETING_CLIP_MIN_MS = 100;
export const MEETING_CLIP_MIN_SAMPLES =
	(MEETING_CLIP_MIN_MS * MEETING_CLIP_SAMPLE_RATE) / 1000;

const BYTES_PER_SAMPLE = 2;
const PCM_FORMAT_TAG = 1;
const MAX_CHUNKS = 64;

export type WavClipError =
	| "not_riff_wave"
	| "riff_size_mismatch"
	| "malformed_chunk"
	| "missing_fmt"
	| "duplicate_fmt"
	| "unsupported_format"
	| "missing_data"
	| "data_not_last"
	| "truncated"
	| "partial_sample"
	| "clip_too_long"
	| "too_large";

export type WavClip =
	| {
			ok: true;
			samples: number;
			durationMs: number;
			dataOffset: number;
			dataBytes: number;
	  }
	| { ok: false; error: WavClipError };

const fourCc = (view: DataView, offset: number) =>
	String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);

export function parseWavClip(bytes: Uint8Array): WavClip {
	if (bytes.byteLength > MEETING_CLIP_MAX_BYTES)
		return { ok: false, error: "too_large" };
	if (bytes.byteLength < 12) return { ok: false, error: "not_riff_wave" };

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (fourCc(view, 0) !== "RIFF" || fourCc(view, 8) !== "WAVE")
		return { ok: false, error: "not_riff_wave" };
	if (view.getUint32(4, true) + 8 !== bytes.byteLength)
		return { ok: false, error: "riff_size_mismatch" };

	let offset = 12;
	let sawFmt = false;
	for (let index = 0; index < MAX_CHUNKS; index++) {
		if (offset + 8 > bytes.byteLength)
			return { ok: false, error: sawFmt ? "missing_data" : "missing_fmt" };

		const id = fourCc(view, offset);
		const size = view.getUint32(offset + 4, true);
		const bodyOffset = offset + 8;

		if (id === "data") {
			if (!sawFmt) return { ok: false, error: "missing_fmt" };
			if (bodyOffset + size > bytes.byteLength)
				return { ok: false, error: "truncated" };
			if (bodyOffset + size !== bytes.byteLength)
				return { ok: false, error: "data_not_last" };
			if (size % BYTES_PER_SAMPLE !== 0)
				return { ok: false, error: "partial_sample" };

			const samples = size / BYTES_PER_SAMPLE;
			if (samples > MEETING_CLIP_MAX_SECONDS * MEETING_CLIP_SAMPLE_RATE)
				return { ok: false, error: "clip_too_long" };

			return {
				ok: true,
				samples,
				durationMs: Math.round((samples * 1000) / MEETING_CLIP_SAMPLE_RATE),
				dataOffset: bodyOffset,
				dataBytes: size,
			};
		}

		const paddedEnd = bodyOffset + size + (size % 2);
		if (paddedEnd > bytes.byteLength) return { ok: false, error: "truncated" };

		if (id === "fmt ") {
			if (sawFmt) return { ok: false, error: "duplicate_fmt" };
			if (size !== 16 && size !== 18)
				return { ok: false, error: "unsupported_format" };
			if (size === 18 && view.getUint16(bodyOffset + 16, true) !== 0)
				return { ok: false, error: "unsupported_format" };

			const formatTag = view.getUint16(bodyOffset, true);
			const channels = view.getUint16(bodyOffset + 2, true);
			const sampleRate = view.getUint32(bodyOffset + 4, true);
			const byteRate = view.getUint32(bodyOffset + 8, true);
			const blockAlign = view.getUint16(bodyOffset + 12, true);
			const bitsPerSample = view.getUint16(bodyOffset + 14, true);
			if (
				formatTag !== PCM_FORMAT_TAG ||
				channels !== 1 ||
				sampleRate !== MEETING_CLIP_SAMPLE_RATE ||
				bitsPerSample !== BYTES_PER_SAMPLE * 8 ||
				blockAlign !== BYTES_PER_SAMPLE ||
				byteRate !== MEETING_CLIP_SAMPLE_RATE * BYTES_PER_SAMPLE
			)
				return { ok: false, error: "unsupported_format" };
			sawFmt = true;
		} else if (!/^[\x20-\x7e]{4}$/.test(id)) {
			return { ok: false, error: "malformed_chunk" };
		}

		offset = paddedEnd;
	}

	return { ok: false, error: "malformed_chunk" };
}
