import { randomBytes } from "node:crypto";
import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import type {
	DeveloperVideoPart,
	DeveloperVideoProcessingState,
	DeveloperVideoRendition,
	DeveloperVideoSlicedHls,
} from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { billableVideo } from "@/lib/developer-pricing";
import { lockInfraAccount } from "@/lib/infra-balance";
import { INFRA_RESOLUTION_TIERS } from "@/lib/infra-pricing";
import type { InfraDbExecutor } from "@/lib/infra-standing";
import { settleFirstMonthAtReady } from "@/lib/infra-storage-minimum";
import { VIDEO_TOO_LONG_MESSAGE } from "@/lib/infra-upload";
import { INFRA_SUPPORTED_VIDEO_FORMATS } from "@/lib/infra-video-formats";
import { cancelDeveloperVideoJobs } from "./developer-video-cancel";
import {
	chargeDeveloperVideoUpload,
	DEVELOPER_VIDEO_MAX_DURATION_SECONDS,
} from "./developer-video-charge";
import {
	createDeveloperEncodeId,
	createDeveloperPlaybackId,
	DEVELOPER_VIDEO_MASTER_PLAYLIST,
	developerVideoKeys,
	developerVideoSourceExtension,
	HLS_PLAYLIST_CONTENT_TYPE,
	hlsPlaylistDuration,
	ladderMatchesMaster,
	parseDeveloperVideoLadder,
	planDeveloperVideoEncode,
} from "./developer-video-plan";
import {
	parseDeveloperVideoSliceLadder,
	readStoredSlicePlaylist,
	slicedHlsKeys,
	slicedHlsMediaFiles,
	slicedHlsPlaylistFiles,
	slicedHlsPlaylistText,
} from "./developer-video-sliced-ladder";
import { HLS_AUDIO_NAME } from "./developer-video-sliced-playlist";
import {
	createSlicedHls,
	planDeveloperVideoSlices,
	playableSlices,
	SLICED_HLS,
	slicedFileName,
	slicedHlsRenditions,
	supersededSlicedHls,
} from "./developer-video-slices";
import {
	abandonSlicedHls,
	beginPart,
	beginSlices,
	completeSlicedHls,
	createDeveloperVideoProcessingState,
	DEVELOPER_VIDEO_PARTS,
	type DeveloperVideoPartAction,
	type DeveloperVideoPartOutcome,
	type DeveloperVideoRedrive,
	type DeveloperVideoSliceOutcome,
	developerVideoFailureReason,
	developerVideoPartAction,
	developerVideoRedrive,
	developerVideoStoredBytes,
	failUnfinishedParts,
	findRunningSlice,
	lostJobConfirmed,
	markPartChecked,
	markPartDispatched,
	markPartNotFound,
	markSliceChecked,
	markSliceDispatched,
	markSliceNotFound,
	releasePart,
	releaseSlice,
	requeueLostPart,
	requeueLostSlice,
	resolveDeveloperVideoStatus,
	retryUnavailableHls,
	settlePart,
	settleSlice,
	slicedHlsAction,
	slicedHlsEncoding,
	slicedHlsStep,
} from "./developer-video-state";
import {
	deleteDeveloperVideoObjects,
	developerVideoPrefix,
	developerVideoUploadUrl,
	headDeveloperVideoObject,
	internalDeveloperVideoUrl,
	readDeveloperVideoText,
	writeDeveloperVideoText,
} from "./developer-video-storage";
import { announceDeveloperVideoEvent } from "./developer-webhook-dispatch";
import {
	developerVideoEventStep,
	developerVideoReadyEventDue,
} from "./developer-webhook-events";
import {
	MEDIA_SERVER_SHUTDOWN_MESSAGE,
	readMediaServerVideoJob,
	startMediaServerVideoJob,
	tryProbeVideoViaMediaServer,
} from "./media-client";
import { sniffMediaUrl } from "./media-container";

type DeveloperVideoRow = typeof developerVideos.$inferSelect;
type DeveloperVideoUpdate = Partial<typeof developerVideos.$inferInsert>;

const MEDIA_SERVER_URL_EXPIRES_SECONDS = 3 * 60 * 60;
const LADDER_UNAVAILABLE_REASON =
	"Adaptive streaming is not available on the media server yet";

export interface DeveloperVideoClaim {
	action: DeveloperVideoRedrive;
	encodeId: string;
}

export type DeveloperVideoPreparation =
	| "ready"
	| "retry"
	| "stale"
	| "probing"
	| "unclear";

export type DeveloperVideoDispatch =
	| "dispatched"
	| "busy"
	| "unconfirmed"
	| "unavailable"
	| "failed"
	| "skipped";

export type DeveloperVideoJobCheck =
	| "skipped"
	| "unreachable"
	| "waiting"
	| "unconfirmed"
	| "requeued"
	| "settled";

export type DeveloperVideoPartSnapshot = Record<
	DeveloperVideoPart,
	DeveloperVideoPartAction
>;

async function mutateDeveloperVideo(
	videoId: string,
	mutate: (video: DeveloperVideoRow) => DeveloperVideoUpdate | null,
	executor?: InfraDbExecutor,
): Promise<DeveloperVideoRow | null> {
	let becameReady = false;
	const run = async (tx: InfraDbExecutor) => {
		const [video] = await tx
			.select()
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.for("update");
		if (!video) return null;
		const changes = mutate(video);
		if (!changes) return null;
		becameReady = video.status !== "ready" && changes.status === "ready";
		const event = developerVideoEventStep(
			video,
			{
				status: changes.status ?? video.status,
				processing:
					"processing" in changes
						? (changes.processing ?? null)
						: video.processing,
			},
			Date.now(),
		);
		const updates = event.processing
			? { ...changes, processing: event.processing }
			: changes;
		await tx
			.update(developerVideos)
			.set(updates)
			.where(eq(developerVideos.id, videoId));
		announceDeveloperVideoEvent(video, event);
		return { ...video, ...updates } as DeveloperVideoRow;
	};
	const updated = await (executor ? run(executor) : db().transaction(run));
	if (updated && becameReady) await settleFirstMonthAtReady(updated, executor);
	return updated;
}

async function mutateEncode(
	videoId: string,
	encodeId: string,
	mutate: (
		processing: DeveloperVideoProcessingState,
		video: DeveloperVideoRow,
	) => DeveloperVideoUpdate | null,
	executor?: InfraDbExecutor,
): Promise<DeveloperVideoRow | null> {
	return mutateDeveloperVideo(
		videoId,
		(video) =>
			video.deletedAt || video.processing?.encodeId !== encodeId
				? null
				: mutate(video.processing, video),
		executor,
	);
}

// The measured check and the write it guards run in one transaction under the
// app's account lock, the same lock an upload completion takes, so two videos
// measured at once cannot each pass against the other's declared size.
function underAccountLock<T>(
	appId: string,
	run: (tx: InfraDbExecutor) => Promise<T>,
): Promise<T> {
	return db().transaction(async (tx) => {
		await lockInfraAccount(tx, appId);
		return run(tx);
	});
}

function probedColumns(
	probe: DeveloperVideoProcessingState["probe"],
): DeveloperVideoUpdate {
	if (!probe) return {};
	return {
		width: probe.width,
		height: probe.height,
		fps: probe.fps,
		...(probe.duration === null ? {} : { duration: probe.duration }),
	};
}

function measuredColumnsToRestore(
	video: DeveloperVideoRow,
): DeveloperVideoUpdate | null {
	const measured = probedColumns(video.processing?.probe ?? null);
	const drifted = Object.entries(measured).some(
		([column, value]) => video[column as keyof DeveloperVideoRow] !== value,
	);
	return drifted ? measured : null;
}

