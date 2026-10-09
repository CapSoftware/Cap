import type { AudioSample, AudioSampleSink, Input } from "mediabunny";
import type { ExportAudioResampler } from "../renderer/pkg-export/cap_editor_browser_renderer.js";

export const SAMPLE_RATE = 48_000;
// Matches `BLOCK_FRAMES` in the renderer's export_audio.rs.
export const BLOCK_FRAMES = 10 * SAMPLE_RATE;
// A resampled track seeks this far before the block it wants, so the
// resampler's first outputs (whose filter reaches back before where decoding
// starts) and the decoder's warm-up both land before that block.
const RESAMPLE_PREROLL_SECONDS = 0.1;

export type Audio = {
	input: Pick<Input, "dispose">;
	sink: Pick<AudioSampleSink, "samples">;
	sampleRate: number;
	channels: number;
	first: number;
};

export type Resampler = Pick<
	ExportAudioResampler,
	"position" | "push" | "finish" | "free"
>;

export type ResamplerFactory = (
	channels: number,
	sampleRate: number,
	start: number,
) => Resampler;

/// Interleaved 48 kHz frames starting at track frame `frame`.
type Piece = { frame: number; data: Float32Array };
type Pieces = AsyncGenerator<Piece, void, unknown>;

export function interleave(sample: AudioSample, channels: number) {
	const frames = sample.numberOfFrames;
	const interleaved = new Float32Array(frames * channels);
	const plane = new Float32Array(frames);
	for (let channel = 0; channel < channels; channel++) {
		sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
		for (let frame = 0; frame < frames; frame++) {
			interleaved[frame * channels + channel] = plane[frame] ?? 0;
		}
	}
	return interleaved;
}

async function* nativePieces(audio: Audio, start: number): Pieces {
	for await (const sample of audio.sink.samples(
		audio.first + start / SAMPLE_RATE,
	)) {
		let piece: Piece;
		try {
			piece = {
				frame: Math.round((sample.timestamp - audio.first) * SAMPLE_RATE),
				data: interleave(sample, audio.channels),
			};
		} finally {
			sample.close();
		}
		yield piece;
	}
}

/// Decoded audio at the track's own rate, placed by timestamp (gaps filled
/// with silence, overlaps dropped) and resampled to 48 kHz as it arrives.
async function* resampledPieces(
	audio: Audio,
	createResampler: ResamplerFactory,
	start: number,
): Pieces {
	const { channels, sampleRate } = audio;
	const seek = Math.max(0, start / SAMPLE_RATE - RESAMPLE_PREROLL_SECONDS);
	let resampler: Resampler | null = null;
	let received = 0;
	try {
		const push = (data: Float32Array): Piece => {
			const active = resampler as Resampler;
			const frame = active.position();
			received += data.length / channels;
			return { frame, data: active.push(data) };
		};
		for await (const sample of audio.sink.samples(audio.first + seek)) {
			let at: number;
			let data: Float32Array;
			try {
				at = Math.max(
					0,
					Math.round((sample.timestamp - audio.first) * sampleRate),
				);
				data = interleave(sample, channels);
			} finally {
				sample.close();
			}
			if (!resampler) {
				resampler = createResampler(channels, sampleRate, at);
				received = at;
			}
			while (at > received) {
				const silence = Math.min(at - received, sampleRate);
				yield push(new Float32Array(silence * channels));
			}
			if (at < received) {
				data = data.subarray(
					Math.min(received - at, data.length / channels) * channels,
				);
			}
			if (data.length > 0) yield push(data);
		}
		if (resampler) {
			yield { frame: resampler.position(), data: resampler.finish() };
		}
	} finally {
		(resampler as Resampler | null)?.free();
	}
}

/// Decodes a track in `BLOCK_FRAMES` blocks of 48 kHz audio as the mixer asks
/// for them, resampling as it goes when the track has another rate. Reading
/// on from the previous block continues the same decoder, so an unedited
/// timeline decodes each track once, front to back.
export class BlockDecoder {
	private iterator: Pieces | null = null;
	private from = 0;
	private position = 0;
	private readonly partial = new Map<number, Float32Array>();
	private readonly pieces: (start: number) => Pieces;

	constructor(
		readonly audio: Audio,
		createResampler: ResamplerFactory,
	) {
		this.pieces =
			audio.sampleRate === SAMPLE_RATE
				? (start) => nativePieces(audio, start)
				: (start) => resampledPieces(audio, createResampler, start);
	}

	/// Blocks decoded but not yet handed over.
	get held() {
		return this.partial.size;
	}

	/// Block `index`, and the track's length in frames once decoding reaches
	/// its end.
	async block(index: number) {
		const start = index * BLOCK_FRAMES;
		const continues =
			this.iterator !== null &&
			this.from <= start &&
			start - this.position <= BLOCK_FRAMES &&
			(this.position <= start || this.partial.has(index));
		if (!continues) {
			await this.iterator?.return();
			this.partial.clear();
			this.iterator = this.pieces(start);
			this.from = start;
			this.position = start;
		}
		const iterator = this.iterator as Pieces;
		let end: number | null = null;
		while (this.position < start + BLOCK_FRAMES) {
			const next = await iterator.next();
			if (next.done) {
				end = this.position;
				break;
			}
			const { frame, data } = next.value;
			this.write(frame, data, index);
			this.position = Math.max(
				this.position,
				frame + data.length / this.audio.channels,
			);
		}
		const samples =
			this.partial.get(index) ??
			new Float32Array(BLOCK_FRAMES * this.audio.channels);
		for (const block of this.partial.keys()) {
			if (block <= index) this.partial.delete(block);
		}
		return { samples, end };
	}

	private write(frame: number, data: Float32Array, from: number) {
		const channels = this.audio.channels;
		const last = frame + data.length / channels;
		for (let at = Math.max(frame, from * BLOCK_FRAMES); at < last; ) {
			const block = Math.floor(at / BLOCK_FRAMES);
			const count = Math.min(last, (block + 1) * BLOCK_FRAMES) - at;
			let buffer = this.partial.get(block);
			if (!buffer) {
				buffer = new Float32Array(BLOCK_FRAMES * channels);
				this.partial.set(block, buffer);
			}
			buffer.set(
				data.subarray((at - frame) * channels, (at - frame + count) * channels),
				(at - block * BLOCK_FRAMES) * channels,
			);
			at += count;
		}
	}

	async dispose() {
		await this.iterator?.return();
		this.audio.input.dispose();
	}
}
