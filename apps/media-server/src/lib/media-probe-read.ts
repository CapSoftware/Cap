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
import { matroskaEndFromTail } from "./matroska-tail";
import { MediaAddressError } from "./media-address-guard";
import {
	createGuardedMediaFetch,
	createMediaInput,
	getSourceSize,
	isHlsPath,
	mediaInputRefusal,
	mediaInputTransportFailed,
} from "./media-common";
import {
	exceedsSourceFrameLimit,
	looksLikeTextContainer,
	MediaInputPolicyError,
} from "./media-input-policy";

// What the parser reads out of a file. It runs in a probe worker, never in
// the server process: see media-probe-pool.ts.

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

// The remote host did not hand over the file. status is the HTTP status it
// answered with, or null when there was no answer.
export class MediaInputNotAccessibleError extends Error {
	override name = "MediaInputNotAccessibleError";

	constructor(readonly status: number | null = null) {
		super("Media input is not accessible");
	}
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

const UNREADABLE_MESSAGE = "Media input could not be read";

// What a probe worker exits with when the parser throws outside a request.
export const PARSER_FAULT_EXIT_CODE = 70;

function isTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "TimeoutError" ||
			error.name === "AbortError" ||
			error.message.includes("timed out"))
	);
}

// Errors from reading the source itself rather than parsing it.
const sourceReadErrors = new WeakSet<object>();

function asSourceReadError(error: unknown): Error {
	const wrapped = error instanceof Error ? error : new Error(String(error));
	sourceReadErrors.add(wrapped);
	return wrapped;
}

// A parser that gives up on a file (an internal assertion, a field out of
// range) says the file cannot be read, and asking again gives the same
// answer. A source that could not be fetched, a refused address and a
// timeout say nothing about the file, so those pass through.
function asUnreadable(
	error: unknown,
	input: ReturnType<typeof createMediaInput>,
): unknown {
	if (
		(typeof error === "object" &&
			error !== null &&
			sourceReadErrors.has(error)) ||
		isUnreadableMediaInput(error) ||
		error instanceof MediaAddressError ||
		isTimeout(error) ||
		mediaInputTransportFailed(input)
	) {
		return error;
	}
	return new UnreadableMediaInputError(UNREADABLE_MESSAGE, { cause: error });
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
			throw new MediaInputNotAccessibleError(response.status);
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
			error instanceof MediaAddressError ||
			error instanceof MediaInputNotAccessibleError
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

export interface ProbedMedia {
	metadata: VideoMetadata;
	// What the container declares and what its timestamps span, when both
	// are known. metadata.duration is the declared length when there is one.
	declaredDuration: number | null;
	measuredDuration: number | null;
	// The bitrate the tracks report, 0 when they report none and
	// metadata.bitrate was worked out from the file size and duration.
	trackBitrate: number;
	// Whether the container can hide trimmed media behind an edit list, as
	// MP4 and QuickTime can, so a longer span may be real trimming.
	mayTrim: boolean;
}

export async function probeMedia(path: string): Promise<ProbedMedia> {
	if (isHttpUrl(path)) {
		const head = await readHttpHead(path);
		if (!head) throw new MediaInputNotAccessibleError();
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
		throw asUnreadable(error, input);
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

const MEASURE_BUDGET_MS = 3_000;

// A header can declare a length its timestamps do not have. Measuring costs
// nothing for an indexed file and a read of the tail otherwise; a file that
// would need more than that keeps its declared length, which the encoder is
// held to anyway.
async function measureWithinBudget(
	input: ReturnType<typeof createMediaInput>,
	budgetMs: number,
): Promise<number | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const measured = measureLength(input).catch(() => null);
	const budget = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), budgetMs);
	});
	try {
		const length = await Promise.race([measured, budget]);
		return length !== null && Number.isFinite(length) && length > 0
			? length
			: null;
	} finally {
		clearTimeout(timer);
	}
}

export const NO_VIDEO_STREAM_MESSAGE = "No video stream found";

export const UNFINISHED_RECORDING_MESSAGE =
	"This recording was not finished properly. Remux or export it, then upload it again.";

const UNDECLARED_MEASURE_BUDGET_MS = 5_000;

function isMatroskaFamily(format: InputFormat): boolean {
	return format === MATROSKA || format === WEBM;
}

