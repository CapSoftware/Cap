import type { EncodedPacket, Output } from "mediabunny";
import type { BrowserRecordingTimes } from "../renderer/pkg-export/cap_editor_browser_renderer.js";
import type {
	BrowserExportAudioReply,
	BrowserExportAudioRequest,
} from "./browser-export-audio-worker";
import { EXPORT_AUDIO_BITRATE } from "./browser-export-estimate";
import type { BrowserExportJob } from "./browser-export-worker";

const SAMPLE_RATE = 48_000;
const PREFETCH_CHUNKS = 40;

/// Frames of priming silence the AAC encoder puts before the audio. MP4s
/// written here carry no edit list to trim it, so the mix is fed that far
/// ahead instead of landing late against the video.
async function aacEncoderDelay() {
	const frames = 8_192;
	const impulseAt = 2_048;
	const chunks: EncodedAudioChunk[] = [];
	let decoderConfig: AudioDecoderConfig | undefined;
	const encoder = new AudioEncoder({
		output: (chunk, meta) => {
			chunks.push(chunk);
			decoderConfig ??= meta?.decoderConfig;
		},
		error: () => undefined,
	});
	const decoded: Float32Array[] = [];
	const decoder = new AudioDecoder({
		output: (data) => {
			const plane = new Float32Array(data.numberOfFrames);
			data.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
			decoded.push(plane);
			data.close();
		},
		error: () => undefined,
	});
	try {
		encoder.configure({
			codec: "mp4a.40.2",
			sampleRate: SAMPLE_RATE,
			numberOfChannels: 2,
			bitrate: EXPORT_AUDIO_BITRATE,
		});
		const samples = new Float32Array(frames * 2);
		for (let index = 0; index < 48; index++) {
			const value = Math.sin((index / 48) * Math.PI) * 0.9;
			samples[(impulseAt + index) * 2] = value;
			samples[(impulseAt + index) * 2 + 1] = value;
		}
		const data = new AudioData({
			format: "f32",
			sampleRate: SAMPLE_RATE,
			numberOfChannels: 2,
			numberOfFrames: frames,
			timestamp: 0,
			data: samples,
		});
		encoder.encode(data);
		data.close();
		await encoder.flush();
		if (!decoderConfig) return 0;
		decoder.configure(decoderConfig);
		for (const chunk of chunks) decoder.decode(chunk);
		await decoder.flush();
		let peak = 0;
		let peakValue = 0;
		let offset = 0;
		for (const plane of decoded) {
			for (let index = 0; index < plane.length; index++) {
				const value = Math.abs(plane[index] ?? 0);
				if (value > peakValue) {
					peakValue = value;
					peak = offset + index;
				}
			}
			offset += plane.length;
		}
		const delay = peak - (impulseAt + 24);
		return peakValue > 0.1 && delay > 0 && delay < frames / 2 ? delay : 0;
	} catch {
		return 0;
	} finally {
		if (encoder.state !== "closed") encoder.close();
		if (decoder.state !== "closed") decoder.close();
	}
}

let aacDelay: Promise<number> | null = null;

function aacPrimingFrames() {
	aacDelay ??= aacEncoderDelay();
	return aacDelay;
}

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
	onEncodedPacket?: (
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) => void,
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
		bitrate: EXPORT_AUDIO_BITRATE,
	}))
		? ("aac" as const)
		: ("opus" as const);
	const primingFrames = codec === "aac" ? await aacPrimingFrames() : 0;
	const source = new AudioSampleSource({
		codec,
		bitrate: EXPORT_AUDIO_BITRATE,
		onEncodedPacket,
	});
	const outputSamples = Math.round((totalFrames / job.fps) * SAMPLE_RATE);
	output.addAudioTrack(source, {
		maximumPacketCount: Math.ceil(outputSamples / 960) + 16,
	});
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
			let skip = primingFrames * 2;
			try {
				while (true) {
					if (failure) throw failure;
					let chunk = chunks.shift();
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
					if (skip > 0) {
						const skipped = Math.min(skip, chunk.length);
						skip -= skipped;
						chunk = chunk.subarray(skipped);
						if (chunk.length === 0) continue;
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
