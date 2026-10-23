/**
 * Amplitude envelopes for the filmstrip's waveform overlay.
 *
 * Framework-free and deterministic: the same video always draws the same
 * shape, in every tab, on every render. The master resolution is fixed rather
 * than derived from the duration, so a three-hour recording costs exactly what
 * a thirty-second one does.
 */

/** Master envelope resolution. Fixed regardless of duration. */
export const WAVEFORM_BUCKETS = 2048;

/** Floor applied after normalisation, so silence still draws a thin line. */
export const WAVEFORM_FLOOR = 0.08;

export interface VttCue {
	start: number;
	end: number;
}

const CUE_LINE =
	/(\d{1,2}:)?(\d{1,2}):(\d{1,2})([.,]\d{1,3})?\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})([.,]\d{1,3})?/;

const toSeconds = (
	hours: string | undefined,
	minutes: string | undefined,
	seconds: string | undefined,
	fraction: string | undefined,
): number | null => {
	const h = hours ? Number.parseInt(hours, 10) : 0;
	const m = minutes ? Number.parseInt(minutes, 10) : Number.NaN;
	const s = seconds ? Number.parseInt(seconds, 10) : Number.NaN;
	if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s))
		return null;
	const ms = fraction ? Number.parseFloat(`0.${fraction.slice(1)}`) : 0;
	return h * 3600 + m * 60 + s + (Number.isFinite(ms) ? ms : 0);
};

/**
 * Cue time ranges only. `parseVTT` in `_components/utils/transcript-utils`
 * drops end times and milliseconds, which are exactly what an envelope needs.
 */
export function parseVttCues(vtt: string): VttCue[] {
	if (typeof vtt !== "string" || !vtt.includes("-->")) return [];

	const cues: VttCue[] = [];
	for (const line of vtt.split("\n")) {
		if (!line.includes("-->")) continue;
		const match = CUE_LINE.exec(line);
		if (!match) continue;

		const start = toSeconds(
			match[1]?.slice(0, -1),
			match[2],
			match[3],
			match[4],
		);
		const end = toSeconds(match[5]?.slice(0, -1), match[6], match[7], match[8]);
		if (start === null || end === null) continue;
		if (end <= start) continue;
		cues.push({ start, end });
	}
	return cues;
}

/** FNV-1a, the same hash the voice-note waveform uses. */
const hashString = (value: string): number => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash || 0x9e3779b9;
};

/** Stable 0-1 noise for one bucket, so covered spans look like audio. */
const bucketNoise = (index: number, salt: number): number => {
	let state = (Math.imul(index + 1, 0x9e3779b1) ^ salt) >>> 0;
	state ^= state >>> 15;
	state = Math.imul(state, 0x85ebca6b) >>> 0;
	state ^= state >>> 13;
	state = Math.imul(state, 0xc2b2ae35) >>> 0;
	state ^= state >>> 16;
	return state / 0xffffffff;
};

const smooth = (values: Float32Array, radius: number): Float32Array => {
	if (radius <= 0) return values;
	const length = values.length;
	const prefix = new Float64Array(length + 1);
	for (let index = 0; index < length; index += 1) {
		prefix[index + 1] = (prefix[index] ?? 0) + (values[index] ?? 0);
	}

	const out = new Float32Array(length);
	for (let index = 0; index < length; index += 1) {
		const from = Math.max(0, index - radius);
		const to = Math.min(length - 1, index + radius);
		out[index] =
			((prefix[to + 1] ?? 0) - (prefix[from] ?? 0)) / (to - from + 1);
	}
	return out;
};

/** Scale into 0-1 and lift onto the floor. */
const normalize = (values: Float32Array): Float32Array => {
	let max = 0;
	for (const value of values) if (value > max) max = value;
	const out = new Float32Array(values.length);
	for (let index = 0; index < values.length; index += 1) {
		const scaled = max > 0 ? (values[index] ?? 0) / max : 0;
		out[index] = WAVEFORM_FLOOR + (1 - WAVEFORM_FLOOR) * scaled;
	}
	return out;
};

/**
 * Speech coverage from a transcript, roughened into something that reads as
 * audio: cue ranges mark which buckets carry voice, per-bucket noise gives the
 * covered spans texture instead of solid blocks, and a short moving average
 * rounds the edges off.
 */
export function envelopeFromVtt(
	vtt: string,
	duration: number,
	buckets: number = WAVEFORM_BUCKETS,
): Float32Array {
	const count =
		Number.isFinite(buckets) && buckets > 0 ? Math.floor(buckets) : 0;
	if (count <= 0) return new Float32Array(0);
	if (!Number.isFinite(duration) || duration <= 0)
		return normalize(new Float32Array(count));

	const raw = new Float32Array(count);
	const salt = hashString(`vtt:${count}`);

	for (const cue of parseVttCues(vtt)) {
		const from = Math.max(0, Math.floor((cue.start / duration) * count));
		const to = Math.min(count - 1, Math.ceil((cue.end / duration) * count));
		for (let index = from; index <= to; index += 1) {
			const noise = bucketNoise(index, salt);
			const detail = (Math.sin(index * 0.7) + 1) / 2;
			raw[index] = Math.max(
				raw[index] ?? 0,
				0.5 + 0.32 * noise + 0.18 * detail,
			);
		}
	}

	return normalize(smooth(raw, 2));
}

/**
 * Seeded stand-in for videos with no transcript. Value noise smoothed into
 * phrases, in the same visual family as the voice-note `pseudoWaveform`: two
 * out-of-phase sines for the body, a noise stream for grain.
 */
export function pseudoEnvelope(
	seed: string,
	duration: number,
	buckets: number = WAVEFORM_BUCKETS,
): Float32Array {
	const count =
		Number.isFinite(buckets) && buckets > 0 ? Math.floor(buckets) : 0;
	if (count <= 0) return new Float32Array(0);

	const hash = hashString(seed);
	const phase = ((hash % 1000) / 1000) * Math.PI * 2;
	const phrases = Math.min(
		90,
		Math.max(6, Math.round((Number.isFinite(duration) ? duration : 60) / 6)),
	);

	const raw = new Float32Array(count);
	for (let index = 0; index < count; index += 1) {
		const t = count === 1 ? 0.5 : index / (count - 1);
		const body = (Math.sin(phase + t * Math.PI * 2 * phrases) + 1) / 2;
		const swell = (Math.sin(phase * 0.7 + t * Math.PI * 2) + 1) / 2;
		const noise = bucketNoise(index, hash);
		const taper = 0.7 + 0.3 * Math.sin(Math.PI * t);
		raw[index] = (0.42 * body + 0.3 * swell + 0.28 * noise) * taper;
	}

	return normalize(smooth(raw, 3));
}
