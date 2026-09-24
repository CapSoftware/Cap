import type { Output } from "mediabunny";
import type { BrowserRecordingTimes } from "../renderer/pkg-export/cap_editor_browser_renderer.js";
import type {
	BrowserExportAudioReply,
	BrowserExportAudioRequest,
} from "./browser-export-audio-worker";
import type { BrowserExportJob } from "./browser-export-worker";

const SAMPLE_RATE = 48_000;
const AUDIO_BITRATE = 320_000;
const PREFETCH_CHUNKS = 40;

export type BrowserExportAudioTrack = {
	url: string;
	segment: number;
	microphone: boolean;
	offsetSeconds: number;
};

/// Mixes and encodes the export's audio alongside the video. Returns null
/// when the recording has no audio to export.
export async function renderBrowserExportAudio(
	job: BrowserExportJob,
	times: BrowserRecordingTimes,
	output: Output,
	totalFrames: number,
) {
	const audioConfig = job.config.audio as { mute?: boolean } | undefined;
	const hasMusic = Object.keys(job.musicUrls).length > 0;
	if (audioConfig?.mute === true && !hasMusic) return null;
	if (job.audio.length === 0 && !hasMusic) return null;
	const { AudioSample, AudioSampleSource, canEncodeAudio } = await import(
		"mediabunny"
	);
	const codec = (await canEncodeAudio("aac", {
		numberOfChannels: 2,
		sampleRate: SAMPLE_RATE,
		bitrate: AUDIO_BITRATE,
	}))
		? ("aac" as const)
		: ("opus" as const);
	const source = new AudioSampleSource({ codec, bitrate: AUDIO_BITRATE });
	output.addAudioTrack(source);
	const outputSamples = Math.round((totalFrames / job.fps) * SAMPLE_RATE);
	const tracks: BrowserExportAudioTrack[] = job.audio.map((track) => {
		const clipTimes =
			track.kind === "display"
				? times.source_times(track.segment, 0)
				: times.audio_times(track.segment, 0);
		const offset = track.kind === "system" ? clipTimes[1] : clipTimes[0];
		return {
			url: track.url,
			segment: track.segment,
			microphone: track.kind === "mic",
			offsetSeconds:
				offset !== undefined && Number.isFinite(offset)
					? offset
					: track.offsetSeconds,
		};
	});
	return {
		codec,
		async run() {
			const worker = new Worker(
				new URL("./browser-export-audio-worker.ts", import.meta.url),
				{ type: "module" },
			);
			const chunks: Float32Array[] = [];
			let outstanding = PREFETCH_CHUNKS;
			let finished = false;
			let failure: Error | null = null;
			let wake: (() => void) | null = null;
			const notify = () => {
				wake?.();
				wake = null;
			};
			worker.addEventListener(
				"message",
				(event: MessageEvent<BrowserExportAudioReply>) => {
					const message = event.data;
					if (message.kind === "chunk") {
						outstanding = Math.max(outstanding - 1, 0);
						if (message.samples.length > 0) chunks.push(message.samples);
						if (message.done) finished = true;
					} else if (message.kind === "error") {
						failure = new Error(message.message);
					} else {
						console.info("Cap local export audio", JSON.stringify(message));
					}
					notify();
				},
			);
			worker.addEventListener("error", (event) => {
				failure = new Error(event.message || "Export audio failed");
				notify();
			});
			const request: BrowserExportAudioRequest = {
				kind: "start",
				config: job.config,
				outputSamples,
				tracks,
				musicUrls: job.musicUrls,
			};
			worker.postMessage(request);
			worker.postMessage({ kind: "pull", chunks: PREFETCH_CHUNKS });
			let written = 0;
			try {
				while (true) {
					if (failure) throw failure;
					const chunk = chunks.shift();
					if (!chunk) {
						if (finished) break;
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
						continue;
					}
					if (!finished && chunks.length + outstanding < PREFETCH_CHUNKS / 2) {
						outstanding += PREFETCH_CHUNKS / 2;
						worker.postMessage({ kind: "pull", chunks: PREFETCH_CHUNKS / 2 });
					}
					const sample = new AudioSample({
						data: chunk,
						format: "f32",
						numberOfChannels: 2,
						sampleRate: SAMPLE_RATE,
						timestamp: written / SAMPLE_RATE,
					});
					try {
						await source.add(sample);
					} finally {
						sample.close();
					}
					written += chunk.length / 2;
				}
			} finally {
				worker.terminate();
				source.close();
			}
		},
	};
}
