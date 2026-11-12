import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { developerIdFromKey } from "@/lib/developer-ids";
import {
	copyDeveloperObject,
	deleteDeveloperObjects,
	developerObjectSize,
	developerObjectUrl,
	presignDeveloperUpload,
} from "@/lib/developer-transcript-storage";
import type { TranscriptUploadTarget } from "@/lib/developer-transcript-store";
import {
	DEVELOPER_UPLOAD_PREFIX,
	TRANSCRIPT_UPLOAD_URL_TTL_SECONDS,
	transcriptNameFromFile,
} from "@/lib/developer-transcripts";
import { admitDeveloperVideoUpload } from "@/lib/developer-video-charge";
import {
	createDeveloperPlaybackId,
	DEVELOPER_VIDEO_DEFAULT_TIER,
} from "@/lib/developer-video-plan";
import type { DeveloperVideoClaim } from "@/lib/developer-video-processing";
import {
	releaseDeveloperVideoUpload,
	startDeveloperVideoProcessing,
} from "@/lib/developer-video-start";
import {
	getInfraUploadAdmission,
	type InfraUploadAdmission,
} from "@/lib/infra-standing";
import { COMPLETION_IN_PROGRESS } from "@/lib/infra-upload";
import {
	ALREADY_RECORDED,
	claimInfraUploadCompletion,
	MAX_UPLOAD_DURATION_SECS,
	recordAdmittedInfraUpload,
	recordedUploadDuration,
} from "@/lib/infra-video-upload";
import {
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";
import { urlIsSelfContainedMedia } from "@/lib/media-container";

export const DEVELOPER_VIDEO_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export type DeveloperVideoFailure = {
	ok: false;
	status: 400 | 402 | 404 | 409;
	code: string;
	message: string;
	shortfallMicroCredits?: number;
};

const fail = (
	status: DeveloperVideoFailure["status"],
	code: string,
	message: string,
): DeveloperVideoFailure => ({ ok: false, status, code, message });

const NOT_FOUND = fail(404, "video_not_found", "Video not found");
const KEY_RETIRED = fail(
	409,
	"idempotency_conflict",
	"Idempotency key belongs to a video that was deleted or already uploaded",
);
const DURATION_REQUIRED = fail(
	400,
	"duration_required",
	"durationSeconds is required when the file cannot be measured",
);
const BUSY = fail(
	409,
	COMPLETION_IN_PROGRESS,
	"Another request is completing this upload. Try again shortly.",
);

const refused = (admission: InfraUploadAdmission): DeveloperVideoFailure => ({
	...fail(
		402,
		admission.reason ?? "insufficient_credits",
		admission.message ?? "Insufficient credits",
	),
	shortfallMicroCredits: admission.shortfallMicroCredits,
});

const VIDEO_CONTENT_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	avi: "video/avi",
};

export function developerVideoContentType(fileName: string) {
	const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
	return VIDEO_CONTENT_TYPES[extension] ?? "video/mp4";
}

export function developerVideoUploadKey(appId: string, videoId: string) {
	return `${DEVELOPER_UPLOAD_PREFIX}${appId}/v-${videoId}`;
}

export function developerVideoIdForIdempotencyKey(appId: string, key: string) {
	return developerIdFromKey("developer-video", appId, key);
}

export function developerVideoRecordedSeconds(input: {
	measuredSeconds: number | null;
	claimedSeconds: number | null;
	totalBytes: number;
}) {
	return input.measuredSeconds !== null
		? Math.min(Math.max(input.measuredSeconds, 0), MAX_UPLOAD_DURATION_SECS)
		: recordedUploadDuration(input.claimedSeconds ?? 0, input.totalBytes);
}

export type DeveloperVideoView = {
	id: string;
	appId: string;
	name: string;
	status: string;
	playbackId: string | null;
	durationSeconds: number;
	width: number | null;
	height: number | null;
	fps: number | null;
};

type DeveloperVideoRecord = {
	id: string;
	appId: string;
	name: string;
	status: string;
	playbackId: string | null;
	duration: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
};

