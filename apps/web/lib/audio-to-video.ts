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
	EncodedAudioPacketSource,
	EncodedPacketSink,
	Input,
	type InputAudioTrack,
	Mp4OutputFormat,
	Output,
} from "mediabunny";

const WIDTH = 1280;
const HEIGHT = 720;
const MAX_SECONDS = 4 * 60 * 60;
/** Codecs an MP4 can carry that browsers also play. */
const COPYABLE_CODECS: AudioCodec[] = ["aac", "opus", "mp3", "flac"];

/**
 * Wraps an audio file in an MP4 with a still title card, one frame a second,
 * so audio can start a Cap like any recording: the upload, processing and
 * share page all expect a video track. The editor hides that card and draws
 * a live waveform instead. AAC is copied untouched; other audio becomes AAC
 * here, since processing would otherwise re-encode it far more slowly.
 */
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
		if (duration > MAX_SECONDS) throw new Error("This audio file is too long");

		const title = file.name.replace(/\.[^.]+$/, "") || "Audio";
		const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas drawing is unavailable");
		drawTitleCard(context, title);

		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target: new BufferTarget(),
		});
		// Realtime mode keeps the unchanging frames tiny, so the upload is barely
		// bigger than the audio.
		const video = new CanvasSource(canvas, {
			codec: "avc",
			bitrate: 150_000,
			keyFrameInterval: 60,
			latencyMode: "realtime",
		});
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

/** Adds the audio track, returning an iterator that copies it and yields progress timestamps. */
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
