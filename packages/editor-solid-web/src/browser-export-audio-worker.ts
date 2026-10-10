// Decodes and mixes a local export's audio (including Studio Sound) off the
// video worker's thread, handing interleaved 48 kHz stereo chunks back on
// request so memory stays bounded.
import type { Input } from "mediabunny";
import type { BrowserExportAudioTrack } from "./browser-export-audio";
import {
	type Audio,
	interleave,
	StreamedTracks,
} from "./browser-export-audio-blocks";

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

async function openAudio(
	url: string,
): Promise<(Audio & { input: Input }) | null> {
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

/// All of a music file, which the mixer resamples as a whole.
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

let mixer: InstanceType<RendererModule["BrowserExportAudio"]> | null = null;
let tracks: StreamedTracks | null = null;
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
	const streamed = new StreamedTracks(
		audio,
		(channels, sampleRate, start) =>
			new module.ExportAudioResampler(channels, sampleRate, start),
	);
	tracks = streamed;
	remaining = request.outputSamples;
	await Promise.all([
		...request.tracks.map(async (track) => {
			const source = await openAudio(track.url);
			if (source) streamed.add(track, source);
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
	const open = tracks;
	tracks = null;
	await open?.dispose();
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
		const decodeStart = performance.now();
		await tracks?.load(frames);
		decodeMs += performance.now() - decodeStart;
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