function processingUpdate(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
): DeveloperVideoUpdate {
	return {
		processing,
		storedBytes: developerVideoStoredBytes(processing),
		...probedColumns(processing.probe),
		...resolveDeveloperVideoStatus(processing, video.status),
	};
}

// Every result of an encode job is written here, whether it is for a whole
// output or for one slice, so this is the one place a video first becomes
// ready or becomes errored: compare the row's status with the update's.
async function commitEncodeState(
	videoId: string,
	encodeId: string,
	change: (
		processing: DeveloperVideoProcessingState,
		video: DeveloperVideoRow,
	) => {
		processing: DeveloperVideoProcessingState;
		renditions?: DeveloperVideoRendition[];
	} | null,
	executor?: InfraDbExecutor,
): Promise<DeveloperVideoRow | null> {
	let discarded: string[] = [];
	const updated = await mutateEncode(
		videoId,
		encodeId,
		(processing, video) => {
			discarded = [];
			const next = change(processing, video);
			if (!next) return null;
			// Slices given up while others still encode: nothing takes their
			// results any more, so their workers are freed for the job that
			// replaces them.
			if (
				processing.sliced?.state === "encoding" &&
				next.processing.sliced?.state === "abandoned"
			) {
				discarded = next.processing.sliced.slices.flatMap(({ job }) =>
					job.state === "running" && job.jobId ? [job.jobId] : [],
				);
			}
			// Slices that were given up and could not be replaced leave no
			// adaptive stream, so the renditions they listed go with them.
			const withdrawn =
				next.processing.sliced?.state === "abandoned" &&
				(next.processing.hls.state === "failed" ||
					next.processing.hls.state === "unavailable");
			return {
				...processingUpdate(video, next.processing),
				...(next.renditions
					? { renditions: next.renditions }
					: withdrawn
						? { renditions: null }
						: {}),
			};
		},
		executor,
	);
	if (updated && discarded.length > 0) {
		await cancelDeveloperVideoJobs(videoId, discarded);
	}
	return updated;
}

function slicedHlsEnabled(): boolean {
	return serverEnv().INFRA_SLICED_HLS !== "off";
}

async function findDeveloperVideo(
	videoId: string,
): Promise<DeveloperVideoRow | null> {
	const [video] = await db()
		.select()
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId))
		.limit(1);
	return video ?? null;
}

async function findEncode(videoId: string, encodeId: string) {
	const video = await findDeveloperVideo(videoId);
	return video && !video.deletedAt && video.processing?.encodeId === encodeId
		? { video, processing: video.processing }
		: null;
}

function newAttemptToken(): string {
	return randomBytes(12).toString("base64url");
}

export async function claimDeveloperVideoProcessing(
	videoId: string,
	options: { uploadCompleted?: boolean } = {},
): Promise<DeveloperVideoClaim | null> {
	let claimed: DeveloperVideoClaim | null = null;
	await mutateDeveloperVideo(videoId, (video) => {
		const now = Date.now();
		const action = developerVideoRedrive(video, now, options);
		if (action === "start") {
			const encodeId = createDeveloperEncodeId();
			claimed = { action, encodeId };
			return {
				status: "processing",
				errorReason: null,
				renditions: null,
				playbackId: video.playbackId ?? createDeveloperPlaybackId(),
				processing: createDeveloperVideoProcessingState({ encodeId, now }),
			};
		}
		if (action === "retry-hls" && video.processing) {
			const processing = retryUnavailableHls(video.processing);
			if (!processing) return null;
			claimed = { action, encodeId: processing.encodeId };
			return { processing };
		}
		return measuredColumnsToRestore(video);
	});
	return claimed;
}

export async function releaseDeveloperVideoClaim(
	videoId: string,
	claim: DeveloperVideoClaim,
): Promise<void> {
	await mutateEncode(videoId, claim.encodeId, (processing, video) => {
		if (claim.action === "start") {
			return video.status === "processing"
				? { status: "uploading", processing: null }
				: null;
		}
		if (processing.hls.state !== "pending" || slicedHlsEncoding(processing)) {
			return null;
		}
		const token = newAttemptToken();
		const now = Date.now();
		const running = beginPart(processing, "hls", { token, now });
		const parked =
			running &&
			settlePart(running, "hls", token, {
				type: "unavailable",
				reason: LADDER_UNAVAILABLE_REASON,
				now,
			});
		return parked ? { processing: parked } : null;
	});
}

const PROBED_DURATION_TOLERANCE_SECONDS = 2;

// A video the app can't pay for, or one over the length limit. Anything else
// thrown while charging (a database blip) is left to the caller's retries.
// The upload itself is the problem and trying again would give the same
// answer. The message is written for the customer and shown as errorReason.
export class DeveloperVideoRejected extends Error {
	override name = "DeveloperVideoRejected";
}

const UNREADABLE_FILE = `This file could not be read as a video. Upload ${INFRA_SUPPORTED_VIDEO_FORMATS}.`;
const PLAYLIST_FILE =
	"This file is a playlist, not a video. Upload the video file itself.";
const UNENCODABLE_FILE =
	"This video could not be processed. Upload it again, or export it as an MP4 and upload that.";
const OVERSIZED_FILE =
	"This video is larger than 8K. Export it at 8K or smaller and upload that.";

// The media server's wording is for operators and can name internals, so the
// customer gets one of a few fixed sentences.
function fileProblem(message: string, fallback: string): string {
	if (/playlist|resource list/i.test(message)) {
		return PLAYLIST_FILE;
	}
	if (/no video (stream|track)/i.test(message)) {
		return "This file has no video track.";
	}
	if (/\bempty\b/i.test(message)) {
		return "The uploaded file is empty. Upload it again.";
	}
	if (/larger than 8K|max pixel count/i.test(message)) {
		return OVERSIZED_FILE;
	}
	return fallback;
}

// A probe error only proves the file is bad when the media server says so
// (422) or names a problem with the file. Anything else may be a storage or
// server fault that clears up, so it must not end the video.
const FILE_PROBLEM =
	/playlist|resource list|could not be read|unsupported or unrecognizable format|no video (stream|track)|input is empty|larger than 8K/i;

function probeFoundFileProblem(probed: {
	message: string;
	unusable: boolean;
}): boolean {
	return probed.unusable || FILE_PROBLEM.test(probed.message);
}

export function isDeveloperVideoRefusal(
	error: unknown,
): error is DeveloperVideoRejected | DeveloperVideoChargeRefused {
	return (
		error instanceof DeveloperVideoRejected ||
		error instanceof DeveloperVideoChargeRefused
	);
}

export class DeveloperVideoChargeRefused extends Error {
	override name = "DeveloperVideoChargeRefused";
}

