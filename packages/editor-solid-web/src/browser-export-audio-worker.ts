// Decodes and mixes a local export's audio (including Studio Sound) off the
// video worker's thread, handing interleaved 48 kHz stereo chunks back on
// request so memory stays bounded.
import type { AudioSample, AudioSampleSink, Input } from "mediabunny";
import type { BrowserExportAudioTrack } from "./browser-export-audio";

type RendererModule =
	typeof import("../renderer/pkg-export/cap_editor_browser_renderer.js");

export type BrowserExportAudioRequest =
	| {
			kind: "start";
			config: Record<string, unknown>;
			outputSamples: number;
			tracks: BrowserExportAudioTrack[];
			musicUrls: Record<string, string>;
	  }
	| { kind: "pull"; chunks: number };

export type BrowserExportAudioReply =
	| { kind: "chunk"; samples: Float32Array; done: boolean }
	| { kind: "stats"; decodeMs: number; mixMs: number }
	| { kind: "error"; message: string };

const scope = self as unknown as {
	addEventListener: (
		type: "message",
		listener: (event: MessageEvent<BrowserExportAudioRequest>) => void,
	) => void;
	postMessage: (
		message: BrowserExportAudioReply,
		transfer?: Transferable[],
	) => void;
};

const CHUNK_FRAMES = 4_800;
const SAMPLE_RATE = 48_000;
// Matches `BLOCK_FRAMES` in the renderer's export_audio.rs.
const BLOCK_FRAMES = 10 * SAMPLE_RATE;

type Audio = {
	input: Input;
	sink: AudioSampleSink;
	sampleRate: number;
	channels: number;
	first: number;
};

async function openAudio(url: string): Promise<Audio | null> {
	const { ALL_FORMATS, AudioSampleSink, Input, UrlSource } = await import(
		"mediabunny"
	);
	const input = new Input({
		formats: ALL_FORMATS,
		source: new UrlSource(url, { maxCacheSize: 32 * 1024 * 1024 }),
	});
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			input.dispose();
			return null;
		}
		const [sampleRate, channels, first] = await Promise.all([
			track.getSampleRate(),
			track.getNumberOfChannels(),
			track.getFirstTimestamp(),
		]);
		return {
			input,
			sink: new AudioSampleSink(track),
			sampleRate,
			channels: Math.min(Math.max(channels, 1), 2),
			first: first ?? 0,
		};
	} catch (cause) {
		input.dispose();
		throw cause;
	}
}

function interleave(sample: AudioSample, channels: number) {
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

/// All of a track, for sources the mixer resamples as a whole.
async function decodeWhole(audio: Audio) {
	const chunks: Float32Array[] = [];
	let length = 0;
	for await (const sample of audio.sink.samples()) {
		try {
			const chunk = interleave(sample, audio.channels);
			chunks.push(chunk);
			length += chunk.length;
		} finally {
			sample.close();
		}
	}
	const samples = new Float32Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		samples.set(chunk, offset);
		offset += chunk.length;
	}
	return samples;
}

/// Decodes a 48 kHz track in `BLOCK_FRAMES` blocks as the mixer asks for
/// them. Reading on from the previous block continues the same decoder, so an
/// unedited timeline decodes each track once, front to back.
class BlockDecoder {
	private iterator: AsyncGenerator<AudioSample, void, unknown> | null = null;
	private from = 0;
	private position = 0;
	private readonly partial = new Map<number, Float32Array>();

