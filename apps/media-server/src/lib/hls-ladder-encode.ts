import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	buildHlsAudioArgs,
	buildHlsLadderArgs,
	HLS_LADDER_AUDIO_NAME,
	HLS_LADDER_MASTER_PLAYLIST,
	type HlsLadderRange,
	type HlsLadderRendition,
	type HlsLadderTierName,
	hlsLadderSourceFps,
	hlsRenditionsAreAligned,
	parseHlsLadderMaster,
	planHlsLadder,
} from "./hls-ladder";
import type { VideoMetadata } from "./job-manager";
import {
	decodeThreadsFromEnv,
	PROCESS_TIMEOUT_MS,
	type ProgressCallback,
} from "./media-common";
import { ProbeBusyError, probeFastestFrameRate } from "./media-probe";
import {
	getProcessTimeoutMs,
	requireVideoSourceTraits,
	runTranscodeCommand,
	sourceHasAudio,
} from "./media-video";
import {
	canDecodeOnGpu,
	logNvencFallback,
	nvencFallbackReason,
	nvencOptionsFromEnv,
	recordNvencAttempt,
} from "./nvenc-encoder";
import { ensureTempDir, getTempDir, retainTempPath } from "./temp-files";

const PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";
const MEDIA_CONTENT_TYPE = "video/mp4";

export interface HlsLadderFile {
	name: string;
	path: string;
	bytes: number;
	contentType: string;
}

export interface HlsLadderResult {
	encoder: "nvenc" | "libx264";
	renditions: (HlsLadderRendition & { bytes: number })[];
	audio: (HlsLadderRendition & { bytes: number }) | null;
}

export interface EncodedHlsLadder {
	files: HlsLadderFile[];
	result: HlsLadderResult;
	// The largest rendition and the length of video in it. A poster taken from
	// it has the colours viewers see, where the source may still be HDR.
	poster: { path: string; durationSeconds: number };
	cleanup: () => Promise<void>;
}

export interface EncodeHlsLadderOptions {
	maxTier?: HlsLadderTierName;
	range?: HlsLadderRange | null;
	includeAudio?: boolean;
}

async function ladderFile(
	dir: string,
	name: string,
	contentType: string,
): Promise<HlsLadderFile> {
	const path = join(dir, name);
	const { size } = await stat(path);
	if (size === 0) throw new Error(`HLS ladder produced an empty ${name}`);
	return { name, path, bytes: size, contentType };
}

