import { promises as fs } from "node:fs";
import {
	extractAudioFromUrl,
	probeMediaDurationSeconds,
} from "@/lib/audio-extract";
import { TRANSCRIPT_MAX_DURATION_SECONDS } from "@/lib/developer-transcripts";
import {
	checkHasAudioTrackViaMediaServer,
	convertAudioToMp3ViaMediaServer,
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";
import { StreamTooLargeError } from "@/lib/public-media-fetch";

export const TRANSCRIPT_AUDIO_BITS_PER_SECOND = 128_000;
export const TRANSCRIPT_AUDIO_DURATION_SLACK_SECONDS = 1;

const AUDIO_BYTES_PER_SECOND = TRANSCRIPT_AUDIO_BITS_PER_SECOND / 8;
const ENCODER_STOP_SLACK_SECONDS = 5;
const ENCODER_STOP_SLACK_BYTES = 64 * 1024;

export const TRANSCRIPT_AUDIO_MAX_SECONDS =
	TRANSCRIPT_MAX_DURATION_SECONDS + TRANSCRIPT_AUDIO_DURATION_SLACK_SECONDS;
export const TRANSCRIPT_AUDIO_ENCODER_STOP_SECONDS =
	TRANSCRIPT_MAX_DURATION_SECONDS + ENCODER_STOP_SLACK_SECONDS;
export const TRANSCRIPT_AUDIO_MAX_BYTES =
	(TRANSCRIPT_AUDIO_MAX_SECONDS + 1) * AUDIO_BYTES_PER_SECOND;
export const TRANSCRIPT_AUDIO_ENCODER_STOP_BYTES =
	TRANSCRIPT_AUDIO_MAX_BYTES + ENCODER_STOP_SLACK_BYTES;

export type ExtractedTranscriptAudio =
	| { state: "ok"; audio: Buffer }
	| { state: "no_audio" }
	| { state: "too_long" };

const LOCAL_NO_AUDIO_PATTERN =
	/does not contain any stream|matches no streams/i;

const isTooLong = (seconds: number | null) =>
	seconds !== null && seconds > TRANSCRIPT_AUDIO_MAX_SECONDS;

async function extractViaMediaServer(
	sourceUrl: string,
): Promise<ExtractedTranscriptAudio> {
	const probedSeconds = await probeVideoViaMediaServer(sourceUrl, {
		maxRetries: 0,
	}).then(
		(probe) =>
			Number.isFinite(probe.duration) && probe.duration > 0
				? probe.duration
				: null,
		() => null,
	);
	if (isTooLong(probedSeconds)) return { state: "too_long" };

	try {
		const audio = await convertAudioToMp3ViaMediaServer(sourceUrl, {
			maxBytes: TRANSCRIPT_AUDIO_MAX_BYTES,
		});
		return { state: "ok", audio };
	} catch (error) {
		if (error instanceof StreamTooLargeError) return { state: "too_long" };
		const hasAudio = await checkHasAudioTrackViaMediaServer(sourceUrl).catch(
			() => null,
		);
		if (hasAudio === false) return { state: "no_audio" };
		throw error;
	}
}

async function extractLocally(
	sourceUrl: string,
): Promise<ExtractedTranscriptAudio> {
	if (isTooLong(await probeMediaDurationSeconds(sourceUrl))) {
		return { state: "too_long" };
	}

	let extracted: Awaited<ReturnType<typeof extractAudioFromUrl>>;
	try {
		extracted = await extractAudioFromUrl(sourceUrl, {
			maxDurationSeconds: TRANSCRIPT_AUDIO_ENCODER_STOP_SECONDS,
			maxBytes: TRANSCRIPT_AUDIO_ENCODER_STOP_BYTES,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (LOCAL_NO_AUDIO_PATTERN.test(message)) return { state: "no_audio" };
		throw error;
	}

	try {
		const { size } = await fs.stat(extracted.filePath);
		if (size > TRANSCRIPT_AUDIO_MAX_BYTES) return { state: "too_long" };
		return { state: "ok", audio: await fs.readFile(extracted.filePath) };
	} finally {
		await extracted.cleanup();
	}
}

export function extractTranscriptAudioBytes(
	sourceUrl: string,
): Promise<ExtractedTranscriptAudio> {
	return isMediaServerConfigured()
		? extractViaMediaServer(sourceUrl)
		: extractLocally(sourceUrl);
}
