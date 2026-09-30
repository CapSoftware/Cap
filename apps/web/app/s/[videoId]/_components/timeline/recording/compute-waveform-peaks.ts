export const WAVEFORM_PEAK_COUNT = 64;

/**
 * Accumulates loudness samples while a voice note records, so the waveform the
 * comment ships with is the same one the recorder showed live — no post-hoc
 * decode of a potentially long file on the send path.
 */
export class LivePeaksAccumulator {
	private samples: number[] = [];

	/** Push one RMS/level sample in 0..1 (call every ~60ms from the meter). */
	push(level: number) {
		this.samples.push(
			Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0,
		);
	}

	get isEmpty() {
		return this.samples.length === 0;
	}

	/** Max-resample the run into `count` peaks, normalized so speech fills 0..1. */
	finish(count = WAVEFORM_PEAK_COUNT): number[] | undefined {
		if (this.samples.length === 0) return undefined;
		const out: number[] = new Array(count);
		for (let index = 0; index < count; index += 1) {
			const start = Math.floor((index * this.samples.length) / count);
			const end = Math.max(
				start + 1,
				Math.floor(((index + 1) * this.samples.length) / count),
			);
			let peak = 0;
			for (let source = start; source < end; source += 1) {
				const value = this.samples[source] ?? 0;
				if (value > peak) peak = value;
			}
			out[index] = peak;
		}
		// Quiet mics still deserve a visible waveform: scale the loudest peak to
		// full height, floors at a 0.1 gate so silence stays flat.
		const max = Math.max(...out);
		if (max > 0.1 && max < 1) {
			for (let index = 0; index < out.length; index += 1) {
				const value = out[index] ?? 0;
				out[index] = Math.min(1, value / max);
			}
		}
		return out.map((value) => Math.round(value * 100) / 100);
	}
}

/**
 * Fallback when the live meter produced nothing (e.g. the AudioContext failed
 * to start): decode the finished blob and extract peaks offline.
 */
export async function decodeToPeaks(
	blob: Blob,
	count = WAVEFORM_PEAK_COUNT,
): Promise<number[] | undefined> {
	try {
		const arrayBuffer = await blob.arrayBuffer();
		const context = new OfflineAudioContext(1, 1, 44100);
		const decoded = await context.decodeAudioData(arrayBuffer);
		const channel = decoded.getChannelData(0);
		if (channel.length === 0) return undefined;

		const accumulator = new LivePeaksAccumulator();
		const bucket = Math.max(1, Math.floor(channel.length / (count * 4)));
		for (let start = 0; start < channel.length; start += bucket) {
			let sum = 0;
			const end = Math.min(channel.length, start + bucket);
			for (let index = start; index < end; index += 1) {
				const sample = channel[index] ?? 0;
				sum += sample * sample;
			}
			accumulator.push(Math.sqrt(sum / (end - start)) * 3);
		}
		return accumulator.finish(count);
	} catch {
		return undefined;
	}
}