// An upload is admitted on the length and size the client reported. Once the
// server has measured the real ones, a longer or higher-tier video is admitted
// again on those before encoding, and one the app's balance cannot cover is
// not encoded. Nothing is charged here: storage is billed daily once ready.
export async function chargeForProbedDuration(
	video: Pick<
		DeveloperVideoRow,
		"id" | "appId" | "duration" | "width" | "height" | "maxResolutionTier"
	>,
	probedDuration: number | null,
	probedSize?: { width: number; height: number },
	executor?: InfraDbExecutor,
): Promise<void> {
	if (probedDuration === null) return;
	if (probedDuration > DEVELOPER_VIDEO_MAX_DURATION_SECONDS) {
		throw new DeveloperVideoChargeRefused(VIDEO_TOO_LONG_MESSAGE);
	}
	const billed = video.duration ?? 0;
	const size = probedSize ?? {
		width: video.width ?? 0,
		height: video.height ?? 0,
	};
	const tierOf = (width: number, height: number) =>
		INFRA_RESOLUTION_TIERS.indexOf(
			billableVideo({
				duration: 1,
				width,
				height,
				maxResolutionTier: video.maxResolutionTier,
			})?.tier ?? "1080p",
		);
	if (
		probedDuration <= billed + PROBED_DURATION_TOLERANCE_SECONDS &&
		tierOf(size.width, size.height) <=
			tierOf(video.width ?? 0, video.height ?? 0)
	) {
		return;
	}
	const charged = await chargeDeveloperVideoUpload({
		appId: video.appId,
		videoId: video.id,
		durationSeconds: probedDuration,
		width: size.width,
		height: size.height,
		maxResolutionTier: video.maxResolutionTier,
		metadata: {
			durationSeconds: probedDuration,
			reportedDurationSeconds: billed,
			source: "probe",
		},
		executor,
	});
	if (charged !== "charged") {
		throw new DeveloperVideoChargeRefused(
			typeof charged === "object"
				? charged.refused
				: "Not enough credit for the video's full length",
		);
	}
}

const PROBE_CLAIM_MS = 60_000;

// The request that completes an upload and the workflow both prepare a video.
// Whoever takes this claim probes the file; the other waits for the result
// and never asks the media server for the same probe. A claim left behind by
// a caller that stopped can be taken over after a minute.
async function claimProbe(
	videoId: string,
	encodeId: string,
	token: string,
): Promise<DeveloperVideoRow | null> {
	return mutateEncode(videoId, encodeId, (processing) => {
		if (processing.probe) return null;
		const held = processing.probing;
		const now = Date.now();
		if (held && now - held.startedAt < PROBE_CLAIM_MS) return null;
		return {
			processing: { ...processing, probing: { token, startedAt: now } },
		};
	});
}

async function releaseProbe(
	videoId: string,
	encodeId: string,
	token: string,
): Promise<void> {
	await mutateEncode(videoId, encodeId, (processing) => {
		if (processing.probing?.token !== token) return null;
		const { probing: _probing, ...rest } = processing;
		return { processing: rest };
	});
}

const SNIFF_TIMEOUT_MS = 5_000;
const PROBE_CLAIM_RENEW_AFTER_MS = 1_000;

async function renewProbe(
	videoId: string,
	encodeId: string,
	token: string,
): Promise<boolean> {
	const renewed = await mutateEncode(videoId, encodeId, (processing) => {
		if (processing.probe || processing.probing?.token !== token) return null;
		return {
			processing: {
				...processing,
				probing: { token, startedAt: Date.now() },
			},
		};
	});
	return renewed !== null;
}

async function preparationWithoutClaim(
	videoId: string,
	encodeId: string,
): Promise<DeveloperVideoPreparation> {
	const latest = await findEncode(videoId, encodeId);
	if (!latest) return "stale";
	return latest.processing.probe ? "ready" : "probing";
}

type DeveloperVideoSource = { contentType: string | null } | null;

export async function prepareDeveloperVideoProcessing(
	videoId: string,
	encodeId: string,
	seen: { source?: DeveloperVideoSource } = {},
): Promise<DeveloperVideoPreparation> {
	const encode = await findEncode(videoId, encodeId);
	if (!encode || encode.video.status === "errored") return "stale";
	if (encode.processing.probe) return "ready";

	const token = newAttemptToken();
	const video = await claimProbe(videoId, encodeId, token);
	if (!video) return preparationWithoutClaim(videoId, encodeId);
	const claimedAt = Date.now();

	try {
		if (!video.s3Key) {
			throw new DeveloperVideoRejected(
				"This video has no uploaded file. Upload it again.",
			);
		}

		const source = await headDeveloperVideoObject(video.s3Key);
		if (!source) {
			throw new DeveloperVideoRejected(
				"The uploaded file was not found. Upload it again.",
			);
		}
		seen.source = source;
		if (source.bytes === 0) {
			throw new DeveloperVideoRejected(
				"The uploaded file is empty. Upload it again.",
			);
		}
		const sourceUrl = await internalDeveloperVideoUrl(
			video.s3Key,
			MEDIA_SERVER_URL_EXPIRES_SECONDS,
		);
		const sniffed = await sniffMediaUrl(sourceUrl, SNIFF_TIMEOUT_MS).catch(
			(error) => {
				console.warn(
					"[developer-video] Could not read the upload's first bytes",
					{
						videoId,
						message: error instanceof Error ? error.message : String(error),
					},
				);
				return null;
			},
		);
		if (sniffed === "playlist") {
			throw new DeveloperVideoRejected(PLAYLIST_FILE);
		}
		if (sniffed === "unknown") {
			throw new DeveloperVideoRejected(UNREADABLE_FILE);
		}
		if (
			Date.now() - claimedAt > PROBE_CLAIM_RENEW_AFTER_MS &&
			!(await renewProbe(videoId, encodeId, token))
		) {
			return preparationWithoutClaim(videoId, encodeId);
		}
		const probed = await tryProbeVideoViaMediaServer(sourceUrl);
		if (probed.status === "unreachable") {
			await releaseProbe(videoId, encodeId, token);
			return "retry";
		}
		if (probed.status === "timed_out") {
			await releaseProbe(videoId, encodeId, token);
			return "unclear";
		}
		if (probed.status === "rejected") {
			console.warn("[developer-video] Probe rejected the upload", {
				videoId,
				message: developerVideoFailureReason(probed.message),
				unusable: probed.unusable,
			});
			if (!probeFoundFileProblem(probed)) {
				await releaseProbe(videoId, encodeId, token);
				return "unclear";
			}
			throw new DeveloperVideoRejected(
				fileProblem(probed.message, UNREADABLE_FILE),
			);
		}
		const { metadata } = probed;
		if (!(metadata.width > 0) || !(metadata.height > 0)) {
			throw new DeveloperVideoRejected("This file has no video track.");
		}
		const probedDuration =
			Number.isFinite(metadata.duration) && metadata.duration > 0
				? metadata.duration
				: null;
		const slices = slicedHlsEnabled()
			? planDeveloperVideoSlices(probedDuration)
			: null;
		const updated = await underAccountLock(video.appId, async (tx) => {
			await chargeForProbedDuration(
				video,
				probedDuration,
				{ width: metadata.width, height: metadata.height },
				tx,
			);
			return mutateEncode(
				videoId,
				encodeId,
				({ probing: _probing, ...processing }, current) =>
					processingUpdate(current, {
						...processing,
						...(slices
							? { sliced: createSlicedHls(slices, newAttemptToken()) }
							: {}),
						probe: {
							duration: probedDuration,
							width: metadata.width,
							height: metadata.height,
							fps:
								Number.isFinite(metadata.fps) && metadata.fps > 0
									? Math.round(metadata.fps)
									: null,
						},
						bytes: { ...processing.bytes, source: source.bytes },
					}),
				tx,
			);
		});
		return updated ? "ready" : "stale";
	} catch (error) {
		await releaseProbe(videoId, encodeId, token).catch(() => {});
		throw error;
	}
}

// The processing workflow polls a ready video until its outputs settle, and
// each poll sends a due video.ready. A stuck output holds it back for at most
// READY_EVENT_MAX_WAIT_MS and one poll, and a marked video whose last output
// was settled by a write that did not send still gets it on the final poll.
export async function sendDueDeveloperVideoReady(
	videoId: string,
): Promise<void> {
	await mutateDeveloperVideo(videoId, (video) =>
		!video.deletedAt &&
		video.processing &&
		developerVideoReadyEventDue(video, Date.now())
			? { processing: video.processing }
			: null,
	);
}