export async function encodeHlsLadder(
	inputPath: string,
	metadata: VideoMetadata,
	options: EncodeHlsLadderOptions = {},
	onProgress?: ProgressCallback,
	abortSignal?: AbortSignal,
): Promise<EncodedHlsLadder> {
	abortSignal?.throwIfAborted();
	const probing = new AbortController();
	const probeSignal = abortSignal
		? AbortSignal.any([abortSignal, probing.signal])
		: probing.signal;
	const traits = requireVideoSourceTraits(inputPath, probeSignal);
	const frameTiming = probeFastestFrameRate(inputPath, probeSignal).catch(
		(error) => {
			// A full probe pool fails the job, as it does for the probe before
			// this one. Falling back would quietly encode a variable frame rate
			// source on its opening rate whenever the server is busy.
			if (error instanceof ProbeBusyError) throw error;
			if (!probeSignal.aborted) {
				console.warn(
					"[hls-ladder] Could not read frame timing, using the probed frame rate:",
					error,
				);
			}
			return null;
		},
	);
	const [{ rotation, hdr, hdrColor }, fastestFps] = await Promise.all([
		traits,
		frameTiming,
	]).catch(async (error) => {
		probing.abort();
		await Promise.allSettled([traits, frameTiming]);
		throw error;
	});
	abortSignal?.throwIfAborted();
	const rungs = planHlsLadder(
		{ width: metadata.width, height: metadata.height },
		{ maxTier: options.maxTier },
	);
	const range = options.range ?? null;
	const wantsAudio =
		sourceHasAudio(metadata) && (options.includeAudio ?? !range);
	const muxAudioWithVideo = wantsAudio && !range;

	await ensureTempDir();
	const dir = join(getTempDir(), `ladder-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	const release = retainTempPath(dir);
	const cleanup = async () => {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		release();
	};

	const work = new AbortController();
	const signal = abortSignal
		? AbortSignal.any([abortSignal, work.signal])
		: work.signal;
	const masterPath = join(dir, HLS_LADDER_MASTER_PLAYLIST);
	const sliceSeconds = range
		? (range.durationSeconds ??
			Math.max(0, metadata.duration - range.startSeconds))
		: metadata.duration;
	const timeoutMs = getProcessTimeoutMs(sliceSeconds, PROCESS_TIMEOUT_MS);
	const totalDurationUs = sliceSeconds * 1_000_000;
	const argsInput = {
		inputPath,
		outputDir: dir,
		videoCodec: metadata.videoCodec,
		hasAudio: muxAudioWithVideo,
		sourceFps: hlsLadderSourceFps(metadata.fps, fastestFps),
		rungs,
		range,
		hdr,
		hdrColor,
	};

	const encodeVideo = async (): Promise<"nvenc" | "libx264"> => {
		const nvenc = nvencOptionsFromEnv();
		if (nvenc) {
			const gpuDecode =
				hdr === null &&
				canDecodeOnGpu(metadata.videoCodec, rotation, nvenc.gpuDecodeCodecs);
			try {
				await runTranscodeCommand(
					buildHlsLadderArgs({
						...argsInput,
						decodeThreads: decodeThreadsFromEnv(
							"MEDIA_SERVER_PROCESS_DECODE_THREADS",
							0,
						),
						nvenc: { options: nvenc, gpuDecode },
					}),
					masterPath,
					totalDurationUs,
					timeoutMs,
					onProgress,
					signal,
				);
				recordNvencAttempt("process");
				return "nvenc";
			} catch (error) {
				const reason = nvencFallbackReason(error, signal.aborted);
				if (reason === null) throw error;
				recordNvencAttempt("process", reason);
				logNvencFallback({
					job: "process",
					sourceCodec: metadata.videoCodec,
					gpuDecode,
					reason,
				});
			}
		}
		await runTranscodeCommand(
			buildHlsLadderArgs({
				...argsInput,
				decodeThreads: decodeThreadsFromEnv(
					"MEDIA_SERVER_PROCESS_DECODE_THREADS",
					2,
				),
			}),
			masterPath,
			totalDurationUs,
			timeoutMs,
			onProgress,
			signal,
		);
		return "libx264";
	};

	try {
		const audioPlaylistName = `${HLS_LADDER_AUDIO_NAME}.m3u8`;
		const separateAudio =
			wantsAudio && range
				? runTranscodeCommand(
						buildHlsAudioArgs({ inputPath, outputDir: dir }),
						join(dir, audioPlaylistName),
						metadata.duration * 1_000_000,
						getProcessTimeoutMs(metadata.duration, PROCESS_TIMEOUT_MS),
						undefined,
						signal,
					)
				: Promise.resolve();
		const video = encodeVideo();
		const [encoder] = await Promise.all([video, separateAudio]).catch(
			async (error) => {
				work.abort();
				await Promise.allSettled([video, separateAudio]);
				throw error;
			},
		);
		abortSignal?.throwIfAborted();

		const master = parseHlsLadderMaster(await readFile(masterPath, "utf8"));
		if (master.video.length !== rungs.length) {
			throw new Error("HLS ladder is missing a rendition");
		}
		const playlists = await Promise.all(
			master.video.map((variant) =>
				readFile(join(dir, variant.playlist), "utf8"),
			),
		);
		if (!hlsRenditionsAreAligned(playlists)) {
			throw new Error("HLS ladder renditions are not cut at the same times");
		}

		const files: HlsLadderFile[] = [
			await ladderFile(dir, HLS_LADDER_MASTER_PLAYLIST, PLAYLIST_CONTENT_TYPE),
		];
		const renditions: HlsLadderResult["renditions"] = [];
		for (const variant of master.video) {
			const media = await ladderFile(dir, variant.media, MEDIA_CONTENT_TYPE);
			files.push(
				await ladderFile(dir, variant.playlist, PLAYLIST_CONTENT_TYPE),
				media,
			);
			renditions.push({ ...variant, bytes: media.bytes });
		}
		let audio: HlsLadderResult["audio"] = null;
		if (wantsAudio) {
			const media = await ladderFile(
				dir,
				`${HLS_LADDER_AUDIO_NAME}.m4s`,
				MEDIA_CONTENT_TYPE,
			);
			files.push(
				await ladderFile(dir, audioPlaylistName, PLAYLIST_CONTENT_TYPE),
				media,
			);
			audio = {
				name: HLS_LADDER_AUDIO_NAME,
				playlist: audioPlaylistName,
				media: media.name,
				width: null,
				height: null,
				bandwidth: null,
				averageBandwidth: null,
				codecs: null,
				bytes: media.bytes,
			};
		}
		const [top] = master.video;
		const posterFile = files.find((file) => file.name === top?.media);
		if (!posterFile) throw new Error("HLS ladder is missing a rendition");
		return {
			files,
			result: { encoder, renditions, audio },
			poster: { path: posterFile.path, durationSeconds: sliceSeconds },
			cleanup,
		};
	} catch (error) {
		await cleanup();
		abortSignal?.throwIfAborted();
		throw error;
	}
}
