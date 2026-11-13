import type { VideoMetadata } from "./job-manager";
import { createGuardedMediaFetch, normalizeLocalPath } from "./media-common";
import {
	isAllowedVideoCodec,
	isDecoderRejectedMessage,
	UNSUPPORTED_FORMAT_MESSAGE,
} from "./media-input-policy";
import {
	canAcceptNewProbeOperation,
	getActiveProbeOperationCount,
	withMediaOperation,
} from "./media-operations";
import { runProbe } from "./media-probe-pool";
import {
	type ProbedMedia,
	type TrackSpans,
	UnreadableMediaInputError,
} from "./media-probe-read";
import { spawn } from "./media-spawn";
import { materializeMedia } from "./media-transfer";
import { registerSubprocess, terminateProcess } from "./subprocess";

export {
	assertRemotePlaylistStaysOnHost,
	FRAME_TOO_LARGE_MESSAGE,
	fastestFrameRate,
	isUnreadableMediaInput,
	playlistReferences,
	type TrackSpans,
	UnreadableMediaInputError,
} from "./media-probe-read";

const PROBE_TIMEOUT_MS = 30_000;
const FFPROBE_TIMEOUT_MS = 10_000;
const FFPROBE_OUTPUT_LIMIT = 256 * 1024;

export { canAcceptNewProbeOperation, getActiveProbeOperationCount };

export const canAcceptNewProbeProcess = canAcceptNewProbeOperation;
export const getActiveProbeProcessCount = getActiveProbeOperationCount;

