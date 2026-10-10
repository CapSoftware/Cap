import { beforeAll, expect, test } from "bun:test";
import type { AudioSample, Input } from "mediabunny";
import {
	BrowserExportAudio,
	ExportAudioResampler,
	initSync,
} from "../renderer/pkg-export/cap_editor_browser_renderer.js";
import {
	type Audio,
	BLOCK_FRAMES,
	BlockDecoder,
	SAMPLE_RATE,
	StreamedTracks,
} from "./browser-export-audio-blocks";

const PACKET_FRAMES = 1024;
// The resampler's filter reads this many source frames past each output.
const FILTER_LOOKAHEAD = 16;
const CHUNK_FRAMES = 4_800;

beforeAll(async () => {
	const wasm = await Bun.file(
		new URL(
			"../renderer/pkg-export/cap_editor_browser_renderer_bg.wasm",
			import.meta.url,
		),
	).arrayBuffer();
	initSync({ module: wasm });
});

function tone(frames: number, channels: number, rate: number) {
	const samples = new Float32Array(frames * channels);
	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			const hz = 440 + 330 * channel;
			samples[frame * channels + channel] =
				0.4 * Math.sin((2 * Math.PI * hz * frame) / rate) +
				0.1 * Math.sin((2 * Math.PI * 7_919 * frame) / rate);
		}
	}
	return samples;
}

/// A decoder over `samples` that hands out `packetFrames` packets (AAC-sized
/// by default), and how far into the track it has decoded.
function fakeAudio(
	samples: Float32Array,
	channels: number,
	rate: number,
	packetFrames = PACKET_FRAMES,
) {
	const frames = samples.length / channels;
	const first = 0.25;
	const progress = { decoded: 0 };
	const audio: Audio = {
		input: {
			dispose: () => undefined,
			getDurationFromMetadata: async () => first + 12,
		} as Audio["input"],
		sink: {
			async *samples(start = first) {
				let from =
					Math.max(0, Math.floor(((start - first) * rate) / packetFrames)) *
					packetFrames;
				for (; from < frames; from += packetFrames) {
					const count = Math.min(packetFrames, frames - from);
					progress.decoded = Math.max(progress.decoded, from + count);
					const at = from;
					yield {
						timestamp: first + at / rate,
						numberOfFrames: count,
						copyTo(destination: Float32Array, options: { planeIndex: number }) {
							for (let index = 0; index < count; index++) {
								destination[index] =
									samples[(at + index) * channels + options.planeIndex] ?? 0;
							}
						},
						close: () => undefined,
					} as unknown as AudioSample;
				}
			},
		} as Audio["sink"],
		sampleRate: rate,
		channels,
		first,
	};
	return { audio, progress };
}

const createResampler = (channels: number, rate: number, start: number) =>
	new ExportAudioResampler(channels, rate, start);

function config(outputFrames: number) {
	const end = outputFrames / SAMPLE_RATE;
	return JSON.stringify({
		timeline: {
			segments: [{ recordingSegment: 0, timescale: 1, start: 0, end }],
			zoomSegments: [],
			audioSegments: [{ start: 0, end, path: "reference" }],
		},
	});
}

function drain(mixer: BrowserExportAudio, beforeChunk?: () => Promise<void>) {
	return (async () => {
		const chunks: Float32Array[] = [];
		for (;;) {
			await beforeChunk?.();
			const chunk = mixer.next_chunk(CHUNK_FRAMES);
			if (chunk.length === 0) break;
			chunks.push(chunk);
		}
		const output = new Float32Array(
			chunks.reduce((total, chunk) => total + chunk.length, 0),
		);
		let offset = 0;
		for (const chunk of chunks) {
			output.set(chunk, offset);
			offset += chunk.length;
		}
		return output;
	})();
}

