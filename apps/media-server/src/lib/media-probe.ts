import type {
	AudioCodec,
	InputTrack,
	MediaCodec,
	VideoCodec,
} from "mediabunny";
import type { VideoMetadata } from "./job-manager";
import {
	createMediaInput,
	getSourceSize,
	isHlsPath,
	normalizeLocalPath,
	withTimeout,
} from "./media-common";
import {
	looksLikeTextContainer,
	MediaInputPolicyError,
} from "./media-input-policy";
import {
	canAcceptNewProbeOperation,
	getActiveProbeOperationCount,
	withMediaOperation,
} from "./media-operations";
import { materializeMedia } from "./media-transfer";

const PROBE_TIMEOUT_MS = 30_000;
const probeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export { canAcceptNewProbeOperation, getActiveProbeOperationCount };

export const canAcceptNewProbeProcess = canAcceptNewProbeOperation;
export const getActiveProbeProcessCount = getActiveProbeOperationCount;

function mapVideoCodec(codec: VideoCodec | MediaCodec | null): string {
	if (codec === "avc") return "h264";
	if (codec === "hevc") return "hevc";
	return codec ?? "unknown";
}

function mapAudioCodec(codec: AudioCodec | MediaCodec | null): string | null {
	if (!codec) return null;
	return codec;
}

function roundFps(fps: number): number {
	if (!Number.isFinite(fps) || fps <= 0) return 0;
	return Math.round(fps * 100) / 100;
}

function isHttpUrl(path: string): boolean {
	try {
		const url = new URL(path);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

const SNIFF_BYTES = 4096;

// The input itself cannot be used, so asking again would give the same answer.
export class UnreadableMediaInputError extends Error {
	override name = "UnreadableMediaInputError";
}

export function isUnreadableMediaInput(error: unknown): boolean {
	return (
		error instanceof UnreadableMediaInputError ||
		error instanceof MediaInputPolicyError ||
		(error instanceof Error && error.name === "UnsupportedInputFormatError")
	);
}

// The first bytes of a remote input, an empty array for an empty file, or
// null when it cannot be fetched.
async function readHttpHead(path: string): Promise<Uint8Array | null> {
	try {
		const response = await probeFetch(path, {
			headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 416) {
			await response.body?.cancel();
			return new Uint8Array(0);
		}
		if (!response.ok) {
			await response.body?.cancel();
			return null;
		}
		const reader = response.body?.getReader();
		if (!reader) return new Uint8Array(0);
		const head = new Uint8Array(SNIFF_BYTES);
		let length = 0;
		while (length < SNIFF_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value.subarray(0, SNIFF_BYTES - length);
			head.set(chunk, length);
			length += chunk.length;
		}
		await reader.cancel().catch(() => {});
		return head.subarray(0, length);
	} catch {
		return null;
	}
}

async function probeMedia(path: string): Promise<VideoMetadata> {
	if (isHttpUrl(path)) {
		const head = await readHttpHead(path);
		if (!head) throw new Error("Media input is not accessible");
		if (head.length === 0) {
			throw new UnreadableMediaInputError("Media input is empty");
		}
		// A remote file that is really a playlist would have its entries fetched
		// by the demuxer. Only a URL that names itself a playlist may be one.
		if (!isHlsPath(path) && looksLikeTextContainer(head)) {
			throw new MediaInputPolicyError(
				"the file is a playlist or resource list, not a media file",
			);
		}
	}

	const input = createMediaInput(path);

	try {
		const canRead = await input.canRead();
		if (!canRead) {
			throw new UnreadableMediaInputError("Media input could not be read");
		}

		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new UnreadableMediaInputError("No video stream found");
		}

		const audioTrack = await input.getPrimaryAudioTrack();
		const duration =
			(await input.getDurationFromMetadata(undefined, {
				skipLiveWait: true,
			})) ??
			(await input.computeDuration(undefined, {
				skipLiveWait: true,
			}));
		const packetStats = await videoTrack
			.computePacketStats(120, { skipLiveWait: true })
			.catch(() => null);
		const videoBitrate =
			(await videoTrack.getAverageBitrate()) ??
			(await videoTrack.getBitrate()) ??
			packetStats?.averageBitrate ??
			0;
		const audioBitrate = audioTrack
			? ((await audioTrack.getAverageBitrate()) ??
				(await audioTrack.getBitrate()) ??
				0)
			: 0;
		const fileSize = await getSourceSize(path);
		const bitrateFromSize =
			duration > 0 && fileSize > 0 ? Math.round((fileSize * 8) / duration) : 0;

		return {
			duration,
			width: await videoTrack.getDisplayWidth(),
			height: await videoTrack.getDisplayHeight(),
			fps: roundFps(packetStats?.averagePacketRate ?? 0),
			videoCodec: mapVideoCodec(await videoTrack.getCodec()),
			audioCodec: mapAudioCodec((await audioTrack?.getCodec()) ?? null),
			audioChannels: audioTrack ? await audioTrack.getNumberOfChannels() : null,
			sampleRate: audioTrack ? await audioTrack.getSampleRate() : null,
			bitrate: Math.round(videoBitrate + audioBitrate) || bitrateFromSize,
			fileSize,
		};
	} finally {
		input.dispose();
	}
}

export async function probeVideo(videoUrl: string): Promise<VideoMetadata> {
	const local = await materializeMedia(videoUrl);
	if (local) return probeVideoFile(local.path);
	if (!canAcceptNewProbeOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	return await withMediaOperation("probe", () =>
		withTimeout(probeMedia(videoUrl), PROBE_TIMEOUT_MS),
	);
}

export async function probeVideoFile(filePath: string): Promise<VideoMetadata> {
	if (!canAcceptNewProbeOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	return await withMediaOperation("probe", () =>
		withTimeout(probeMedia(normalizeLocalPath(filePath)), PROBE_TIMEOUT_MS),
	);
}

export type TrackSpans = { video: number; audio: number | null };

async function computeTrackSpans(path: string): Promise<TrackSpans> {
	const input = createMediaInput(path);
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("No video stream found");
		}
		const audioTrack = await input.getPrimaryAudioTrack();
		const span = async (track: InputTrack) => {
			const [start, end] = await Promise.all([
				track.getFirstTimestamp(),
				track.computeDuration({ skipLiveWait: true }),
			]);
			return end - start;
		};
		const [video, audio] = await Promise.all([
			span(videoTrack),
			audioTrack ? span(audioTrack) : null,
		]);
		return { video, audio };
	} finally {
		input.dispose();
	}
}

export async function probeTrackSpans(filePath: string): Promise<TrackSpans> {
	if (!canAcceptNewProbeOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	return await withMediaOperation("probe", () =>
		withTimeout(
			computeTrackSpans(normalizeLocalPath(filePath)),
			PROBE_TIMEOUT_MS,
		),
	);
}

export async function checkVideoAccessible(videoUrl: string): Promise<boolean> {
	try {
		const response = await probeFetch(videoUrl, {
			method: "HEAD",
			signal: AbortSignal.timeout(10_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}