export async function readDeveloperVideoParts(
	videoId: string,
	encodeId: string,
): Promise<DeveloperVideoPartSnapshot | null> {
	const encode = await findEncode(videoId, encodeId);
	if (!encode) return null;
	const now = Date.now();
	const sliced = slicedHlsEncoding(encode.processing);
	const parts: DeveloperVideoPartSnapshot = {
		hls: sliced
			? slicedHlsAction(sliced, now)
			: developerVideoPartAction(encode.processing.hls, now),
		mp4: developerVideoPartAction(encode.processing.mp4, now),
	};
	if (!developerVideoReadyEventDue(encode.video, now)) return parts;
	// Thrown out of this step, a failure here would fail the video's
	// processing. Finished parts are reported as waiting instead, so the
	// workflow polls again rather than ending with the event unsent.
	try {
		await sendDueDeveloperVideoReady(videoId);
		return parts;
	} catch (error) {
		console.error("[developer-webhook] Failed to send a due event", {
			videoId,
			message: error instanceof Error ? error.message : String(error),
		});
		const waiting = (action: DeveloperVideoPartAction) =>
			action === "done" ? "wait" : action;
		return { hls: waiting(parts.hls), mp4: waiting(parts.mp4) };
	}
}

function webhookUrl(part: DeveloperVideoPart, token: string): string {
	const base = serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;
	const query = new URLSearchParams({ developerVideo: part, token });
	return `${base}/api/webhooks/media-server/progress?${query.toString()}`;
}

async function buildJobRequest(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	token: string,
	knownSource?: DeveloperVideoSource,
): Promise<{
	path: "/video/ladder" | "/video/process";
	body: Record<string, unknown>;
}> {
	if (!video.s3Key || !processing.probe) {
		throw new Error("Video is missing its source or dimensions");
	}
	const keys = developerVideoKeys(video, processing.encodeId, token);
	const plan = planDeveloperVideoEncode(
		{ width: processing.probe.width, height: processing.probe.height },
		video.maxResolutionTier,
	);
	const expiresIn = MEDIA_SERVER_URL_EXPIRES_SECONDS;
	const [source, videoUrl, thumbnailPresignedUrl, outputPresignedUrl, uploads] =
		await Promise.all([
			knownSource === undefined
				? headDeveloperVideoObject(video.s3Key)
				: knownSource,
			internalDeveloperVideoUrl(video.s3Key, expiresIn),
			developerVideoUploadUrl(keys.poster, "image/jpeg", expiresIn),
			part === "mp4"
				? developerVideoUploadUrl(keys.mp4, "video/mp4", expiresIn)
				: null,
			part === "hls"
				? Promise.all(
						plan.uploads.map(
							async (upload) =>
								[
									upload.name,
									await developerVideoUploadUrl(
										`${keys.hlsPrefix}${upload.name}`,
										upload.contentType,
										expiresIn,
									),
								] as const,
						),
					).then(Object.fromEntries)
				: null,
		]);
	const inputExtension = developerVideoSourceExtension(source?.contentType);
	const common = {
		videoId: video.id,
		userId: video.appId,
		videoUrl,
		thumbnailPresignedUrl,
		webhookUrl: webhookUrl(part, token),
		...(inputExtension ? { inputExtension } : {}),
		// Lets the media server keep room for Cap's own recordings.
		infra: true,
	};

	if (part === "mp4") {
		return {
			path: "/video/process",
			body: {
				...common,
				outputPresignedUrl,
				maxWidth: plan.mp4MaxDimension,
				maxHeight: plan.mp4MaxDimension,
			},
		};
	}

	return {
		path: "/video/ladder",
		body: {
			...common,
			maxTier: plan.ladderMaxTier,
			includeAudio: true,
			uploads,
		},
	};
}

async function settleDeveloperVideoPart(
	videoId: string,
	encodeId: string,
	part: DeveloperVideoPart,
	token: string,
	outcome: DeveloperVideoPartOutcome,
	renditions?: DeveloperVideoRendition[],
	executor?: InfraDbExecutor,
): Promise<boolean> {
	const updated = await commitEncodeState(
		videoId,
		encodeId,
		(processing) => {
			const settled = settlePart(processing, part, token, outcome);
			return settled && { processing: settled, renditions };
		},
		executor,
	);
	return updated !== null;
}

export async function dispatchDeveloperVideoPart(
	videoId: string,
	encodeId: string,
	part: DeveloperVideoPart,
): Promise<DeveloperVideoDispatch> {
	if (part === "hls") {
		const sliced = await advanceSlicedHls(videoId, encodeId);
		if (sliced !== null) return sliced;
	}
	const token = newAttemptToken();
	const video = await mutateEncode(videoId, encodeId, (processing) => {
		if (part === "hls" && slicedHlsEncoding(processing)) return null;
		const started = beginPart(processing, part, { token, now: Date.now() });
		return started ? { processing: started } : null;
	});
	if (!video?.processing) return "skipped";
	return sendDeveloperVideoPart(video, video.processing, part, token);
}

export async function dispatchDeveloperVideoParts(
	videoId: string,
	encodeId: string,
	knownSource?: DeveloperVideoSource,
): Promise<PromiseSettledResult<DeveloperVideoDispatch>[]> {
	let tokens: [DeveloperVideoPart, string][] = [];
	const video = await mutateEncode(videoId, encodeId, (processing) => {
		const now = Date.now();
		tokens = [];
		let next = processing;
		for (const part of DEVELOPER_VIDEO_PARTS) {
			if (part === "hls" && slicedHlsEncoding(next)) continue;
			const token = newAttemptToken();
			const started = beginPart(next, part, { token, now });
			if (!started) continue;
			next = started;
			tokens.push([part, token]);
		}
		return tokens.length > 0 ? { processing: next } : null;
	});
	const processing = video?.processing;
	const slices = async (): Promise<DeveloperVideoDispatch> =>
		(await advanceSlicedHls(videoId, encodeId)) ?? "skipped";
	if (!video || !processing) {
		const encode = await findEncode(videoId, encodeId);
		return encode && slicedHlsEncoding(encode.processing)
			? Promise.allSettled([slices()])
			: [];
	}
	const source =
		knownSource === undefined && tokens.length > 1 && video.s3Key
			? await headDeveloperVideoObject(video.s3Key)
			: knownSource;
	const send = ([part, token]: [DeveloperVideoPart, string]) =>
		sendDeveloperVideoPart(video, processing, part, token, source);
	if (!slicedHlsEncoding(processing)) {
		return Promise.allSettled(tokens.map(send));
	}
	// The MP4 goes out before the slices: a worker making an Infra MP4 turns
	// slices away, so the slices that follow land on the other workers and the
	// MP4 runs on its own, as it does beside a whole-video ladder.
	const mp4 = await Promise.allSettled(
		tokens.filter(([part]) => part === "mp4").map(send),
	);
	return [
		...mp4,
		...(await Promise.allSettled([
			...tokens.filter(([part]) => part !== "mp4").map(send),
			slices(),
		])),
	];
}

