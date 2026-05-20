import type { AudioCodec, MediaCodec, VideoCodec } from "mediabunny";
import type { VideoMetadata } from "./job-manager";
import {
	createMediaInput,
	getSourceSize,
	normalizeLocalPath,
	withTimeout,
} from "./media-common";
import {
	canAcceptNewProbeOperation,
	getActiveProbeOperationCount,
	withMediaOperation,
} from "./media-operations";

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

async function hasHttpNetworkFailure(path: string): Promise<boolean> {
	try {
		await probeFetch(path, {
			method: "HEAD",
			signal: AbortSignal.timeout(10_000),
		});
		return false;
	} catch {
		return true;
	}
}

async function probeMedia(path: string): Promise<VideoMetadata> {
	if (isHttpUrl(path) && (await hasHttpNetworkFailure(path))) {
		throw new Error("Media input is not accessible");
	}

	const input = createMediaInput(path);

	try {
		const canRead = await input.canRead();
		if (!canRead) {
			throw new Error("Media input could not be read");
		}

		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("No video stream found");
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