for (const [rate, channels] of [
	[44_100, 2],
	[22_050, 1],
] as const) {
	test(`a ${rate} Hz x${channels} recording streams in bounded blocks and mixes like the whole-track resample`, async () => {
		const sourceFrames = rate * 35 + 123;
		const samples = tone(sourceFrames, channels, rate);
		const outputFrames = Math.round((sourceFrames * SAMPLE_RATE) / rate);

		const reference = new BrowserExportAudio(
			config(outputFrames),
			outputFrames,
		);
		reference.add_music("reference", channels, rate, samples);
		const expected = await drain(reference);
		reference.free();

		const { audio, progress } = fakeAudio(samples, channels, rate);
		const mixer = new BrowserExportAudio(config(outputFrames), outputFrames);
		const id = mixer.add_streamed_track(0, false, channels, 0);
		const decoder = new BlockDecoder(audio, createResampler);
		const requested: number[] = [];
		let trackFrames: number | null = null;
		let maxAhead = 0;
		let maxHeld = 0;
		const actual = await drain(mixer, async () => {
			const missing = mixer.plan(CHUNK_FRAMES);
			for (let pair = 0; pair < missing.length; pair += 2) {
				expect(missing[pair]).toBe(id);
				const block = missing[pair + 1] as number;
				requested.push(block);
				const { samples: blockSamples, end } = await decoder.block(block);
				const needed = Math.ceil(
					(((block + 1) * BLOCK_FRAMES) / SAMPLE_RATE) * rate,
				);
				maxAhead = Math.max(maxAhead, progress.decoded - needed);
				maxHeld = Math.max(maxHeld, decoder.held);
				mixer.put_block(id, block, blockSamples);
				if (end !== null) {
					trackFrames = end;
					mixer.set_track_frames(id, end);
				}
			}
		});
		mixer.free();
		await decoder.dispose();

		const blocks = Math.ceil(outputFrames / BLOCK_FRAMES);
		expect(requested).toEqual([...Array(blocks).keys()]);
		expect(trackFrames as number | null).toBe(outputFrames);
		expect(maxAhead).toBeLessThanOrEqual(PACKET_FRAMES + FILTER_LOOKAHEAD);
		expect(maxHeld).toBeLessThanOrEqual(1);
		expect(actual.length).toBe(outputFrames * 2);
		let peak = 0;
		let difference = 0;
		for (let index = 0; index < expected.length; index++) {
			peak = Math.max(peak, Math.abs(expected[index] ?? 0));
			difference = Math.max(
				difference,
				Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)),
			);
		}
		expect(peak).toBeGreaterThan(0.3);
		expect(difference).toBe(0);
	});
}

test("a resampled track seeking straight to a block matches reading up to it", async () => {
	const rate = 44_100;
	const channels = 2;
	const samples = tone(rate * 35, channels, rate);
	// Packets that start exactly on block boundaries, so a seek to a block
	// decodes nothing before it unless the decoder asks for earlier audio.
	const packetFrames = ((BLOCK_FRAMES / SAMPLE_RATE) * rate) / 100;
	const sequential = new BlockDecoder(
		fakeAudio(samples, channels, rate, packetFrames).audio,
		createResampler,
	);
	const blocks = [];
	for (let index = 0; index < 4; index++) {
		blocks.push(await sequential.block(index));
	}
	await sequential.dispose();
	expect(blocks.slice(0, 3).map((block) => block.end)).toEqual([
		null,
		null,
		null,
	]);
	expect(blocks[3]?.end).toBe(35 * SAMPLE_RATE);

	for (const index of [2, 3, 1]) {
		const seeking = new BlockDecoder(
			fakeAudio(samples, channels, rate, packetFrames).audio,
			createResampler,
		);
		const block = await seeking.block(index);
		await seeking.dispose();
		expect(block.end).toBe(blocks[index]?.end ?? null);
		expect(block.samples).toEqual(blocks[index]?.samples as Float32Array);
	}
});

for (const rate of [48_000, 44_100]) {
	test(`a ${rate} Hz track whose container declares only its first fragment still mixes to its real end`, async () => {
		const channels = 2;
		const sourceFrames = rate * 35;
		const samples = tone(sourceFrames, channels, rate);
		const outputFrames = 40 * SAMPLE_RATE;

		const reference = new BrowserExportAudio(
			config(outputFrames),
			outputFrames,
		);
		reference.add_music("reference", channels, rate, samples);
		const expected = await drain(reference);
		reference.free();

		const { audio } = fakeAudio(samples, channels, rate);
		expect(await (audio.input as Input).getDurationFromMetadata()).toBe(
			audio.first + 12,
		);
		const mixer = new BrowserExportAudio(config(outputFrames), outputFrames);
		const tracks = new StreamedTracks(mixer, createResampler);
		tracks.add(
			{ url: "", segment: 0, microphone: false, offsetSeconds: 0 },
			audio,
		);
		const actual = await drain(mixer, () => tracks.load(CHUNK_FRAMES));
		mixer.free();
		await tracks.dispose();

		expect(actual.length).toBe(outputFrames * 2);
		const end = 35 * SAMPLE_RATE * 2;
		let late = 0;
		let difference = 0;
		for (let index = 0; index < expected.length; index++) {
			if (index >= 30 * SAMPLE_RATE * 2 && index < end) {
				late = Math.max(late, Math.abs(actual[index] ?? 0));
			}
			difference = Math.max(
				difference,
				Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)),
			);
		}
		expect(late).toBeGreaterThan(0.3);
		expect(difference).toBe(0);
		expect(actual.subarray(end).every((sample) => sample === 0)).toBe(true);
	});
}

test("a seek past a track's end leaves its length unknown", async () => {
	const rate = 44_100;
	const samples = tone(rate * 5, 2, rate);
	const decoder = new BlockDecoder(
		fakeAudio(samples, 2, rate).audio,
		createResampler,
	);
	const block = await decoder.block(3);
	await decoder.dispose();
	expect(block.end).toBeNull();
	expect(block.samples.every((sample) => sample === 0)).toBe(true);
});