export function toDeveloperVideoView(
	video: DeveloperVideoRecord,
): DeveloperVideoView {
	return {
		id: video.id,
		appId: video.appId,
		name: video.name,
		status: video.status,
		playbackId: video.playbackId,
		durationSeconds: video.duration ?? 0,
		width: video.width,
		height: video.height,
		fps: video.fps,
	};
}

async function findVideo(appId: string, videoId: string) {
	const [video] = await db()
		.select({
			id: developerVideos.id,
			appId: developerVideos.appId,
			name: developerVideos.name,
			status: developerVideos.status,
			playbackId: developerVideos.playbackId,
			duration: developerVideos.duration,
			width: developerVideos.width,
			height: developerVideos.height,
			fps: developerVideos.fps,
			maxResolutionTier: developerVideos.maxResolutionTier,
		})
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				isNull(developerVideos.deletedAt),
			),
		)
		.limit(1);
	return video ?? null;
}

export async function createDeveloperVideoUpload(
	appId: string,
	input: {
		fileName: string;
		contentLength: number;
		name?: string | null;
		userId?: string | null;
		idempotencyKey?: string;
	},
): Promise<
	| {
			ok: true;
			video: { id: string; appId: string; name: string; playbackId: string };
			upload: TranscriptUploadTarget;
	  }
	| DeveloperVideoFailure
> {
	const fileName = input.fileName.trim();
	const name = input.name?.trim() || transcriptNameFromFile(fileName);
	const externalUserId = input.userId?.trim() || null;
	if (!fileName || fileName.length > 255 || name.length > 255) {
		return fail(400, "invalid_name", "File name or video name is invalid");
	}
	if (externalUserId && externalUserId.length > 255) {
		return fail(400, "invalid_user_id", "User ID is too long");
	}
	if (
		!Number.isSafeInteger(input.contentLength) ||
		input.contentLength < 1 ||
		input.contentLength > DEVELOPER_VIDEO_MAX_UPLOAD_BYTES
	) {
		return fail(
			400,
			"invalid_content_length",
			"contentLength must be between 1 byte and 5 GB",
		);
	}

	const admission = await getInfraUploadAdmission(appId);
	if (!admission.allowed) return refused(admission);

	const id = input.idempotencyKey
		? developerVideoIdForIdempotencyKey(appId, input.idempotencyKey)
		: nanoId();
	const s3Key = `developer/${appId}/${id}/video`;

	await db()
		.insert(developerVideos)
		.values({
			id,
			appId,
			externalUserId,
			name,
			s3Key,
			playbackId: createDeveloperPlaybackId(),
			maxResolutionTier: DEVELOPER_VIDEO_DEFAULT_TIER,
		})
		.onDuplicateKeyUpdate({ set: { id } });

	const [video] = await db()
		.select({
			id: developerVideos.id,
			name: developerVideos.name,
			s3Key: developerVideos.s3Key,
			playbackId: developerVideos.playbackId,
			duration: developerVideos.duration,
			deletedAt: developerVideos.deletedAt,
		})
		.from(developerVideos)
		.where(and(eq(developerVideos.id, id), eq(developerVideos.appId, appId)))
		.limit(1);
	if (!video || video.s3Key !== s3Key || !video.playbackId) return NOT_FOUND;
	if (video.deletedAt || video.duration !== null) return KEY_RETIRED;

	const contentType = developerVideoContentType(fileName);
	const url = await presignDeveloperUpload(
		developerVideoUploadKey(appId, video.id),
		input.contentLength,
		contentType,
	);
	return {
		ok: true,
		video: {
			id: video.id,
			appId,
			name: video.name,
			playbackId: video.playbackId,
		},
		upload: {
			method: "PUT",
			url,
			headers: {
				"Content-Length": String(input.contentLength),
				"Content-Type": contentType,
			},
			expiresAt: new Date(
				Date.now() + TRANSCRIPT_UPLOAD_URL_TTL_SECONDS * 1000,
			).toISOString(),
		},
	};
}

const positive = (value: number | undefined | null) =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;

const rounded = (value: number | null) =>
	value === null ? undefined : Math.round(value);

