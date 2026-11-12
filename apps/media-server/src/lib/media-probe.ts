import {
	type AudioCodec,
	EncodedPacketSink,
	type InputFormat,
	type InputTrack,
	MATROSKA,
	type MediaCodec,
	MP4,
	QTFF,
	type VideoCodec,
	WEBM,
} from "mediabunny";
import type { VideoMetadata } from "./job-manager";
import { MediaAddressError } from "./media-address-guard";
import {
	createGuardedMediaFetch,
	createMediaInput,
	getSourceSize,
	isHlsPath,
	mediaInputRefusal,
	normalizeLocalPath,
	withTimeout,
} from "./media-common";
import {
	exceedsSourceFrameLimit,
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

// Not a policy violation: those count against the uploader, and a camera
// original that is simply too big should not.
export const FRAME_TOO_LARGE_MESSAGE =
	"Video frame is larger than 8K, the largest size this server accepts";

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
		const response = await createGuardedMediaFetch(path)(path, {
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
	} catch (error) {
		if (
			error instanceof MediaInputPolicyError ||
			error instanceof MediaAddressError
		)
			throw error;
		return null;
	}
}

const MAX_PLAYLIST_BYTES = 1_000_000;
const MAX_NESTED_PLAYLISTS = 16;
const PLAYLIST_WALK_TIMEOUT_MS = 15_000;
const OFF_HOST_PLAYLIST =
	"a remote playlist may only reference files on its own host";

async function readBoundedText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (length < MAX_PLAYLIST_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		length += value.length;
	}
	await reader.cancel().catch(() => {});
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export function playlistReferences(playlist: string): string[] {
	const references: string[] = [];
	for (const raw of playlist.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (!line.startsWith("#")) {
			references.push(line);
			continue;
		}
		for (const match of line.matchAll(/URI="([^"]*)"/g)) {
			if (match[1]) references.push(match[1]);
		}
	}
	return references;
}

// Read before the demuxer sees a remote playlist, so one that names another
// host is refused without any of its entries being requested. Playlists it
// links to on its own host are checked the same way.
export async function assertRemotePlaylistStaysOnHost(
	rootUrl: string,
	timeoutMs = PLAYLIST_WALK_TIMEOUT_MS,
): Promise<void> {
	// One budget for the whole walk, shorter than the probe's own timeout, so
	// no request from it is still running once the probe has given up.
	const signal = AbortSignal.timeout(timeoutMs);
	const root = new URL(rootUrl);
	const fetchPlaylist = createGuardedMediaFetch(rootUrl);
	const queue = [rootUrl];
	const seen = new Set<string>();
	for (let current = queue.shift(); current; current = queue.shift()) {
		if (seen.has(current)) continue;
		seen.add(current);
		if (seen.size > MAX_NESTED_PLAYLISTS) {
			throw new MediaInputPolicyError(
				"the playlist links to too many other playlists",
			);
		}
		let playlist: string | null = null;
		try {
			const response = await fetchPlaylist(current, { signal });
			if (response.ok) playlist = await readBoundedText(response);
			else await response.body?.cancel().catch(() => {});
		} catch (error) {
			if (!signal.aborted) throw error;
			throw new Error(
				`Operation timed out after ${timeoutMs}ms reading the playlist`,
			);
		}
		if (playlist === null) continue;
		for (const reference of playlistReferences(playlist)) {
			let target: URL;
			try {
				target = new URL(reference, current);
			} catch {
				throw new MediaInputPolicyError(OFF_HOST_PLAYLIST);
			}
			if (target.origin !== root.origin) {
				throw new MediaInputPolicyError(OFF_HOST_PLAYLIST);
			}
			if (isHlsPath(target.href)) {
				if (!target.search) target.search = root.search;
				queue.push(target.href);
			}
		}
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
		if (isHlsPath(path)) await assertRemotePlaylistStaysOnHost(path);
	}

	const input = createMediaInput(path);

	try {
		return await readMediaMetadata(input, path);
	} catch (error) {
		const refusal = mediaInputRefusal(input);
		if (refusal) throw new MediaInputPolicyError(refusal);
		throw error;
	} finally {
		input.dispose();
	}
}