async function sendDeveloperVideoPart(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	token: string,
	knownSource?: DeveloperVideoSource,
): Promise<DeveloperVideoDispatch> {
	const videoId = video.id;
	const { encodeId } = processing;
	const request = await buildJobRequest(
		video,
		processing,
		part,
		token,
		knownSource,
	);
	const started = await startMediaServerVideoJob(request.path, request.body);

	if (started.status === "started") {
		const recorded = await mutateEncode(videoId, encodeId, (processing) => {
			const dispatched = markPartDispatched(processing, part, {
				token,
				jobId: started.jobId,
			});
			return dispatched ? { processing: dispatched } : null;
		});
		if (!recorded && (await findDeveloperVideo(videoId))?.deletedAt) {
			await cancelDeveloperVideoJobs(videoId, [started.jobId]);
		}
		return "dispatched";
	}
	if (started.status === "unconfirmed") return "unconfirmed";
	if (started.status === "busy" || started.status === "unreachable") {
		await mutateEncode(videoId, encodeId, (processing) => {
			const released = releasePart(processing, part, token);
			return released
				? { processing: { ...released, busyAt: Date.now() } }
				: null;
		});
		return "busy";
	}
	if (started.status === "unavailable" && part === "hls") {
		await settleDeveloperVideoPart(videoId, encodeId, part, token, {
			type: "unavailable",
			reason: LADDER_UNAVAILABLE_REASON,
			now: Date.now(),
		});
		return "unavailable";
	}
	if (started.status === "rejected") {
		console.warn("[developer-video] Encode start rejected", {
			videoId,
			part,
			detail: developerVideoFailureReason(started.message),
		});
	}
	await settleDeveloperVideoPart(videoId, encodeId, part, token, {
		type: "failed",
		reason:
			started.status === "rejected"
				? fileProblem(started.message, UNENCODABLE_FILE)
				: "Video processing is not available on the media server",
	});
	return "failed";
}

async function requeueLostDeveloperVideoPart(
	videoId: string,
	encodeId: string,
	part: DeveloperVideoPart,
	token: string,
): Promise<boolean> {
	const requeued = await mutateEncode(videoId, encodeId, (processing) => {
		const next = requeueLostPart(processing, part, token);
		return next ? { processing: next } : null;
	});
	return requeued !== null;
}

// Asks the media server about a job that has gone quiet. A finished job is
// settled by applyDeveloperVideoProgress with the job's own report, which is
// the same body its webhook carries, so both routes store the same result.
export async function checkDeveloperVideoPart(
	videoId: string,
	encodeId: string,
	part: DeveloperVideoPart,
): Promise<DeveloperVideoJobCheck> {
	if (part === "hls" && (await advanceSlicedHls(videoId, encodeId)) !== null) {
		return "waiting";
	}
	const encode = await findEncode(videoId, encodeId);
	const current = encode?.processing[part];
	if (
		current?.state !== "running" ||
		current.jobId === null ||
		developerVideoPartAction(current, Date.now()) !== "check"
	) {
		return "skipped";
	}
	const { token } = current;

	const job = await readMediaServerVideoJob(current.jobId, videoId);
	if (job.status === "unreachable") return "unreachable";
	if (job.status === "finished") {
		const { applied } = await applyDeveloperVideoProgress(
			job.progress,
			part,
			token,
		);
		return applied ? "settled" : "skipped";
	}
	const now = Date.now();
	let result = "skipped" as DeveloperVideoJobCheck;
	await mutateEncode(videoId, encodeId, (processing) => {
		const latest = processing[part];
		if (latest.state !== "running" || latest.token !== token) return null;
		if (job.status === "missing" && !lostJobConfirmed(latest, now)) {
			result = "unconfirmed";
			const marked = markPartNotFound(processing, part, { token, now });
			return marked ? { processing: marked } : null;
		}
		const requeued =
			job.status === "missing"
				? requeueLostPart(processing, part, token)
				: null;
		result = requeued ? "requeued" : "waiting";
		const next = requeued ?? markPartChecked(processing, part, { token, now });
		return next ? { processing: next } : null;
	});
	if (result === "requeued") {
		console.warn("[developer-video] Encode job was lost, sending it again", {
			videoId,
			part,
		});
	}
	return result;
}

export async function failDeveloperVideoProcessing(
	videoId: string,
	encodeId: string,
	reason: string,
): Promise<void> {
	await commitEncodeState(videoId, encodeId, (processing) => ({
		processing: failUnfinishedParts(processing, reason),
	}));
}

interface DeveloperVideoProgressPayload {
	videoId?: unknown;
	jobId?: unknown;
	phase?: unknown;
	error?: unknown;
	message?: unknown;
	ladder?: unknown;
	metadata?: unknown;
}

const UNMEASURED_OUTPUT = {
	outcome: {
		type: "failed" as const,
		reason: "Encoded output has no measurable duration",
	},
};

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function outputDuration(payload: DeveloperVideoProgressPayload) {
	const metadata = payload.metadata;
	return metadata && typeof metadata === "object" && "duration" in metadata
		? positiveNumber(metadata.duration)
		: undefined;
}

async function completedOutcome(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	token: string,
	payload: DeveloperVideoProgressPayload,
): Promise<{
	outcome: DeveloperVideoPartOutcome;
	renditions?: DeveloperVideoRendition[];
}> {
	const keys = developerVideoKeys(video, processing.encodeId, token);
	const needsDuration = processing.probe?.duration == null;

	if (part === "mp4") {
		const [poster, output] = await Promise.all([
			headDeveloperVideoObject(keys.poster),
			headDeveloperVideoObject(keys.mp4),
		]);
		const posterBytes = poster?.bytes ?? 0;
		if (!output || output.bytes === 0) {
			return {
				outcome: { type: "failed", reason: "Encoded MP4 was not stored" },
			};
		}
		const duration = needsDuration ? outputDuration(payload) : undefined;
		if (needsDuration && !duration) return UNMEASURED_OUTPUT;
		return {
			outcome: {
				type: "complete",
				bytes: output.bytes,
				posterBytes,
				duration,
			},
		};
	}

	const ladder = parseDeveloperVideoLadder(payload.ladder);
	if (!ladder) {
		return {
			outcome: { type: "failed", reason: "Encoder reported no renditions" },
		};
	}
	const [poster, master] = await Promise.all([
		headDeveloperVideoObject(keys.poster),
		readDeveloperVideoText(
			`${keys.hlsPrefix}${DEVELOPER_VIDEO_MASTER_PLAYLIST}`,
		),
	]);
	const posterBytes = poster?.bytes ?? 0;
	if (!master || !ladderMatchesMaster(ladder.renditions, master)) {
		return {
			outcome: {
				type: "failed",
				reason: "Stored master playlist does not match the encoded renditions",
			},
		};
	}
	let duration: number | undefined;
	if (needsDuration) {
		const top = ladder.renditions[0];
		const playlist = top
			? await readDeveloperVideoText(`${keys.hlsPrefix}${top.name}.m3u8`)
			: null;
		duration = positiveNumber(playlist ? hlsPlaylistDuration(playlist) : 0);
		if (!duration) return UNMEASURED_OUTPUT;
	}
	return {
		outcome: { type: "complete", bytes: ladder.bytes, posterBytes, duration },
		renditions: ladder.renditions,
	};
}

// A slice that has just been settled frees a place for the next one, and the
// last one in is the cue to write the whole ladder. Doing that here, and not
// at the workflow's next look, keeps the workers busy between slices.
export async function applyDeveloperVideoProgress(
	payload: DeveloperVideoProgressPayload,
	partParam: string,
	token: string | null,
): Promise<{ success: true; applied: boolean }> {
	const result = await applyEncodeProgress(payload, partParam, token);
	if (result.slice && result.applied && typeof payload.videoId === "string") {
		try {
			await advanceSlicedHls(payload.videoId, result.slice.encodeId);
		} catch (error) {
			console.error("[developer-video] Failed to move the slices on", {
				videoId: payload.videoId,
				error,
			});
		}
	}
	return { success: true, applied: result.applied };
}