export async function completeDeveloperVideoUpload(
	appId: string,
	videoId: string,
	input: {
		durationSeconds?: number;
		width?: number;
		height?: number;
		fps?: number;
	},
): Promise<{ ok: true; video: DeveloperVideoView } | DeveloperVideoFailure> {
	const video = await findVideo(appId, videoId);
	if (!video) return NOT_FOUND;
	if (video.duration !== null) {
		return { ok: true, video: toDeveloperVideoView(video) };
	}

	const settled = async (unsettled: DeveloperVideoFailure) => {
		const current = await findVideo(appId, video.id);
		if (!current) return NOT_FOUND;
		return current.duration !== null
			? { ok: true as const, video: toDeveloperVideoView(current) }
			: unsettled;
	};

	const claimedSeconds = positive(input.durationSeconds);
	const canMeasure = isMediaServerConfigured();
	if (!canMeasure && claimedSeconds === null) return DURATION_REQUIRED;

	const uploadKey = developerVideoUploadKey(appId, video.id);
	const totalBytes = await developerObjectSize(uploadKey);
	if (totalBytes === null || totalBytes === 0) {
		return settled(
			fail(
				409,
				"upload_not_found",
				"The file is not in storage. Uploads are kept for 48 hours, so upload it again if it has been longer",
			),
		);
	}
	if (totalBytes > DEVELOPER_VIDEO_MAX_UPLOAD_BYTES) {
		await deleteDeveloperObjects([uploadKey]);
		return fail(400, "file_too_large", "The file is larger than 5 GB");
	}

	const storedKey = `developer/${appId}/${video.id}/video-${nanoId()}`;
	await copyDeveloperObject(uploadKey, storedKey);

	let kept = false;
	let claim: DeveloperVideoClaim | null = null;
	try {
		if (!(await urlIsSelfContainedMedia(await developerObjectUrl(storedKey)))) {
			await deleteDeveloperObjects([uploadKey]);
			return fail(
				400,
				"unsupported_format",
				"The file is not a supported video format. Playlists and manifests are not accepted",
			);
		}
		let measuredSeconds: number | null = null;
		let width = positive(input.width);
		let height = positive(input.height);
		let fps = positive(input.fps);
		if (canMeasure) {
			try {
				const probe = await probeVideoViaMediaServer(
					await developerObjectUrl(storedKey),
					{ maxRetries: 1 },
				);
				measuredSeconds = positive(probe.duration);
				width = positive(probe.width) ?? width;
				height = positive(probe.height) ?? height;
				fps = positive(probe.fps) ?? fps;
			} catch (error) {
				console.error(
					`[developer-video-upload] Probe failed for ${video.id}`,
					error,
				);
			}
		}
		if (measuredSeconds === null && claimedSeconds === null) {
			return DURATION_REQUIRED;
		}

		const upload = {
			appId,
			videoId: video.id,
			durationSeconds: developerVideoRecordedSeconds({
				measuredSeconds,
				claimedSeconds,
				totalBytes,
			}),
			width: rounded(width),
			height: rounded(height),
			maxResolutionTier: video.maxResolutionTier,
		};

		const admission = await admitDeveloperVideoUpload(upload);
		if (!admission.allowed) return settled(refused(admission));

		claim = await claimInfraUploadCompletion(video.id);
		if (!claim) return settled(BUSY);

		const recorded = await recordAdmittedInfraUpload(upload, {
			s3Key: storedKey,
			duration: upload.durationSeconds,
			width: upload.width,
			height: upload.height,
			fps: rounded(fps),
		});
		if ("removed" in recorded) {
			await releaseDeveloperVideoUpload(video.id, claim);
			claim = null;
			return NOT_FOUND;
		}
		if (!recorded.allowed) {
			await releaseDeveloperVideoUpload(video.id, claim);
			claim = null;
			return refused(recorded);
		}
		kept = recorded !== ALREADY_RECORDED;

		const held = claim;
		claim = null;
		await startDeveloperVideoProcessing(video.id, held);

		const completed = await findVideo(appId, video.id);
		if (!completed) return NOT_FOUND;
		return { ok: true, video: toDeveloperVideoView(completed) };
	} catch (error) {
		if (claim) {
			await releaseDeveloperVideoUpload(video.id, claim).catch(() => {});
		}
		throw error;
	} finally {
		await deleteDeveloperObjects([kept ? uploadKey : storedKey]);
	}
}