async function readLimited(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (text.length < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return text;
}

// Null when ffprobe could not be run to an answer in time.
async function runFfprobe(
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
	const proc = registerSubprocess(
		spawn({ cmd: ["ffprobe", ...args], stdout: "pipe", stderr: "pipe" }),
	);
	const timer = setTimeout(() => {
		void terminateProcess(proc);
	}, FFPROBE_TIMEOUT_MS);
	try {
		const [stdout, stderr] = await Promise.all([
			readLimited(
				proc.stdout as ReadableStream<Uint8Array>,
				FFPROBE_OUTPUT_LIMIT,
			),
			readLimited(proc.stderr as ReadableStream<Uint8Array>, 8192),
		]);
		if (stdout.length >= FFPROBE_OUTPUT_LIMIT) {
			await terminateProcess(proc);
			return { exitCode: 0, stdout, stderr };
		}
		const exitCode = await proc.exited;
		return { exitCode, stdout, stderr };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		await terminateProcess(proc);
	}
}

// The parser names the codecs browsers play. A track in any other codec is
// named by ffprobe, which is held to the decoders this server allows: a file
// it may not open is refused here, with a reason, before any job is queued.
async function assertSupportedCodecs(
	path: string,
	metadata: VideoMetadata,
): Promise<void> {
	const unnamedVideo = metadata.videoCodec === "unknown";
	const unnamedAudio =
		metadata.audioCodec === null && metadata.audioChannels !== null;
	if (!unnamedVideo && !unnamedAudio) return;
	const result = await runFfprobe([
		"-v",
		"error",
		"-show_entries",
		"stream=codec_type,codec_name",
		"-of",
		"json",
		path,
	]);
	if (result === null) return;
	if (result.exitCode !== 0) {
		if (isDecoderRejectedMessage(result.stderr)) {
			throw new UnreadableMediaInputError(UNSUPPORTED_FORMAT_MESSAGE);
		}
		return;
	}
	if (!unnamedVideo) return;
	let streams: { codec_type?: string; codec_name?: string }[] = [];
	try {
		streams =
			(JSON.parse(result.stdout) as { streams?: typeof streams }).streams ?? [];
	} catch {
		return;
	}
	const video = streams.find((stream) => stream.codec_type === "video");
	if (video && !isAllowedVideoCodec(video.codec_name ?? "")) {
		throw new UnreadableMediaInputError(UNSUPPORTED_FORMAT_MESSAGE);
	}
}

const DURATION_TOLERANCE_SECONDS = 1;
const DURATION_TOLERANCE_RATIO = 0.01;

export function durationTolerance(declared: number): number {
	return Math.max(
		DURATION_TOLERANCE_SECONDS,
		declared * DURATION_TOLERANCE_RATIO,
	);
}

// Whether FFmpeg finds anything to decode past the declared end. An edit
// list hides the part of a file that was trimmed away, and FFmpeg honours
// it, so such a file really is as short as it declares. Null when unknown.
async function hasPacketsBeyond(
	path: string,
	declaredEnd: number,
	measuredEnd: number,
): Promise<boolean | null> {
	const result = await runFfprobe([
		"-v",
		"error",
		"-read_intervals",
		`${Math.max(0, measuredEnd - 1)}%`,
		"-show_entries",
		"packet=pts_time",
		"-of",
		"csv=p=0",
		path,
	]);
	if (result === null || (result.exitCode !== 0 && result.stdout === "")) {
		return null;
	}
	for (const line of result.stdout.split("\n")) {
		const time = Number.parseFloat(line);
		if (Number.isFinite(time) && time >= declaredEnd) return true;
	}
	return false;
}

// A header can declare a shorter length than the file plays for. The length
// reported is what the encoder will be held to and what is billed, so when
// the timestamps run past the declared end, and FFmpeg agrees there is video
// there, the measured length is the one reported.
async function withTrueDuration(
	path: string,
	probed: ProbedMedia,
): Promise<VideoMetadata> {
	const { metadata, declaredDuration, measuredDuration } = probed;
	if (declaredDuration === null || measuredDuration === null) return metadata;
	const declaredEnd = declaredDuration + durationTolerance(declaredDuration);
	if (measuredDuration <= declaredEnd) return metadata;
	if ((await hasPacketsBeyond(path, declaredEnd, measuredDuration)) === false) {
		return metadata;
	}
	return {
		...metadata,
		duration: measuredDuration,
		bitrate:
			probed.trackBitrate ||
			(metadata.fileSize > 0
				? Math.round((metadata.fileSize * 8) / measuredDuration)
				: 0),
	};
}

async function probeMetadata(path: string): Promise<VideoMetadata> {
	const probed = await runProbe("metadata", path, PROBE_TIMEOUT_MS);
	await assertSupportedCodecs(path, probed.metadata);
	return await withTrueDuration(path, probed);
}

export async function probeVideo(videoUrl: string): Promise<VideoMetadata> {
	const local = await materializeMedia(videoUrl);
	if (local) return probeVideoFile(local.path);
	if (!canAcceptNewProbeOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	return await withMediaOperation("probe", () => probeMetadata(videoUrl));
}

export async function probeVideoFile(filePath: string): Promise<VideoMetadata> {
	if (!canAcceptNewProbeOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	return await withMediaOperation("probe", () =>
		probeMetadata(normalizeLocalPath(filePath)),
	);
}

export async function probeTrackSpans(filePath: string): Promise<TrackSpans> {
	if (!canAcceptNewProbeOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	return await withMediaOperation("probe", () =>
		runProbe("trackSpans", normalizeLocalPath(filePath), PROBE_TIMEOUT_MS),
	);
}

export class ProbeBusyError extends Error {
	override name = "ProbeBusyError";

	constructor() {
		super("Server is busy, please try again later");
	}
}

// Reads the timestamp of every video frame in a local file, where the probe's
// own frame rate looks at the opening packets only. Null when the container
// is not one that can be timed cheaply.
export async function probeFastestFrameRate(
	filePath: string,
	abortSignal?: AbortSignal,
): Promise<number | null> {
	if (!canAcceptNewProbeOperation()) throw new ProbeBusyError();
	return await withMediaOperation("probe", () =>
		runProbe(
			"fastestFrameRate",
			normalizeLocalPath(filePath),
			PROBE_TIMEOUT_MS,
			abortSignal,
		),
	);
}

export async function checkVideoAccessible(videoUrl: string): Promise<boolean> {
	try {
		const response = await createGuardedMediaFetch(videoUrl)(videoUrl, {
			method: "HEAD",
			signal: AbortSignal.timeout(10_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}