async function applyEncodeProgress(
	payload: DeveloperVideoProgressPayload,
	partParam: string,
	token: string | null,
): Promise<{
	success: true;
	applied: boolean;
	slice?: { encodeId: string };
}> {
	const ignored = { success: true as const, applied: false };
	if (
		(partParam !== "hls" && partParam !== "mp4") ||
		!token ||
		typeof payload.videoId !== "string"
	) {
		return ignored;
	}
	const part: DeveloperVideoPart = partParam;

	const video = await findDeveloperVideo(payload.videoId);
	const processing = video?.processing;
	const whole = processing?.[part];
	const slice =
		part === "hls" && processing ? findRunningSlice(processing, token) : null;
	const current =
		whole?.state === "running" && whole.token === token
			? whole
			: (slice?.job ?? null);
	if (!video || !processing || !current) return ignored;
	const { encodeId } = processing;
	const finished =
		payload.phase === "complete" ||
		payload.phase === "error" ||
		payload.phase === "cancelled";

	// A deleted video's job is stopped, never settled: its result could
	// otherwise requeue, retry or charge for a video nobody can see. This also
	// catches a job whose start was never confirmed, so its id was never stored
	// for the delete to cancel.
	if (video.deletedAt) {
		if (!finished && typeof payload.jobId === "string" && payload.jobId) {
			await cancelDeveloperVideoJobs(video.id, [payload.jobId]);
		}
		return ignored;
	}

	if (!finished) {
		const jobId = payload.jobId;
		if (current.jobId === null && typeof jobId === "string" && jobId) {
			const recorded = await mutateEncode(video.id, encodeId, (latest) => {
				const confirmed = slice
					? markSliceDispatched(latest, { token, jobId })
					: markPartDispatched(latest, part, { token, jobId });
				return confirmed ? { processing: confirmed } : null;
			});
			// A delete that committed after this callback read the video found
			// no job id to cancel, so the job would run to the end.
			if (!recorded && (await findDeveloperVideo(video.id))?.deletedAt) {
				await cancelDeveloperVideoJobs(video.id, [jobId]);
			}
		}
		return ignored;
	}

	if (slice) {
		const settled = await applySliceResult(
			video,
			processing,
			slice,
			token,
			payload,
		);
		return { ...settled, slice: { encodeId } };
	}

	if (
		payload.phase === "cancelled" &&
		payload.message === MEDIA_SERVER_SHUTDOWN_MESSAGE &&
		(await requeueLostDeveloperVideoPart(video.id, encodeId, part, token))
	) {
		return { success: true, applied: true };
	}

	if (payload.phase !== "complete") {
		const detail =
			(typeof payload.error === "string" && payload.error) ||
			(typeof payload.message === "string" && payload.message) ||
			"";
		console.warn("[developer-video] Encode failed", {
			videoId: video.id,
			part,
			phase: payload.phase,
			detail: developerVideoFailureReason(detail),
		});
		const applied = await settleDeveloperVideoPart(
			video.id,
			encodeId,
			part,
			token,
			{ type: "failed", reason: fileProblem(detail, UNENCODABLE_FILE) },
		);
		return { success: true, applied };
	}

	const { outcome, renditions } = await completedOutcome(
		video,
		processing,
		part,
		token,
		payload,
	);
	const settle = (executor?: InfraDbExecutor) =>
		settleDeveloperVideoPart(
			video.id,
			encodeId,
			part,
			token,
			outcome,
			renditions,
			executor,
		);
	if (
		outcome.type === "complete" &&
		outcome.duration &&
		processing.probe?.duration == null
	) {
		const measuredDuration = outcome.duration;
		try {
			const applied = await underAccountLock(video.appId, async (tx) => {
				await chargeForProbedDuration(video, measuredDuration, undefined, tx);
				return settle(tx);
			});
			return { success: true, applied };
		} catch (error) {
			if (!(error instanceof DeveloperVideoChargeRefused)) throw error;
			await failDeveloperVideoProcessing(video.id, encodeId, error.message);
			return { success: true, applied: true };
		}
	}
	const applied = await settle();
	return { success: true, applied };
}

// A part that was dispatched twice (its first start was never confirmed)
// leaves the losing attempt's files inside the encode's folder. Once the
// encode has finished, only the outputs it settled on are kept.
export async function sweepSupersededDeveloperVideoOutputs(
	videoId: string,
	encodeId: string,
): Promise<number> {
	const encode = await findEncode(videoId, encodeId);
	if (!encode) return 0;
	const { video, processing } = encode;
	const parts = DEVELOPER_VIDEO_PARTS.map((part) => processing[part]);
	if (
		parts.some((part) => part.state === "pending" || part.state === "running")
	) {
		return 0;
	}
	const encodePrefix = `${developerVideoPrefix(video)}${encodeId}/`;
	// A ladder made of slices keeps its playlists and the media of the attempt
	// each slice settled on. The slices' own playlists and anything a second
	// attempt left in the folder go.
	const { sliced, hls } = processing;
	const slicedOutput =
		sliced?.state === "complete" &&
		hls.state === "complete" &&
		hls.output === sliced.output
			? sliced
			: null;
	const slicedFiles = new Set<string>();
	// Media of slices viewers were shown before a fallback stays, with each
	// slice's own playlists, which delivery metering reads to count its seconds.
	const superseded = supersededSlicedHls(processing);
	if (superseded) {
		const { hlsPrefix, slicePrefix } = slicedHlsKeys(
			video,
			encodeId,
			superseded.output,
		);
		for (const file of slicedHlsMediaFiles({
			video,
			encodeId,
			...superseded,
			ended: true,
		})) {
			slicedFiles.add(`${hlsPrefix}${file}`);
			slicedFiles.add(`${slicePrefix}${file.replace(/\.m4s$/, ".m3u8")}`);
		}
	}
	if (slicedOutput) {
		const source = {
			video,
			encodeId,
			output: slicedOutput.output,
			slices: playableSlices(slicedOutput),
			hasAudio: slicedOutput.hasAudio,
			ended: true,
		};
		const { hlsPrefix } = slicedHlsKeys(video, encodeId, slicedOutput.output);
		for (const file of [
			...slicedHlsPlaylistFiles(source),
			...slicedHlsMediaFiles(source),
		]) {
			slicedFiles.add(`${hlsPrefix}${file}`);
		}
	}
	const kept = [
		...parts.flatMap((part) =>
			part.state === "complete" && part.output !== slicedOutput?.output
				? [part.output]
				: [],
		),
		...(processing.poster ? [processing.poster.output] : []),
	].map((output) => `${encodePrefix}${output}/`);
	return deleteDeveloperVideoObjects(
		encodePrefix,
		(key) =>
			slicedFiles.has(key) || kept.some((prefix) => key.startsWith(prefix)),
	);
}

function isAudioUpload(name: string): boolean {
	return name.startsWith(`${HLS_AUDIO_NAME}.`);
}

