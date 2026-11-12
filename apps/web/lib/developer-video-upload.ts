import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
	debitDeveloperUsage,
	getDeveloperBalance,
} from "@/lib/developer-credits";
import { UPLOAD_MICRO_CREDITS_PER_MINUTE } from "@/lib/developer-pricing";
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
import {
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";

export const DEVELOPER_VIDEO_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const DEVELOPER_VIDEO_MAX_DURATION_SECONDS = 4 * 60 * 60;
export const DEVELOPER_VIDEO_MIN_BALANCE_MICRO_CREDITS = 5_000;
const BILLED_BYTES_PER_SECOND = 2_500_000;
const MIN_PLAUSIBLE_BYTES_PER_SECOND = 1_000;

export type DeveloperVideoFailure = {
	ok: false;
	status: 400 | 402 | 404 | 409;
	code: string;
	message: string;
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
const INSUFFICIENT = fail(402, "insufficient_credits", "Insufficient credits");
const DURATION_REQUIRED = fail(
	400,
	"duration_required",
	"durationSeconds is required when the file cannot be measured",
);

export function developerVideoUploadKey(appId: string, videoId: string) {
	return `${DEVELOPER_UPLOAD_PREFIX}${appId}/v-${videoId}`;
}

export function developerVideoIdForIdempotencyKey(appId: string, key: string) {
	return createHash("sha256")
		.update(["developer-video", appId, key].join("\0"), "utf8")
		.digest("base64url")
		.slice(0, 15);
}

export function developerVideoBilling(input: {
	measuredSeconds: number | null;
	claimedSeconds: number | null;
	totalBytes: number;
}) {
	const seconds =
		input.measuredSeconds !== null
			? input.measuredSeconds
			: Math.max(
					Math.min(
						input.claimedSeconds ?? 0,
						input.totalBytes / MIN_PLAUSIBLE_BYTES_PER_SECOND,
					),
					input.totalBytes / BILLED_BYTES_PER_SECOND,
				);
	const billingSeconds = Math.min(
		Math.max(seconds, 0),
		DEVELOPER_VIDEO_MAX_DURATION_SECONDS,
	);
	return {
		billingSeconds,
		microCredits: Math.floor(
			(billingSeconds / 60) * UPLOAD_MICRO_CREDITS_PER_MINUTE,
		),
	};
}

async function findVideo(appId: string, videoId: string) {
	const [video] = await db()
		.select()
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
			video: { id: string; appId: string; name: string };
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

	const balance = await getDeveloperBalance(appId);
	if (balance === null || balance < DEVELOPER_VIDEO_MIN_BALANCE_MICRO_CREDITS) {
		return INSUFFICIENT;
	}

	const id = input.idempotencyKey
		? developerVideoIdForIdempotencyKey(appId, input.idempotencyKey)
		: nanoId();
	const s3Key = `developer/${appId}/${id}/video`;

	await db()
		.insert(developerVideos)
		.values({ id, appId, externalUserId, name, s3Key })
		.onDuplicateKeyUpdate({ set: { id } });

	const [video] = await db()
		.select()
		.from(developerVideos)
		.where(and(eq(developerVideos.id, id), eq(developerVideos.appId, appId)))
		.limit(1);
	if (!video || video.s3Key !== s3Key) return NOT_FOUND;
	if (video.deletedAt || video.duration !== null) return KEY_RETIRED;

	const contentType = developerVideoContentType(fileName);
	const url = await presignDeveloperUpload(
		developerVideoUploadKey(appId, video.id),
		input.contentLength,
		contentType,
	);
	return {
		ok: true,
		video: { id: video.id, appId, name: video.name },
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

export async function completeDeveloperVideoUpload(
	appId: string,
	videoId: string,
	input: {
		durationSeconds?: number;
		width?: number;
		height?: number;
		fps?: number;
	},
): Promise<
	| {
			ok: true;
			video: typeof developerVideos.$inferSelect;
			chargedMicroCredits: number;
	  }
	| DeveloperVideoFailure
> {
	const video = await findVideo(appId, videoId);
	if (!video) return NOT_FOUND;
	if (video.duration !== null) {
		return { ok: true, video, chargedMicroCredits: 0 };
	}

	const claimedSeconds = positive(input.durationSeconds);
	const canMeasure = isMediaServerConfigured();
	if (!canMeasure && claimedSeconds === null) return DURATION_REQUIRED;

	const uploadKey = developerVideoUploadKey(appId, video.id);
	const totalBytes = await developerObjectSize(uploadKey);
	if (totalBytes === null || totalBytes === 0) {
		return fail(
			409,
			"upload_not_found",
			"The file is not in storage. Uploads are kept for 48 hours, so upload it again if it has been longer",
		);
	}
	if (totalBytes > DEVELOPER_VIDEO_MAX_UPLOAD_BYTES) {
		await deleteDeveloperObjects([uploadKey]);
		return fail(400, "file_too_large", "The file is larger than 5 GB");
	}

	const storedKey = `developer/${appId}/${video.id}/video-${nanoId()}`;
	await copyDeveloperObject(uploadKey, storedKey);

	let kept = false;
	try {
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

		const billing = developerVideoBilling({
			measuredSeconds,
			claimedSeconds,
			totalBytes,
		});

		const outcome = await db().transaction(async (tx) => {
			const [locked] = await tx
				.select({
					duration: developerVideos.duration,
					deletedAt: developerVideos.deletedAt,
				})
				.from(developerVideos)
				.where(eq(developerVideos.id, video.id))
				.limit(1)
				.for("update");
			if (!locked || locked.deletedAt) return { state: "missing" as const };
			if (locked.duration !== null) return { state: "superseded" as const };

			const debit =
				billing.microCredits > 0
					? await debitDeveloperUsage(tx, {
							appId,
							microCredits: billing.microCredits,
							type: "video_create",
							referenceId: video.id,
							referenceType: "developer_video",
							metadata: {
								durationSeconds: billing.billingSeconds,
								totalBytes,
								measured: measuredSeconds !== null,
							},
						})
					: ({ state: "already_paid" } as const);
			if (debit.state === "no_account" || debit.state === "insufficient") {
				return { state: "insufficient" as const };
			}

			await tx
				.update(developerVideos)
				.set({
					s3Key: storedKey,
					duration: billing.billingSeconds,
					width: width === null ? undefined : Math.round(width),
					height: height === null ? undefined : Math.round(height),
					fps: fps === null ? undefined : Math.round(fps),
				})
				.where(eq(developerVideos.id, video.id));
			return {
				state: "stored" as const,
				charged: debit.state === "debited" ? debit.chargedMicroCredits : 0,
			};
		});

		kept = outcome.state === "stored";
		if (outcome.state === "missing") return NOT_FOUND;
		if (outcome.state === "insufficient") return INSUFFICIENT;

		const completed = await findVideo(appId, video.id);
		if (!completed) return NOT_FOUND;
		return {
			ok: true,
			video: completed,
			chargedMicroCredits: outcome.state === "stored" ? outcome.charged : 0,
		};
	} finally {
		await deleteDeveloperObjects([kept ? uploadKey : storedKey]);
	}
}