// The last timestamp is the length only for a file that starts at zero. A
// transport stream usually does not, so the length is counted from its first
// timestamp.
async function measureLength(
	input: ReturnType<typeof createMediaInput>,
): Promise<number> {
	const [start, end] = await Promise.all([
		input.getFirstTimestamp(),
		input.computeDuration(undefined, { skipLiveWait: true }),
	]);
	return Number.isFinite(start) && start > 0 ? Math.max(0, end - start) : end;
}

async function readMediaMetadata(
	input: ReturnType<typeof createMediaInput>,
	path: string,
): Promise<VideoMetadata> {
	const canRead = await input.canRead();
	if (!canRead) {
		throw new UnreadableMediaInputError("Media input could not be read");
	}

	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) {
		throw new UnreadableMediaInputError("No video stream found");
	}
	if (
		exceedsSourceFrameLimit(
			await videoTrack.getCodedWidth(),
			await videoTrack.getCodedHeight(),
		) ||
		exceedsSourceFrameLimit(
			await videoTrack.getDisplayWidth(),
			await videoTrack.getDisplayHeight(),
		)
	) {
		throw new UnreadableMediaInputError(FRAME_TOO_LARGE_MESSAGE);
	}

	const audioTrack = await input.getPrimaryAudioTrack();
	const duration =
		(await input.getDurationFromMetadata(undefined, {
			skipLiveWait: true,
		})) ?? (await measureLength(input));
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

	const metadata: VideoMetadata = {
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
	const refusal = mediaInputRefusal(input);
	if (refusal) throw new MediaInputPolicyError(refusal);
	return metadata;
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

const FASTEST_STRETCH_FRAMES = 8;
// Containers whose frame times come from an index or from cluster headers.
// Timing every frame of a transport stream means reading the whole file
// through the demuxer: 3 s and 770 MB of memory for a 1.5 GB file, against
// 11 ms for an MP4 of the same length.
const FRAME_TIMED_FORMATS: readonly InputFormat[] = [MP4, QTFF, MATROSKA, WEBM];

// The frame rate of the fastest run of consecutive frames. A run is long enough
// that two frames landing close together do not count, and short enough that
// a burst of motion a quarter of a second long does.
export function fastestFrameRate(timestamps: number[]): number | null {
	const times = [...timestamps].sort((a, b) => a - b);
	const run = Math.min(FASTEST_STRETCH_FRAMES, times.length - 1);
	if (run < 1) return null;
	let fastest = 0;
	for (let index = run; index < times.length; index++) {
		const seconds = (times[index] ?? 0) - (times[index - run] ?? 0);
		if (seconds > 0) fastest = Math.max(fastest, run / seconds);
	}
	const fps = roundFps(fastest);
	return fps > 0 ? fps : null;
}

async function measureFastestFrameRate(
	path: string,
	signal: AbortSignal,
): Promise<number | null> {
	const input = createMediaInput(path);
	try {
		if (!FRAME_TIMED_FORMATS.includes(await input.getFormat())) return null;
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) return null;
		const timestamps: number[] = [];
		const packets = new EncodedPacketSink(videoTrack).packets(
			undefined,
			undefined,
			{ metadataOnly: true, skipLiveWait: true },
		);
		for await (const packet of packets) {
			signal.throwIfAborted();
			timestamps.push(packet.timestamp);
		}
		return fastestFrameRate(timestamps);
	} finally {
		input.dispose();
	}
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
	const stopped = new AbortController();
	const signal = abortSignal
		? AbortSignal.any([abortSignal, stopped.signal])
		: stopped.signal;
	return await withMediaOperation("probe", () =>
		withTimeout(
			measureFastestFrameRate(normalizeLocalPath(filePath), signal),
			PROBE_TIMEOUT_MS,
			() => stopped.abort(),
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
