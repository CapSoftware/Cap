import { randomBytes } from "node:crypto";
import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import type {
	DeveloperVideoPart,
	DeveloperVideoProcessingState,
	DeveloperVideoRendition,
} from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { billableVideo } from "@/lib/developer-pricing";
import { lockInfraAccount } from "@/lib/infra-balance";
import { INFRA_RESOLUTION_TIERS } from "@/lib/infra-pricing";
import type { InfraDbExecutor } from "@/lib/infra-standing";
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
	hlsPlaylistDuration,
	ladderMatchesMaster,
	parseDeveloperVideoLadder,
	planDeveloperVideoEncode,
} from "./developer-video-plan";
import {
	beginPart,
	createDeveloperVideoProcessingState,
	DEVELOPER_VIDEO_PARTS,
	type DeveloperVideoPartAction,
	type DeveloperVideoPartOutcome,
	type DeveloperVideoRedrive,
	developerVideoFailureReason,
	developerVideoPartAction,
	developerVideoRedrive,
	developerVideoStoredBytes,
	failUnfinishedParts,
	lostJobConfirmed,
	markPartChecked,
	markPartDispatched,
	markPartNotFound,
	releasePart,
	requeueLostPart,
	resolveDeveloperVideoStatus,
	retryUnavailableHls,
	settlePart,
} from "./developer-video-state";
import {
	deleteDeveloperVideoObjects,
	developerVideoPrefix,
	developerVideoUploadUrl,
	headDeveloperVideoObject,
	internalDeveloperVideoUrl,
	readDeveloperVideoText,
} from "./developer-video-storage";
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
	const run = async (tx: InfraDbExecutor) => {
		const [video] = await tx
			.select()
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.for("update");
		if (!video) return null;
		const updates = mutate(video);
		if (!updates) return null;
		await tx
			.update(developerVideos)
			.set(updates)
			.where(eq(developerVideos.id, videoId));
		return { ...video, ...updates } as DeveloperVideoRow;
	};
	return executor ? run(executor) : db().transaction(run);
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
		if (processing.hls.state !== "pending") return null;
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

const UNREADABLE_FILE =
	"This file could not be read as a video. Upload a video file such as MP4, MOV, WebM or MKV.";
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
		throw new DeveloperVideoChargeRefused(
			"Video is longer than the 4 hour limit",
		);
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

export async function prepareDeveloperVideoProcessing(
	videoId: string,
	encodeId: string,
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

export async function readDeveloperVideoParts(
	videoId: string,
	encodeId: string,
): Promise<DeveloperVideoPartSnapshot | null> {
	const encode = await findEncode(videoId, encodeId);
	if (!encode) return null;
	const now = Date.now();
	return {
		hls: developerVideoPartAction(encode.processing.hls, now),
		mp4: developerVideoPartAction(encode.processing.mp4, now),
	};
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
	const source = await headDeveloperVideoObject(video.s3Key);
	const inputExtension = developerVideoSourceExtension(source?.contentType);
	const common = {
		videoId: video.id,
		userId: video.appId,
		videoUrl: await internalDeveloperVideoUrl(video.s3Key, expiresIn),
		thumbnailPresignedUrl: await developerVideoUploadUrl(
			keys.poster,
			"image/jpeg",
			expiresIn,
		),
		webhookUrl: webhookUrl(part, token),
		...(inputExtension ? { inputExtension } : {}),
	};

	if (part === "mp4") {
		return {
			path: "/video/process",
			body: {
				...common,
				outputPresignedUrl: await developerVideoUploadUrl(
					keys.mp4,
					"video/mp4",
					expiresIn,
				),
				maxWidth: plan.mp4MaxDimension,
				maxHeight: plan.mp4MaxDimension,
			},
		};
	}

	const uploads = Object.fromEntries(
		await Promise.all(
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
		),
	);
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
	const updated = await mutateEncode(
		videoId,
		encodeId,
		(processing, video) => {
			const settled = settlePart(processing, part, token, outcome);
			if (!settled) return null;
			return {
				...processingUpdate(video, settled),
				...(renditions ? { renditions } : {}),
			};
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
	const token = newAttemptToken();
	const video = await mutateEncode(videoId, encodeId, (processing) => {
		const started = beginPart(processing, part, { token, now: Date.now() });
		return started ? { processing: started } : null;
	});
	if (!video?.processing) return "skipped";

	const request = await buildJobRequest(video, video.processing, part, token);
	const started = await startMediaServerVideoJob(request.path, request.body);

	if (started.status === "started") {
		await mutateEncode(videoId, encodeId, (processing) => {
			const dispatched = markPartDispatched(processing, part, {
				token,
				jobId: started.jobId,
			});
			return dispatched ? { processing: dispatched } : null;
		});
		return "dispatched";
	}
	if (started.status === "unconfirmed") return "unconfirmed";
	if (started.status === "busy" || started.status === "unreachable") {
		await mutateEncode(videoId, encodeId, (processing) => {
			const released = releasePart(processing, part, token);
			return released ? { processing: released } : null;
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
	await mutateEncode(videoId, encodeId, (processing, video) =>
		processingUpdate(video, failUnfinishedParts(processing, reason)),
	);
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
	const poster = await headDeveloperVideoObject(keys.poster);
	const posterBytes = poster?.bytes ?? 0;
	const needsDuration = processing.probe?.duration == null;

	if (part === "mp4") {
		const output = await headDeveloperVideoObject(keys.mp4);
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
	const master = await readDeveloperVideoText(
		`${keys.hlsPrefix}${DEVELOPER_VIDEO_MASTER_PLAYLIST}`,
	);
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

export async function applyDeveloperVideoProgress(
	payload: DeveloperVideoProgressPayload,
	partParam: string,
	token: string | null,
): Promise<{ success: true; applied: boolean }> {
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
	const current = processing?.[part];
	if (
		!video ||
		!processing ||
		current?.state !== "running" ||
		current.token !== token
	) {
		return ignored;
	}
	const { encodeId } = processing;

	if (
		payload.phase !== "complete" &&
		payload.phase !== "error" &&
		payload.phase !== "cancelled"
	) {
		const jobId = payload.jobId;
		if (current.jobId === null && typeof jobId === "string" && jobId) {
			await mutateEncode(video.id, encodeId, (latest) => {
				const confirmed = markPartDispatched(latest, part, { token, jobId });
				return confirmed ? { processing: confirmed } : null;
			});
		}
		return ignored;
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
	const kept = parts.flatMap((part) =>
		part.state === "complete" ? [`${encodePrefix}${part.output}/`] : [],
	);
	return deleteDeveloperVideoObjects(encodePrefix, (key) =>
		kept.some((prefix) => key.startsWith(prefix)),
	);
}