async function buildSliceJobRequest(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
	sliced: DeveloperVideoSlicedHls,
	index: number,
	token: string,
): Promise<Record<string, unknown>> {
	const slice = sliced.slices[index];
	if (!video.s3Key || !processing.probe || !slice) {
		throw new Error("Video is missing its source or dimensions");
	}
	const plan = planDeveloperVideoEncode(
		{ width: processing.probe.width, height: processing.probe.height },
		video.maxResolutionTier,
	);
	const keys = slicedHlsKeys(video, processing.encodeId, sliced.output);
	const expiresIn = MEDIA_SERVER_URL_EXPIRES_SECONDS;
	const source = await headDeveloperVideoObject(video.s3Key);
	const inputExtension = developerVideoSourceExtension(source?.contentType);
	// The first slice carries the audio for the whole video and the poster.
	const first = index === 0;
	const uploads = Object.fromEntries(
		await Promise.all(
			plan.uploads
				.filter((upload) => first || !isAudioUpload(upload.name))
				.map(async (upload) => {
					const stored = slicedFileName(upload.name, index, token);
					const prefix =
						upload.contentType === HLS_PLAYLIST_CONTENT_TYPE
							? keys.slicePrefix
							: keys.hlsPrefix;
					return [
						upload.name,
						await developerVideoUploadUrl(
							`${prefix}${stored}`,
							upload.contentType,
							expiresIn,
						),
					] as const;
				}),
		),
	);
	return {
		videoId: video.id,
		userId: video.appId,
		videoUrl: await internalDeveloperVideoUrl(video.s3Key, expiresIn),
		...(first
			? {
					thumbnailPresignedUrl: await developerVideoUploadUrl(
						developerVideoKeys(video, processing.encodeId, token).poster,
						"image/jpeg",
						expiresIn,
					),
				}
			: {}),
		webhookUrl: webhookUrl("hls", token),
		...(inputExtension ? { inputExtension } : {}),
		maxTier: plan.ladderMaxTier,
		range: {
			startSeconds: slice.startSeconds,
			...(slice.durationSeconds === null
				? {}
				: { durationSeconds: slice.durationSeconds }),
		},
		includeAudio: first,
		uploads,
		infra: true,
	};
}

async function settleDeveloperVideoSlice(
	videoId: string,
	encodeId: string,
	token: string,
	outcome: DeveloperVideoSliceOutcome,
): Promise<boolean> {
	const updated = await commitEncodeState(videoId, encodeId, (processing) => {
		const settled = settleSlice(processing, token, outcome);
		if (!settled) return null;
		const sliced = settled.sliced;
		return {
			processing: settled,
			...(sliced?.state === "encoding" && sliced.exposed === true
				? { renditions: slicedHlsRenditions(sliced) }
				: {}),
		};
	});
	return updated !== null;
}

// A slice is sent through the load balancer, so a worker that is full can be
// answered by asking again: the next request lands on another worker.
const SLICE_START_TRIES = 2;
// The first slice is what makes the video playable. It is sent on its own
// ahead of the others and asks more workers before it waits, since the MP4's
// worker turns it away and a full answer would hold it for the next pass.
const FIRST_SLICE_START_TRIES = 4;

async function startSlice(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
	sliced: DeveloperVideoSlicedHls,
	pick: { index: number; token: string },
): Promise<DeveloperVideoDispatch> {
	const { encodeId } = processing;
	const release = async () => {
		await mutateEncode(video.id, encodeId, (latest) => {
			const released = releaseSlice(latest, pick.token);
			return released
				? { processing: { ...released, busyAt: Date.now() } }
				: null;
		});
		return "busy" as const;
	};
	let started: Awaited<ReturnType<typeof startMediaServerVideoJob>>;
	try {
		const body = await buildSliceJobRequest(
			video,
			processing,
			sliced,
			pick.index,
			pick.token,
		);
		started = await startMediaServerVideoJob("/video/ladder", body);
		for (
			let tries = 1;
			started.status === "busy" &&
			tries < (pick.index === 0 ? FIRST_SLICE_START_TRIES : SLICE_START_TRIES);
			tries++
		) {
			started = await startMediaServerVideoJob("/video/ladder", body);
		}
	} catch (error) {
		console.error("[developer-video] Failed to send a slice to the encoder", {
			videoId: video.id,
			slice: pick.index,
			error,
		});
		return release();
	}

	if (started.status === "started") {
		const { jobId } = started;
		const recorded = await mutateEncode(video.id, encodeId, (latest) => {
			const dispatched = markSliceDispatched(latest, {
				token: pick.token,
				jobId,
			});
			return dispatched ? { processing: dispatched } : null;
		});
		// The slice was given up, or the video deleted, while its start was on
		// the way: no result of this job would be taken.
		if (!recorded) await cancelDeveloperVideoJobs(video.id, [jobId]);
		return "dispatched";
	}
	if (started.status === "unconfirmed") return "unconfirmed";
	if (started.status === "busy" || started.status === "unreachable") {
		return release();
	}
	if (started.status === "unavailable") {
		await commitEncodeState(video.id, encodeId, (latest) => ({
			processing: abandonSlicedHls(latest, LADDER_UNAVAILABLE_REASON),
		}));
		return "unavailable";
	}
	console.warn("[developer-video] Slice start rejected", {
		videoId: video.id,
		slice: pick.index,
		detail: developerVideoFailureReason(started.message),
	});
	await settleDeveloperVideoSlice(video.id, encodeId, pick.token, {
		type: "failed",
		reason: fileProblem(started.message, UNENCODABLE_FILE),
	});
	return "failed";
}

async function dispatchDueSlices(
	videoId: string,
	encodeId: string,
): Promise<DeveloperVideoDispatch> {
	const tokens = Array.from({ length: SLICED_HLS.maxInFlight }, () =>
		newAttemptToken(),
	);
	let begun: { index: number; token: string }[] = [];
	const video = await mutateEncode(videoId, encodeId, (processing) => {
		const started = beginSlices(processing, { tokens, now: Date.now() });
		if (!started) return null;
		begun = started.begun;
		return { processing: started.state };
	});
	const processing = video?.processing;
	const sliced = processing?.sliced;
	if (!video || !processing || !sliced || begun.length === 0) return "skipped";

	const start = (pick: { index: number; token: string }) =>
		startSlice(video, processing, sliced, pick);
	const first = await Promise.all(
		begun.filter((pick) => pick.index === 0).map(start),
	);
	// No ladder route on the encoder: the video falls back to one whole job,
	// so the rest of this pass is not sent.
	if (first.includes("unavailable")) return "unavailable";
	const results = [
		...first,
		...(await Promise.all(begun.filter((pick) => pick.index !== 0).map(start))),
	];
	// The workflow takes a busy answer while nothing of the video encodes as
	// time spent waiting for room and restarts its deadline. Slices of this
	// video that are encoding are processing time, so a slice turned away
	// beside them is not reported as busy.
	const encoding =
		results.some((result) => result === "dispatched") ||
		sliced.slices.some(
			(slice, index) =>
				slice.job.state === "running" &&
				!begun.some((pick) => pick.index === index),
		);
	if (encoding && results.includes("busy")) return "dispatched";
	return (
		(
			["busy", "dispatched", "unconfirmed", "unavailable", "failed"] as const
		).find((result) => results.includes(result)) ?? "skipped"
	);
}

async function checkSlice(
	videoId: string,
	encodeId: string,
	index: number,
): Promise<void> {
	const encode = await findEncode(videoId, encodeId);
	const sliced = encode ? slicedHlsEncoding(encode.processing) : null;
	const job = sliced?.slices[index]?.job;
	if (
		job?.state !== "running" ||
		job.jobId === null ||
		developerVideoPartAction(job, Date.now()) !== "check"
	) {
		return;
	}
	const { token } = job;

	const status = await readMediaServerVideoJob(job.jobId, videoId);
	if (status.status === "unreachable") return;
	if (status.status === "finished") {
		await applyEncodeProgress(status.progress, "hls", token);
		return;
	}
	const now = Date.now();
	let requeued = false;
	await commitEncodeState(videoId, encodeId, (processing) => {
		const latest = findRunningSlice(processing, token);
		if (!latest) return null;
		if (status.status === "missing" && !lostJobConfirmed(latest.job, now)) {
			const marked = markSliceNotFound(processing, { token, now });
			return marked ? { processing: marked } : null;
		}
		const next =
			status.status === "missing"
				? requeueLostSlice(processing, token)
				: markSliceChecked(processing, { token, now });
		requeued = status.status === "missing" && next !== null;
		return next ? { processing: next } : null;
	});
	if (requeued) {
		console.warn("[developer-video] Slice job was lost, sending it again", {
			videoId,
			slice: index,
		});
	}
}

