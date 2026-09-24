// Decodes and mixes a local export's audio (including Studio Sound) off the
// video worker's thread, handing interleaved 48 kHz stereo chunks back on
// request so memory stays bounded.
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

async function decodeAudio(url: string) {
	const { ALL_FORMATS, AudioSampleSink, Input, UrlSource } = await import(
		"mediabunny"
	);
	const input = new Input({
		formats: ALL_FORMATS,
		source: new UrlSource(url, { maxCacheSize: 32 * 1024 * 1024 }),
	});
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) return null;
		const sampleRate = await track.getSampleRate();
		const sourceChannels = await track.getNumberOfChannels();
		const channels = Math.min(Math.max(sourceChannels, 1), 2);
		const chunks: Float32Array[] = [];
		let length = 0;
		for await (const sample of new AudioSampleSink(track).samples()) {
			try {
				const frames = sample.numberOfFrames;
				const interleaved = new Float32Array(frames * channels);
				const plane = new Float32Array(frames);
				for (let channel = 0; channel < channels; channel++) {
					sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
					for (let frame = 0; frame < frames; frame++) {
						interleaved[frame * channels + channel] = plane[frame] ?? 0;
					}
				}
				chunks.push(interleaved);
				length += interleaved.length;
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
		return { samples, channels, sampleRate };
	} finally {
		input.dispose();
	}
}

let mixer: InstanceType<RendererModule["BrowserExportAudio"]> | null = null;
let ready: Promise<void> | null = null;
let remaining = 0;
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
			const decoded = await decodeAudio(track.url);
			if (!decoded) return;
			audio.add_track(
				track.segment,
				track.microphone,
				decoded.channels,
				decoded.sampleRate,
				track.offsetSeconds,
				decoded.samples,
			);
		}),
		...Object.entries(request.musicUrls).map(async ([path, url]) => {
			const decoded = await decodeAudio(url);
			if (!decoded) return;
			audio.add_music(
				path,
				decoded.channels,
				decoded.sampleRate,
				decoded.samples,
			);
		}),
	]);
	scope.postMessage({
		kind: "stats",
		decodeMs: Math.round(performance.now() - started),
		mixMs: 0,
	});
}

function pull(chunks: number) {
	for (let index = 0; index < chunks; index++) {
		if (!mixer || remaining <= 0) {
			scope.postMessage({
				kind: "chunk",
				samples: new Float32Array(0),
				done: true,
			});
			return;
		}
		const mixStart = performance.now();
		const samples = mixer.next_chunk(Math.min(CHUNK_FRAMES, remaining));
		mixMs += performance.now() - mixStart;
		remaining = samples.length === 0 ? 0 : remaining - samples.length / 2;
		const done = remaining <= 0;
		scope.postMessage({ kind: "chunk", samples, done }, [samples.buffer]);
		if (done) {
			scope.postMessage({
				kind: "stats",
				decodeMs: -1,
				mixMs: Math.round(mixMs),
			});
			mixer.free();
			mixer = null;
			return;
		}
	}
}

scope.addEventListener("message", (event) => {
	const message = event.data;
	if (message.kind === "start") {
		ready = start(message).catch((cause: unknown) => {
			scope.postMessage({
				kind: "error",
				message: cause instanceof Error ? cause.message : String(cause),
			});
		});
		return;
	}
	void (ready ?? Promise.resolve()).then(() => pull(message.chunks));
});
