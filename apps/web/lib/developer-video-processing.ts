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
	createDeveloperEncodeId,
	createDeveloperPlaybackId,
	DEVELOPER_VIDEO_MASTER_PLAYLIST,
	developerVideoKeys,
	developerVideoSourceExtension,
	ladderMatchesMaster,
	parseDeveloperVideoLadder,
	planDeveloperVideoEncode,
} from "./developer-video-plan";
import {
	beginPart,
	createDeveloperVideoProcessingState,
	type DeveloperVideoPartOutcome,
	type DeveloperVideoRedrive,
	developerVideoFailureReason,
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
	developerVideoUploadUrl,
	headDeveloperVideoObject,
	internalDeveloperVideoUrl,
	readDeveloperVideoText,
} from "./developer-video-storage";
import {
	type MediaServerJobStart,
	probeVideoViaMediaServer,
	startMediaServerVideoJob,
} from "./media-client";

type DeveloperVideoRow = typeof developerVideos.$inferSelect;
type DeveloperVideoUpdate = Partial<typeof developerVideos.$inferInsert>;

const MEDIA_SERVER_URL_EXPIRES_SECONDS = 3 * 60 * 60;
const LADDER_UNAVAILABLE_REASON =
	"Adaptive streaming is not available on the media server yet";

export type DeveloperVideoDispatch =
	| "dispatched"
	| "busy"
	| "unavailable"
	| "failed"
	| "skipped";

export type DeveloperVideoPartSnapshot = Record<
	DeveloperVideoPart,
	DeveloperVideoProcessingState[DeveloperVideoPart]["state"]
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