// The length of a Matroska or WebM file from its last cluster, counted from
// its first timestamp. "blank" when the file ends in zero bytes, null when
// no cluster starts in its tail, undefined when the source cannot be read by
// range.
async function matroskaLengthFromTail(
	input: ReturnType<typeof createMediaInput>,
	path: string,
): Promise<number | "blank" | null | undefined> {
	const [end, start] = await Promise.all([
		matroskaEndFromTail(path).catch((error: unknown) => {
			throw asSourceReadError(error);
		}),
		input.getFirstTimestamp(),
	]);
	if (end === undefined || end === null || end === "blank") return end;
	if (!Number.isFinite(end) || end <= 0) return null;
	return Math.max(0, end - (Number.isFinite(start) && start > 0 ? start : 0));
}

// The length of a file whose container declares none. Matroska and WebM
// are measured by reading every cluster from the start, which for a large
// unfinalised recording takes as long as fetching the whole file, so the
// last cluster is read from the tail first. The full measure is still used
// when it finishes quickly, so a short recording keeps the length it has
// always had. Only a file whose length neither finds is refused as
// unfinished.
async function measureUndeclaredLength(
	input: ReturnType<typeof createMediaInput>,
	path: string,
): Promise<number> {
	if (!isMatroskaFamily(await input.getFormat())) {
		return await measureLength(input);
	}
	const fromTail = await matroskaLengthFromTail(input, path);
	if (fromTail === undefined) return await measureLength(input);
	// A file that ends in zero bytes was cut off, and reading through the
	// padding from the start would only run into the probe deadline.
	if (fromTail === "blank") {
		throw new UnreadableMediaInputError(UNFINISHED_RECORDING_MESSAGE);
	}
	// No cluster starting in the tail means the file was cut off, or that its
	// last cluster is larger than the tail read. The full measure decides.
	const measured = await measureWithinBudget(
		input,
		UNDECLARED_MEASURE_BUDGET_MS,
	);
	const length = measured ?? fromTail;
	if (length === null || length <= 0) {
		throw new UnreadableMediaInputError(UNFINISHED_RECORDING_MESSAGE);
	}
	return length;
}

// What the timestamps of a file that declares a length span. A Matroska or
// WebM file that cannot be measured within the budget is measured from its
// tail instead.
async function measureDeclaredLength(
	input: ReturnType<typeof createMediaInput>,
	path: string,
): Promise<number | null> {
	const measured = await measureWithinBudget(input, MEASURE_BUDGET_MS);
	if (measured !== null || !isMatroskaFamily(await input.getFormat())) {
		return measured;
	}
	const fromTail = await matroskaLengthFromTail(input, path).catch(() => null);
	return typeof fromTail === "number" && fromTail > 0 ? fromTail : null;
}

async function readMediaMetadata(
	input: ReturnType<typeof createMediaInput>,
	path: string,
): Promise<ProbedMedia> {
	const canRead = await input.canRead();
	if (!canRead) {
		throw new UnreadableMediaInputError("Media input could not be read");
	}

	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) {
		throw new UnreadableMediaInputError(NO_VIDEO_STREAM_MESSAGE);
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
	const declaredDuration = await input.getDurationFromMetadata(undefined, {
		skipLiveWait: true,
	});
	const measuredDuration =
		declaredDuration === null ? null : await measureDeclaredLength(input, path);
	const duration =
		declaredDuration ?? (await measureUndeclaredLength(input, path));
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
	const fileSize = await getSourceSize(path).catch((error: unknown) => {
		throw asSourceReadError(error);
	});
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
		timestampSpan: declaredDuration === null ? duration : measuredDuration,
	};
	const refusal = mediaInputRefusal(input);
	if (refusal) throw new MediaInputPolicyError(refusal);
	return {
		metadata,
		declaredDuration,
		measuredDuration,
		trackBitrate: Math.round(videoBitrate + audioBitrate),
		mayTrim: [MP4, QTFF].includes(await input.getFormat()),
	};
}

export type TrackSpans = { video: number; audio: number | null };

export async function computeTrackSpans(path: string): Promise<TrackSpans> {
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

export async function measureFastestFrameRate(
	path: string,
	signal?: AbortSignal,
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
			signal?.throwIfAborted();
			timestamps.push(packet.timestamp);
		}
		return fastestFrameRate(timestamps);
	} finally {
		input.dispose();
	}
}
