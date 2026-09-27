"use client";

import {
	ALL_FORMATS,
	type AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	CanvasSource,
	canEncodeAudio,
	Input,
	Mp4OutputFormat,
	Output,
} from "mediabunny";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 15;
const BARS = 160;
const MAX_SECONDS = 4 * 60 * 60;

/**
 * Turns an audio file into an MP4 audiogram (a calm background, the title and
 * the whole waveform lighting up as it plays) so audio can start a Cap like
 * any other video: the upload, processing, share page and editor all expect a
 * video track.
 */
export async function convertAudioToVideo(
	file: File,
	onProgress?: (fraction: number) => void,
	signal?: AbortSignal,
): Promise<File> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) throw new Error("This file has no audio in it");
		const duration = await input.computeDuration();
		if (!(duration > 0)) throw new Error("This audio file is empty");
		if (duration > MAX_SECONDS) throw new Error("This audio file is too long");

		const envelope = await loudnessEnvelope(
			new AudioSampleSink(track),
			duration,
			(fraction) => onProgress?.(fraction * 0.25),
			signal,
		);

		const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas drawing is unavailable");
		const title = file.name.replace(/\.[^.]+$/, "");

		const audioCodec = (await canEncodeAudio("aac")) ? "aac" : "opus";
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target: new BufferTarget(),
		});
		const video = new CanvasSource(canvas, {
			codec: "avc",
			bitrate: 1_200_000,
			keyFrameInterval: 2,
		});
		const audio = new AudioSampleSource({
			codec: audioCodec,
			bitrate: 160_000,
		});
		output.addVideoTrack(video, { frameRate: FPS });
		output.addAudioTrack(audio);
		await output.start();

		const samples = new AudioSampleSink(track).samples();
		let pending: AudioSample | null = null;
		const frames = Math.ceil(duration * FPS);
		for (let frame = 0; frame < frames; frame++) {
			if (signal?.aborted) throw new Error("Audio conversion was canceled");
			const time = frame / FPS;
			// Keep the audio a step ahead of the picture so the muxer can interleave.
			while (true) {
				const next: AudioSample | null =
					pending ?? (await samples.next()).value ?? null;
				pending = null;
				if (!next) break;
				if (next.timestamp > time + 1 / FPS) {
					pending = next;
					break;
				}
				await audio.add(next);
				next.close();
			}
			drawFrame(context, envelope, time / duration, title);
			await video.add(time, 1 / FPS);
			if (frame % FPS === 0) onProgress?.(0.25 + (frame / frames) * 0.73);
		}
		while (true) {
			const next: AudioSample | null =
				pending ?? (await samples.next()).value ?? null;
			pending = null;
			if (!next) break;
			await audio.add(next);
			next.close();
		}
		await output.finalize();
		onProgress?.(1);

		const buffer = (output.target as BufferTarget).buffer;
		if (!buffer) throw new Error("Audio conversion produced no video");
		return new File([buffer], `${title || "Audio"}.mp4`, { type: "video/mp4" });
	} finally {
		input.dispose?.();
	}
}

async function loudnessEnvelope(
	sink: AudioSampleSink,
	duration: number,
	onProgress: (fraction: number) => void,
	signal?: AbortSignal,
) {
	const sums = new Float64Array(BARS);
	const counts = new Uint32Array(BARS);
	let scratch = new Float32Array(0);
	for await (const sample of sink.samples()) {
		if (signal?.aborted) {
			sample.close();
			throw new Error("Audio conversion was canceled");
		}
		const frames = sample.numberOfFrames;
		if (scratch.length < frames) scratch = new Float32Array(frames);
		sample.copyTo(scratch, { planeIndex: 0, format: "f32-planar" });
		const perFrame = sample.duration / Math.max(1, frames);
		for (let index = 0; index < frames; index += 32) {
			const bar = Math.min(
				BARS - 1,
				Math.floor(((sample.timestamp + index * perFrame) / duration) * BARS),
			);
			const value = scratch[index] ?? 0;
			sums[bar] = (sums[bar] ?? 0) + value * value;
			counts[bar] = (counts[bar] ?? 0) + 1;
		}
		onProgress(Math.min(1, (sample.timestamp + sample.duration) / duration));
		sample.close();
	}
	const levels = Array.from(sums, (sum, index) =>
		Math.sqrt(sum / Math.max(1, counts[index] ?? 0)),
	);
	const peak = Math.max(0.0001, ...levels);
	return levels.map((level) => Math.max(0.04, (level / peak) ** 0.7));
}

function drawFrame(
	context: OffscreenCanvasRenderingContext2D,
	envelope: number[],
	progress: number,
	title: string,
) {
	const background = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
	background.addColorStop(0, "#15161a");
	background.addColorStop(1, "#0d0e11");
	context.fillStyle = background;
	context.fillRect(0, 0, WIDTH, HEIGHT);

	context.fillStyle = "rgba(255,255,255,0.92)";
	context.font = "500 44px ui-sans-serif, system-ui, -apple-system, sans-serif";
	context.textBaseline = "alphabetic";
	context.fillText(truncate(context, title, WIDTH - 320), 160, 330);

	const left = 160;
	const width = WIDTH - 320;
	const centre = HEIGHT / 2 + 60;
	const step = width / envelope.length;
	const barWidth = Math.max(3, step * 0.55);
	const played = progress * envelope.length;
	envelope.forEach((level, index) => {
		const height = Math.max(6, level * 300);
		context.fillStyle = index < played ? "#3b82f6" : "rgba(255,255,255,0.18)";
		roundedBar(
			context,
			left + index * step + (step - barWidth) / 2,
			centre - height / 2,
			barWidth,
			height,
		);
	});
}

function roundedBar(
	context: OffscreenCanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
) {
	const radius = Math.min(width / 2, height / 2);
	context.beginPath();
	context.roundRect(x, y, width, height, radius);
	context.fill();
}

function truncate(
	context: OffscreenCanvasRenderingContext2D,
	text: string,
	maxWidth: number,
) {
	if (context.measureText(text).width <= maxWidth) return text;
	let end = text.length;
	while (
		end > 1 &&
		context.measureText(`${text.slice(0, end)}…`).width > maxWidth
	)
		end--;
	return `${text.slice(0, end)}…`;
}
