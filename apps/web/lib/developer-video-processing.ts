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
	developerVideoPartAction,
	developerVideoRedrive,
	developerVideoStoredBytes,
	failUnfinishedParts,
	markPartDispatched,
	releasePart,
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
	startMediaServerVideoJob,
	tryProbeVideoViaMediaServer,
} from "./media-client";

type DeveloperVideoRow = typeof developerVideos.$inferSelect;
type DeveloperVideoUpdate = Partial<typeof developerVideos.$inferInsert>;

const MEDIA_SERVER_URL_EXPIRES_SECONDS = 3 * 60 * 60;
const LADDER_UNAVAILABLE_REASON =
	"Adaptive streaming is not available on the media server yet";

export interface DeveloperVideoClaim {
	action: DeveloperVideoRedrive;
	encodeId: string;
}

export type DeveloperVideoPreparation = "ready" | "retry" | "stale";

export type DeveloperVideoDispatch =
	| "dispatched"
	| "busy"
	| "unconfirmed"
	| "unavailable"
	| "failed"
	| "skipped";

export type DeveloperVideoPartSnapshot = Record<
	DeveloperVideoPart,
	DeveloperVideoPartAction
>;

async function mutateDeveloperVideo(
	videoId: string,
	mutate: (video: DeveloperVideoRow) => DeveloperVideoUpdate | null,
): Promise<DeveloperVideoRow | null> {
	return db().transaction(async (tx) => {
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
	});
}

async function mutateEncode(
	videoId: string,
	encodeId: string,
	mutate: (
		processing: DeveloperVideoProcessingState,
		video: DeveloperVideoRow,
	) => DeveloperVideoUpdate | null,
): Promise<DeveloperVideoRow | null> {
	return mutateDeveloperVideo(videoId, (video) =>
		video.deletedAt || video.processing?.encodeId !== encodeId
			? null
			: mutate(video.processing, video),
	);
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
export class DeveloperVideoChargeRefused extends Error {
	override name = "DeveloperVideoChargeRefused";
}

// The upload is billed on the length the client reported. Once the server has
// measured the real length, anything beyond that is charged before encoding,
// and a video the app can't pay for is not encoded.
export async function chargeForProbedDuration(
	video: Pick<DeveloperVideoRow, "id" | "appId" | "duration">,
	probedDuration: number | null,
): Promise<void> {
	if (probedDuration === null) return;
	if (probedDuration > DEVELOPER_VIDEO_MAX_DURATION_SECONDS) {
		throw new DeveloperVideoChargeRefused(
			"Video is longer than the 4 hour limit",
		);
	}
	const billed = video.duration ?? 0;
	if (probedDuration <= billed + PROBED_DURATION_TOLERANCE_SECONDS) return;
	const charged = await chargeDeveloperVideoUpload({
		appId: video.appId,
		videoId: video.id,
		durationSeconds: probedDuration,
		metadata: {
			durationSeconds: probedDuration,
			reportedDurationSeconds: billed,
			source: "probe",
		},
	});
	if (charged !== "charged") {
		throw new DeveloperVideoChargeRefused(
			"Not enough credit for the video's full length",
		);
	}
}

export async function prepareDeveloperVideoProcessing(
	videoId: string,
	encodeId: string,
): Promise<DeveloperVideoPreparation> {
	const encode = await findEncode(videoId, encodeId);
	if (!encode) return "stale";
	if (encode.processing.probe) return "ready";
	const { video } = encode;
	if (!video.s3Key) throw new Error("Video has no uploaded file");

	const source = await headDeveloperVideoObject(video.s3Key);
	if (!source) throw new Error("Uploaded video was not found in storage");
	const probed = await tryProbeVideoViaMediaServer(
		await internalDeveloperVideoUrl(
			video.s3Key,
			MEDIA_SERVER_URL_EXPIRES_SECONDS,
		),
	);
	if (probed.status === "unreachable") return "retry";
	if (probed.status === "rejected") throw new Error(probed.message);
	const { metadata } = probed;
	if (!(metadata.width > 0) || !(metadata.height > 0)) {
		throw new Error("Uploaded file has no video track");
	}
	const probedDuration =
		Number.isFinite(metadata.duration) && metadata.duration > 0
			? metadata.duration
			: null;
	await chargeForProbedDuration(video, probedDuration);

	const updated = await mutateEncode(videoId, encodeId, (processing, current) =>
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
	);
	return updated ? "ready" : "stale";
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
): Promise<boolean> {
	const updated = await mutateEncode(videoId, encodeId, (processing, video) => {
		const settled = settlePart(processing, part, token, outcome);
		if (!settled) return null;
		return {
			...processingUpdate(video, settled),
			...(renditions ? { renditions } : {}),
		};
	});
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
	await settleDeveloperVideoPart(videoId, encodeId, part, token, {
		type: "failed",
		reason:
			started.status === "rejected"
				? started.message
				: "Video processing is not available on the media server",
	});
	return "failed";
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

	if (payload.phase !== "complete") {
		const reason =
			(typeof payload.error === "string" && payload.error) ||
			(typeof payload.message === "string" && payload.message) ||
			"Video processing failed";
		const applied = await settleDeveloperVideoPart(
			video.id,
			encodeId,
			part,
			token,
			{ type: "failed", reason },
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
	if (
		outcome.type === "complete" &&
		outcome.duration &&
		processing.probe?.duration == null
	) {
		try {
			await chargeForProbedDuration(video, outcome.duration);
		} catch (error) {
			if (!(error instanceof DeveloperVideoChargeRefused)) throw error;
			await failDeveloperVideoProcessing(video.id, encodeId, error.message);
			return { success: true, applied: true };
		}
	}
	const applied = await settleDeveloperVideoPart(
		video.id,
		encodeId,
		part,
		token,
		outcome,
		renditions,
	);
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
