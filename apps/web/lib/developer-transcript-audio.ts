import { promises as fs } from "node:fs";
import {
	extractAudioFromUrl,
	probeMediaDurationSeconds,
} from "@/lib/audio-extract";
import {
	TRANSCRIPT_DURATION_SLACK_SECONDS,
	TRANSCRIPT_MAX_DURATION_SECONDS,
} from "@/lib/developer-transcripts";
import {
	checkHasAudioTrackViaMediaServer,
	convertAudioToMp3ViaMediaServer,
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";
import { StreamTooLargeError } from "@/lib/public-media-fetch";

export const TRANSCRIPT_AUDIO_BITS_PER_SECOND = 128_000;
export const TRANSCRIPT_AUDIO_DURATION_SLACK_SECONDS =
	TRANSCRIPT_DURATION_SLACK_SECONDS;

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
	| { state: "too_long" }
	| { state: "over_limit"; reportedSeconds: number | null };

const audioBytesFor = (seconds: number) =>
	(seconds + 1) * AUDIO_BYTES_PER_SECOND;

const pastLimit = (
	limitSeconds: number,
	reportedSeconds: number | null,
): ExtractedTranscriptAudio =>
	limitSeconds >= TRANSCRIPT_AUDIO_MAX_SECONDS
		? { state: "too_long" }
		: { state: "over_limit", reportedSeconds };

const LOCAL_NO_AUDIO_PATTERN =
	/does not contain any stream|matches no streams/i;

export const probeShowsNoAudio = (probe: {
	audioCodec?: string | null;
	audioChannels?: number | null;
}) => !probe.audioCodec && probe.audioChannels === null;

const isTooLong = (seconds: number | null) =>
	seconds !== null && seconds > TRANSCRIPT_AUDIO_MAX_SECONDS;

async function extractViaMediaServer(
	sourceUrl: string,
	limitSeconds: number,
): Promise<ExtractedTranscriptAudio> {
	const probe = await probeVideoViaMediaServer(sourceUrl, {
		maxRetries: 0,
	}).catch(() => null);
	if (probe && probeShowsNoAudio(probe)) return { state: "no_audio" };
	const probedSeconds =
		probe && Number.isFinite(probe.duration) && probe.duration > 0
			? probe.duration
			: null;
	if (isTooLong(probedSeconds)) return { state: "too_long" };
	if (probedSeconds !== null && probedSeconds > limitSeconds) {
		return pastLimit(limitSeconds, probedSeconds);
	}

	try {
		const audio = await convertAudioToMp3ViaMediaServer(sourceUrl, {
			maxBytes: audioBytesFor(limitSeconds),
		});
		return { state: "ok", audio };
	} catch (error) {
		if (error instanceof StreamTooLargeError) {
			return pastLimit(limitSeconds, null);
		}
		const hasAudio = await checkHasAudioTrackViaMediaServer(sourceUrl).catch(
			() => null,
		);
		if (hasAudio === false) return { state: "no_audio" };
		throw error;
	}
}

async function extractLocally(
	sourceUrl: string,
	limitSeconds: number,
): Promise<ExtractedTranscriptAudio> {
	const probedSeconds = await probeMediaDurationSeconds(sourceUrl);
	if (isTooLong(probedSeconds)) return { state: "too_long" };
	if (probedSeconds !== null && probedSeconds > limitSeconds) {
		return pastLimit(limitSeconds, probedSeconds);
	}
	const maxBytes = audioBytesFor(limitSeconds);

	let extracted: Awaited<ReturnType<typeof extractAudioFromUrl>>;
	try {
		extracted = await extractAudioFromUrl(sourceUrl, {
			maxDurationSeconds:
				limitSeconds -
				TRANSCRIPT_AUDIO_DURATION_SLACK_SECONDS +
				ENCODER_STOP_SLACK_SECONDS,
			maxBytes: maxBytes + ENCODER_STOP_SLACK_BYTES,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (LOCAL_NO_AUDIO_PATTERN.test(message)) return { state: "no_audio" };
		throw error;
	}

	try {
		const { size } = await fs.stat(extracted.filePath);
		if (size > maxBytes) return pastLimit(limitSeconds, null);
		return { state: "ok", audio: await fs.readFile(extracted.filePath) };
	} finally {
		await extracted.cleanup();
	}
}

export function extractTranscriptAudioBytes(
	sourceUrl: string,
	limitSeconds: number = TRANSCRIPT_AUDIO_MAX_SECONDS,
): Promise<ExtractedTranscriptAudio> {
	const limit = Math.min(limitSeconds, TRANSCRIPT_AUDIO_MAX_SECONDS);
	return isMediaServerConfigured()
		? extractViaMediaServer(sourceUrl, limit)
		: extractLocally(sourceUrl, limit);
}
