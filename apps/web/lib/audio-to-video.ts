"use client";

import {
	ALL_FORMATS,
	type AudioCodec,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	CanvasSource,
	canEncodeAudio,
	canEncodeVideo,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	Input,
	type InputAudioTrack,
	Mp4OutputFormat,
	Output,
	type VideoCodec,
	type VideoEncodingConfig,
} from "mediabunny";
import { MAX_AUDIO_VIDEO_SECONDS } from "./audio-video-limits";

const WIDTH = 1280;
const HEIGHT = 720;
const COPYABLE_CODECS: AudioCodec[] = ["aac", "opus", "mp3", "flac"];
const VIDEO_CODECS: VideoCodec[] = ["avc", "vp9", "vp8", "av1"];

// Realtime mode keeps the unchanging frames tiny, so the upload is barely
// bigger than the audio.
const videoConfig = (codec: VideoCodec): VideoEncodingConfig => ({
	codec,
	bitrate: 150_000,
	keyFrameInterval: 60,
	latencyMode: "realtime",
});

// The upload, processing and share page all expect a video track. Non-AAC
// audio becomes AAC here since processing would re-encode it far more slowly.
export async function wrapAudioInVideo(
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
		if (duration > MAX_AUDIO_VIDEO_SECONDS)
			throw new Error("This audio file is too long");

		const title = file.name.replace(/\.[^.]+$/, "") || "Audio";
		const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas drawing is unavailable");
		drawTitleCard(context, title);

		const codec = await firstWorkingVideoCodec(VIDEO_CODECS, (candidate) =>
			encodesCard(canvas, candidate),
		);
		if (!codec) throw new Error("This browser can't encode video");

		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target: new BufferTarget(),
		});
		const video = new CanvasSource(canvas, videoConfig(codec));
		output.addVideoTrack(video, { frameRate: 1 });
		const audio = await addAudioTrack(output, track);
		await output.start();

		// The card is added a second at a time, just ahead of the audio, so the
		// muxer can interleave the two tracks.
		let nextFrame = 0;
		const addFramesUntil = async (time: number) => {
			while (nextFrame < Math.min(time, duration)) {
				await video.add(nextFrame, Math.min(1, duration - nextFrame));
				nextFrame += 1;
			}
		};
		// Progress is reported in whole percents: a callback per packet would
		// rerender the page tens of thousands of times and stall the encoders.
		let reported = 0;
		for await (const timestamp of audio.copy()) {
			if (signal?.aborted) throw new Error("Audio import was canceled");
			await addFramesUntil(timestamp + 1);
			const fraction = Math.min(0.99, timestamp / duration);
			if (fraction - reported >= 0.01) {
				reported = fraction;
				onProgress?.(fraction);
			}
		}
		await addFramesUntil(duration);
		await output.finalize();
		onProgress?.(1);

		const buffer = (output.target as BufferTarget).buffer;
		if (!buffer) throw new Error("Audio import produced no video");
		return new File([buffer], `${title}.mp4`, { type: "video/mp4" });
	} finally {
		input.dispose?.();
	}
}

export async function firstWorkingVideoCodec(
	candidates: VideoCodec[],
	encodes: (codec: VideoCodec) => Promise<boolean>,
) {
	for (const codec of candidates) {
		if (await encodes(codec)) return codec;
	}
	return null;
}

// Firefox can report H.264 as supported and then fail the first encode, so a
// codec counts only once it has encoded a real frame.
async function encodesCard(canvas: OffscreenCanvas, codec: VideoCodec) {
	if (
		!(await canEncodeVideo(codec, {
			width: WIDTH,
			height: HEIGHT,
			bitrate: 150_000,
			latencyMode: "realtime",
		}))
	)
		return false;
	const probe = new Output({
		format: new Mp4OutputFormat({ fastStart: "in-memory" }),
		target: new BufferTarget(),
	});
	try {
		const source = new CanvasSource(canvas, videoConfig(codec));
		probe.addVideoTrack(source, { frameRate: 1 });
		await probe.start();
		await source.add(0, 1);
		await probe.finalize();
		return ((probe.target as BufferTarget).buffer?.byteLength ?? 0) > 0;
	} catch (error) {
		console.warn(`Video encoding with ${codec} failed`, error);
		await probe.cancel().catch(() => {});
		return false;
	}
}

async function addAudioTrack(output: Output, track: InputAudioTrack) {
	const codec = track.codec;
	// AAC from phones and encoders starts slightly before zero to prime the
	// decoder, which an MP4 track can't, so the whole track moves up to zero.
	const shift = Math.max(0, -(await track.getFirstTimestamp()));
	const canEncodeAac = await canEncodeAudio("aac");
	if (
		codec === "aac" ||
		(!canEncodeAac && codec && COPYABLE_CODECS.includes(codec))
	) {
		const source = new EncodedAudioPacketSource(codec);
		output.addAudioTrack(source);
		const decoderConfig = await track.getDecoderConfig();
		return {
			async *copy() {
				let first = true;
				for await (const packet of new EncodedPacketSink(track).packets()) {
					const timestamp = packet.timestamp + shift;
					await source.add(
						shift ? packet.clone({ timestamp }) : packet,
						first && decoderConfig ? { decoderConfig } : undefined,
					);
					first = false;
					yield timestamp;
				}
			},
		};
	}
	const source = new AudioSampleSource({
		codec: canEncodeAac ? "aac" : "opus",
		bitrate: 160_000,
	});
	output.addAudioTrack(source);
	return {
		async *copy() {
			for await (const sample of new AudioSampleSink(track).samples()) {
				const timestamp = sample.timestamp + shift;
				if (shift) sample.setTimestamp(timestamp);
				await source.add(sample);
				sample.close();
				yield timestamp;
			}
		},
	};
}

function drawTitleCard(
	context: OffscreenCanvasRenderingContext2D,
	title: string,
) {
	const background = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
	background.addColorStop(0, "#1b1d2a");
	background.addColorStop(1, "#0e0f14");
	context.fillStyle = background;
	context.fillRect(0, 0, WIDTH, HEIGHT);
	context.fillStyle = "rgba(255,255,255,0.92)";
	context.font = "500 40px ui-sans-serif, system-ui, -apple-system, sans-serif";
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.fillText(
		truncate(context, title, WIDTH - 240),
		WIDTH / 2,
		HEIGHT / 2,
	);
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