// Writes the whole ladder next to the slices' media once every slice is in:
// a master playlist and one playlist per rendition that list each slice's
// file in order. From here the video's adaptive stream is stored and served
// like one made by a single job.
async function finalizeSlicedHls(
	videoId: string,
	encodeId: string,
): Promise<boolean> {
	const encode = await findEncode(videoId, encodeId);
	const sliced = encode ? slicedHlsEncoding(encode.processing) : null;
	if (!encode || !sliced) return false;
	const slices = playableSlices(sliced);
	if (slices.length !== sliced.slices.length) return false;
	const source = {
		video: encode.video,
		encodeId,
		output: sliced.output,
		slices,
		hasAudio: sliced.hasAudio,
		ended: true,
	};
	const { hlsPrefix } = slicedHlsKeys(encode.video, encodeId, sliced.output);
	await Promise.all(
		slicedHlsPlaylistFiles(source).map(async (file) => {
			const text = await slicedHlsPlaylistText(
				source,
				file,
				readDeveloperVideoText,
			);
			if (!text) throw new Error(`Sliced ladder has no ${file}`);
			await writeDeveloperVideoText(
				`${hlsPrefix}${file}`,
				text,
				HLS_PLAYLIST_CONTENT_TYPE,
			);
		}),
	);
	const completed = await commitEncodeState(videoId, encodeId, (processing) => {
		const next = completeSlicedHls(processing);
		return next?.sliced
			? { processing: next, renditions: slicedHlsRenditions(next.sliced) }
			: null;
	});
	return completed !== null;
}

// Moves a sliced encode on: sends the slices that are due, asks about the
// quiet ones, and writes the finished ladder once all are in. Null when the
// video's adaptive stream is not being made in slices.
export async function advanceSlicedHls(
	videoId: string,
	encodeId: string,
): Promise<DeveloperVideoDispatch | null> {
	const encode = await findEncode(videoId, encodeId);
	const sliced = encode ? slicedHlsEncoding(encode.processing) : null;
	if (!sliced) return null;
	const step = slicedHlsStep(sliced, Date.now());
	if (step.finalize) {
		try {
			return (await finalizeSlicedHls(videoId, encodeId))
				? "dispatched"
				: "skipped";
		} catch (error) {
			console.error("[developer-video] Failed to write the sliced ladder", {
				videoId,
				error,
			});
			return "busy";
		}
	}
	const [dispatched] = await Promise.all([
		step.dispatch.length > 0
			? dispatchDueSlices(videoId, encodeId)
			: Promise.resolve<DeveloperVideoDispatch>("skipped"),
		...step.check.map((index) =>
			checkSlice(videoId, encodeId, index).catch((error) => {
				console.error("[developer-video] Failed to check a quiet slice job", {
					videoId,
					slice: index,
					error,
				});
			}),
		),
	]);
	return dispatched;
}

const SLICE_NOT_STORED = {
	type: "failed" as const,
	reason: "Encoded slice was not stored as expected",
};

async function completedSliceOutcome(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
	found: NonNullable<ReturnType<typeof findRunningSlice>>,
	token: string,
	payload: DeveloperVideoProgressPayload,
): Promise<DeveloperVideoSliceOutcome> {
	const ladder = parseDeveloperVideoSliceLadder(payload.ladder);
	if (!ladder) {
		return { type: "failed", reason: "Encoder reported no renditions" };
	}
	const { sliced, index, slice } = found;
	const stored = {
		video,
		encodeId: processing.encodeId,
		output: sliced.output,
	};
	const { slicePrefix } = slicedHlsKeys(
		video,
		processing.encodeId,
		sliced.output,
	);
	const master = await readDeveloperVideoText(
		`${slicePrefix}${slicedFileName(DEVELOPER_VIDEO_MASTER_PLAYLIST, index, token)}`,
	);
	if (!master || !ladderMatchesMaster(ladder.renditions, master)) {
		return SLICE_NOT_STORED;
	}
	const streams = [
		...ladder.renditions.map((rendition) => rendition.name),
		...(index === 0 && ladder.audioBytes > 0 ? [HLS_AUDIO_NAME] : []),
	];
	const playlists = await Promise.all(
		streams.map((stream) =>
			readStoredSlicePlaylist(
				stored,
				{ index, token },
				stream,
				readDeveloperVideoText,
			).catch(() => null),
		),
	);
	const [top] = playlists;
	if (!top || playlists.some((playlist) => playlist === null)) {
		return SLICE_NOT_STORED;
	}
	const audio = streams.at(-1) === HLS_AUDIO_NAME ? playlists.at(-1) : null;
	if (
		slice.durationSeconds !== null &&
		Math.abs(top.seconds - slice.durationSeconds) >
			SLICED_HLS.lengthToleranceSeconds
	) {
		return {
			type: "failed",
			reason: "Encoded slice does not cover its part of the video",
		};
	}
	const poster =
		index === 0
			? await headDeveloperVideoObject(
					developerVideoKeys(video, processing.encodeId, token).poster,
				)
			: null;
	return {
		type: "complete",
		result: {
			seconds: top.seconds,
			renditions: ladder.renditions,
			audioBytes: index === 0 ? ladder.audioBytes : 0,
			...(audio && audio.seconds > 0
				? {
						audioBitrate: Math.round((ladder.audioBytes * 8) / audio.seconds),
					}
				: {}),
		},
		posterBytes: poster?.bytes ?? 0,
	};
}

async function applySliceResult(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
	found: NonNullable<ReturnType<typeof findRunningSlice>>,
	token: string,
	payload: DeveloperVideoProgressPayload,
): Promise<{ success: true; applied: boolean }> {
	const { encodeId } = processing;
	if (
		payload.phase === "cancelled" &&
		payload.message === MEDIA_SERVER_SHUTDOWN_MESSAGE
	) {
		const requeued = await commitEncodeState(video.id, encodeId, (latest) => {
			const next = requeueLostSlice(latest, token);
			return next ? { processing: next } : null;
		});
		return { success: true, applied: requeued !== null };
	}
	if (payload.phase !== "complete") {
		const detail =
			(typeof payload.error === "string" && payload.error) ||
			(typeof payload.message === "string" && payload.message) ||
			"";
		console.warn("[developer-video] Slice encode failed", {
			videoId: video.id,
			slice: found.index,
			phase: payload.phase,
			detail: developerVideoFailureReason(detail),
		});
		const applied = await settleDeveloperVideoSlice(video.id, encodeId, token, {
			type: "failed",
			reason: fileProblem(detail, UNENCODABLE_FILE),
		});
		return { success: true, applied };
	}
	const outcome = await completedSliceOutcome(
		video,
		processing,
		found,
		token,
		payload,
	);
	if (outcome.type === "failed") {
		console.warn("[developer-video] Slice result refused", {
			videoId: video.id,
			slice: found.index,
			reason: outcome.reason,
		});
	}
	const applied = await settleDeveloperVideoSlice(
		video.id,
		encodeId,
		token,
		outcome,
	);
	return { success: true, applied };
}