function probedColumns(
	probe: DeveloperVideoProcessingState["probe"],
): DeveloperVideoUpdate {
	if (!probe) return {};
	return {
		width: probe.width,
		height: probe.height,
		...(probe.duration === null ? {} : { duration: probe.duration }),
		...(probe.fps === null ? {} : { fps: probe.fps }),
	};
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

export async function claimDeveloperVideoProcessing(
	videoId: string,
	options: { uploadCompleted?: boolean } = {},
): Promise<DeveloperVideoRedrive | null> {
	let claimed: DeveloperVideoRedrive | null = null;
	await mutateDeveloperVideo(videoId, (video) => {
		const now = Date.now();
		const action = developerVideoRedrive(video, now, options);
		if (action === "start") {
			claimed = action;
			return {
				status: "processing",
				errorReason: null,
				renditions: null,
				playbackId: video.playbackId ?? createDeveloperPlaybackId(),
				processing: createDeveloperVideoProcessingState({
					encodeId: createDeveloperEncodeId(),
					now,
				}),
			};
		}
		if (action === "retry-hls" && video.processing) {
			const processing = retryUnavailableHls(video.processing);
			if (!processing) return null;
			claimed = action;
			return { processing };
		}
		return null;
	});
	return claimed;
}

export async function releaseDeveloperVideoClaim(
	videoId: string,
	action: DeveloperVideoRedrive,
): Promise<void> {
	await mutateDeveloperVideo(videoId, (video) => {
		if (action === "start") {
			return video.status === "processing"
				? { status: "uploading", processing: null }
				: null;
		}
		if (!video.processing || video.processing.hls.state !== "pending") {
			return null;
		}
		const token = randomBytes(12).toString("base64url");
		const now = Date.now();
		const running = beginPart(video.processing, "hls", { token, now });
		const processing =
			running &&
			settlePart(running, "hls", token, {
				type: "unavailable",
				reason: LADDER_UNAVAILABLE_REASON,
				now,
			});
		return processing ? { processing } : null;
	});
}

export async function prepareDeveloperVideoProcessing(
	videoId: string,
): Promise<boolean> {
	const video = await findDeveloperVideo(videoId);
	if (!video || video.deletedAt || !video.processing) return false;
	if (video.processing.probe) return true;
	if (!video.s3Key) throw new Error("Video has no uploaded file");

	const source = await headDeveloperVideoObject(video.s3Key);
	if (!source) throw new Error("Uploaded video was not found in storage");
	const metadata = await probeVideoViaMediaServer(
		await internalDeveloperVideoUrl(
			video.s3Key,
			MEDIA_SERVER_URL_EXPIRES_SECONDS,
		),
	);
	if (!(metadata.width > 0) || !(metadata.height > 0)) {
		throw new Error("Uploaded file has no video track");
	}

	const encodeId = video.processing.encodeId;
	await mutateDeveloperVideo(videoId, (current) => {
		if (current.processing?.encodeId !== encodeId) return null;
		return processingUpdate(current, {
			...current.processing,
			probe: {
				duration:
					Number.isFinite(metadata.duration) && metadata.duration > 0
						? metadata.duration
						: null,
				width: metadata.width,
				height: metadata.height,
				fps:
					Number.isFinite(metadata.fps) && metadata.fps > 0
						? Math.round(metadata.fps)
						: null,
			},
			bytes: { ...current.processing.bytes, source: source.bytes },
		});
	});
	return true;
}

export async function readDeveloperVideoParts(
	videoId: string,
): Promise<DeveloperVideoPartSnapshot | null> {
	const video = await findDeveloperVideo(videoId);
	if (!video || video.deletedAt || !video.processing) return null;
	return {
		hls: video.processing.hls.state,
		mp4: video.processing.mp4.state,
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
	const keys = developerVideoKeys(video, processing.encodeId);
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
	part: DeveloperVideoPart,
	token: string,
	outcome: DeveloperVideoPartOutcome,
	renditions?: DeveloperVideoRendition[],
): Promise<boolean> {
	const updated = await mutateDeveloperVideo(videoId, (video) => {
		if (!video.processing) return null;
		const processing = settlePart(video.processing, part, token, outcome);
		if (!processing) return null;
		return {
			...processingUpdate(video, processing),
			...(renditions ? { renditions } : {}),
		};
	});
	return updated !== null;
}

export async function dispatchDeveloperVideoPart(
	videoId: string,
	part: DeveloperVideoPart,
): Promise<DeveloperVideoDispatch> {
	const token = randomBytes(12).toString("base64url");
	const video = await mutateDeveloperVideo(videoId, (current) => {
		if (current.deletedAt || !current.processing) return null;
		const processing = beginPart(current.processing, part, {
			token,
			now: Date.now(),
		});
		return processing ? { processing } : null;
	});
	if (!video?.processing) return "skipped";

	const request = await buildJobRequest(video, video.processing, part, token);
	const started = await startMediaServerVideoJob(
		request.path,
		request.body,
	).catch((error): MediaServerJobStart => {
		console.error("[developer-video] Media server did not answer", {
			videoId,
			part,
			error,
		});
		return { status: "busy" };
	});

	if (started.status === "started") {
		await mutateDeveloperVideo(videoId, (current) => {
			const processing =
				current.processing &&
				markPartDispatched(current.processing, part, {
					token,
					jobId: started.jobId,
				});
			return processing ? { processing } : null;
		});
		return "dispatched";
	}
	if (started.status === "busy") {
		await mutateDeveloperVideo(videoId, (current) => {
			const processing =
				current.processing && releasePart(current.processing, part, token);
			return processing ? { processing } : null;
		});
		return "busy";
	}
	if (started.status === "unavailable" && part === "hls") {
		await settleDeveloperVideoPart(videoId, part, token, {
			type: "unavailable",
			reason: LADDER_UNAVAILABLE_REASON,
			now: Date.now(),
		});
		return "unavailable";
	}
	await settleDeveloperVideoPart(videoId, part, token, {
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
	reason: string,
): Promise<void> {
	await mutateDeveloperVideo(videoId, (video) => {
		if (!video.processing) {
			return video.status === "processing"
				? {
						status: "errored",
						errorReason: developerVideoFailureReason(reason),
					}
				: null;
		}
		return processingUpdate(
			video,
			failUnfinishedParts(video.processing, reason),
		);
	});
}

interface DeveloperVideoProgressPayload {
	videoId?: unknown;
	phase?: unknown;
	error?: unknown;
	message?: unknown;
	ladder?: unknown;
}

async function completedOutcome(
	video: DeveloperVideoRow,
	processing: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	payload: DeveloperVideoProgressPayload,
): Promise<{
	outcome: DeveloperVideoPartOutcome;
	renditions?: DeveloperVideoRendition[];
}> {
	const keys = developerVideoKeys(video, processing.encodeId);
	const poster = await headDeveloperVideoObject(keys.poster);
	const posterBytes = poster?.bytes ?? 0;

	if (part === "mp4") {
		const output = await headDeveloperVideoObject(keys.mp4);
		if (!output || output.bytes === 0) {
			return {
				outcome: { type: "failed", reason: "Encoded MP4 was not stored" },
			};
		}
		return {
			outcome: { type: "complete", bytes: output.bytes, posterBytes },
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
	return {
		outcome: { type: "complete", bytes: ladder.bytes, posterBytes },
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
	if (
		payload.phase !== "complete" &&
		payload.phase !== "error" &&
		payload.phase !== "cancelled"
	) {
		return ignored;
	}

	const video = await findDeveloperVideo(payload.videoId);
	const current = video?.processing?.[part];
	if (
		!video?.processing ||
		current?.state !== "running" ||
		current.token !== token
	) {
		return ignored;
	}

	if (payload.phase !== "complete") {
		const reason =
			(typeof payload.error === "string" && payload.error) ||
			(typeof payload.message === "string" && payload.message) ||
			"Video processing failed";
		const applied = await settleDeveloperVideoPart(video.id, part, token, {
			type: "failed",
			reason,
		});
		return { success: true, applied };
	}

	const { outcome, renditions } = await completedOutcome(
		video,
		video.processing,
		part,
		payload,
	);
	const applied = await settleDeveloperVideoPart(
		video.id,
		part,
		token,
		outcome,
		renditions,
	);
	return { success: true, applied };
}