	constructor(readonly audio: Audio) {}

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
			this.iterator = this.audio.sink.samples(
				this.audio.first + start / SAMPLE_RATE,
			);
			this.from = start;
			this.position = start;
		}
		const iterator = this.iterator as AsyncGenerator<AudioSample, void>;
		let end: number | null = null;
		while (this.position < start + BLOCK_FRAMES) {
			const next = await iterator.next();
			if (next.done) {
				end = this.position;
				break;
			}
			const sample = next.value;
			try {
				const frame = Math.round(
					(sample.timestamp - this.audio.first) * SAMPLE_RATE,
				);
				this.write(frame, interleave(sample, this.audio.channels), index);
				this.position = Math.max(this.position, frame + sample.numberOfFrames);
			} finally {
				sample.close();
			}
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

let mixer: InstanceType<RendererModule["BrowserExportAudio"]> | null = null;
const decoders = new Map<number, BlockDecoder>();
let remaining = 0;
let decodeMs = 0;
let mixMs = 0;

async function start(
	request: Extract<BrowserExportAudioRequest, { kind: "start" }>,
) {
	const started = performance.now();
	const module = await import(
		"../renderer/pkg-export/cap_editor_browser_renderer.js"
	);
	await module.default();
	const audio = new module.BrowserExportAudio(
		JSON.stringify(request.config),
		request.outputSamples,
	);
	mixer = audio;
	remaining = request.outputSamples;
	await Promise.all([
		...request.tracks.map(async (track) => {
			const source = await openAudio(track.url);
			if (!source) return;
			if (source.sampleRate === SAMPLE_RATE) {
				const duration = await source.input
					.getDurationFromMetadata()
					.catch(() => null);
				const id = audio.add_streamed_track(
					track.segment,
					track.microphone,
					source.channels,
					duration ? Math.round((duration - source.first) * SAMPLE_RATE) : 0,
					track.offsetSeconds,
				);
				decoders.set(id, new BlockDecoder(source));
				return;
			}
			try {
				audio.add_track(
					track.segment,
					track.microphone,
					source.channels,
					source.sampleRate,
					track.offsetSeconds,
					await decodeWhole(source),
				);
			} finally {
				source.input.dispose();
			}
		}),
		...Object.entries(request.musicUrls).map(async ([path, url]) => {
			const source = await openAudio(url);
			if (!source) return;
			try {
				audio.add_music(
					path,
					source.channels,
					source.sampleRate,
					await decodeWhole(source),
				);
			} finally {
				source.input.dispose();
			}
		}),
	]);
	scope.postMessage({
		kind: "stats",
		decodeMs: Math.round(performance.now() - started),
		mixMs: 0,
	});
}

async function finish() {
	scope.postMessage({
		kind: "stats",
		decodeMs: Math.round(decodeMs),
		mixMs: Math.round(mixMs),
	});
	mixer?.free();
	mixer = null;
	const open = [...decoders.values()];
	decoders.clear();
	await Promise.all(open.map((decoder) => decoder.dispose()));
}

async function pull(chunks: number) {
	for (let index = 0; index < chunks; index++) {
		if (!mixer || remaining <= 0) {
			scope.postMessage({
				kind: "chunk",
				samples: new Float32Array(0),
				done: true,
			});
			return;
		}
		const frames = Math.min(CHUNK_FRAMES, remaining);
		const missing = mixer.plan(frames);
		for (let pair = 0; pair < missing.length; pair += 2) {
			const id = missing[pair] as number;
			const block = missing[pair + 1] as number;
			const decoder = decoders.get(id);
			if (!decoder) continue;
			const decodeStart = performance.now();
			const { samples, end } = await decoder.block(block);
			decodeMs += performance.now() - decodeStart;
			mixer.put_block(id, block, samples);
			if (end !== null) mixer.set_track_frames(id, end);
		}
		const mixStart = performance.now();
		const samples = mixer.next_chunk(frames);
		mixMs += performance.now() - mixStart;
		remaining = samples.length === 0 ? 0 : remaining - samples.length / 2;
		const done = remaining <= 0;
		scope.postMessage({ kind: "chunk", samples, done }, [samples.buffer]);
		if (done) {
			await finish();
			return;
		}
	}
}

let queue: Promise<void> = Promise.resolve();

scope.addEventListener("message", (event) => {
	const message = event.data;
	const task =
		message.kind === "start"
			? () => start(message)
			: () => pull(message.chunks);
	queue = queue.then(task).catch((cause: unknown) => {
		scope.postMessage({
			kind: "error",
			message: cause instanceof Error ? cause.message : String(cause),
		});
	});
});
