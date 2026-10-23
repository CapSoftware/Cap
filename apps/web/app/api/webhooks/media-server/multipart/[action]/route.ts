import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getProcessingState } from "@/lib/desktop-recording-jobs";
import { getDesktopRecordingOutputKey } from "@/lib/desktop-recording-source";
import {
	LOOM_IMPORT_MAX_BYTES,
	LOOM_IMPORT_PART_BYTES,
} from "@/lib/loom-import-upload";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

const baseSchema = z.object({
	videoId: z.string().min(1),
	key: z.string().min(1),
	uploadId: z.string().min(1),
	loomImportAttemptId: z.string().min(1).max(200).optional(),
	generation: z
		.string()
		.regex(/^[a-zA-Z0-9_-]{1,64}$/)
		.optional(),
	attemptId: z
		.string()
		.regex(/^[a-zA-Z0-9_-]{1,64}$/)
		.optional(),
});

const signPartSchema = baseSchema.extend({
	partNumber: z.number().int().min(1),
	contentLength: z.number().int().min(1),
});

const completeSchema = baseSchema.extend({
	parts: z
		.array(
			z.object({
				partNumber: z.number().int().min(1),
				etag: z.string().min(1),
				size: z.number().int().min(1),
			}),
		)
		.min(1),
});

type MultipartPayload = z.infer<typeof baseSchema>;

function digest(value: string) {
	return createHash("sha256").update(value, "utf8").digest();
}

function isAuthorized(request: NextRequest) {
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
	const authHeader = request.headers.get("x-media-server-secret");

	return (
		Boolean(webhookSecret) &&
		Boolean(authHeader) &&
		timingSafeEqual(digest(authHeader ?? ""), digest(webhookSecret ?? ""))
	);
}

async function getMultipartContext(
	payload: MultipartPayload,
	allowExpired = false,
) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(payload.videoId)));

	if (!video) {
		return {
			response: NextResponse.json(
				{ error: "Video not found" },
				{ status: 404 },
			),
		};
	}

	const fenced =
		payload.generation !== undefined || payload.attemptId !== undefined;
	const loom =
		payload.loomImportAttemptId !== undefined ||
		video.metadata?.loomImportUpload !== undefined;
	if (loom) {
		const receipt = video.metadata?.loomImportUpload;
		const upload = [receipt?.source, receipt?.output].find(
			(value) =>
				value?.key === payload.key && value.uploadId === payload.uploadId,
		);
		if (
			fenced ||
			!receipt ||
			receipt.attemptId !== payload.loomImportAttemptId ||
			(video.metadata?.loomImportRun &&
				!receipt.attemptId.startsWith(
					`${video.metadata.loomImportRun.runId}:`,
				)) ||
			receipt.ownerId !== video.ownerId ||
			receipt.organizationId !== video.orgId ||
			!upload ||
			!payload.key.startsWith(`${video.ownerId}/${video.id}/`)
		) {
			return {
				response: NextResponse.json(
					{ error: "Loom import upload is no longer current" },
					{ status: 409 },
				),
			};
		}
	}
	const expectedKey =
		fenced && payload.generation && payload.attemptId
			? getDesktopRecordingOutputKey(
					video.ownerId,
					video.id,
					payload.generation,
					payload.attemptId,
				)
			: `${video.ownerId}/${video.id}/result.mp4`;
	if (
		(!loom && payload.key !== expectedKey) ||
		(fenced && (!payload.generation || !payload.attemptId))
	) {
		return {
			response: NextResponse.json(
				{ error: "Invalid multipart upload key" },
				{ status: 400 },
			),
		};
	}
	if (fenced && !allowExpired) {
		const job = await getProcessingState({ videoId: video.id });
		if (
			!job ||
			job.ownerId !== video.ownerId ||
			job.state !== "processing" ||
			!job.source ||
			job.generation !== payload.generation ||
			job.attemptId !== payload.attemptId ||
			!job.leaseExpiresAt ||
			job.leaseExpiresAt <= new Date()
		) {
			return {
				response: NextResponse.json(
					{ error: "Recording attempt is no longer active" },
					{ status: 409 },
				),
			};
		}
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	if (bucket.provider !== "s3") {
		return {
			response: NextResponse.json(
				{ error: "Multipart uploads are only available for S3 storage" },
				{ status: 400 },
			),
		};
	}

	return { bucket, fenced, loom };
}

async function readJson(request: NextRequest) {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

export async function POST(
	request: NextRequest,
	routeContext: { params: Promise<{ action: string }> },
) {
	if (!isAuthorized(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { action } = await routeContext.params;
	const json = await readJson(request);

	try {
		if (action === "sign-part") {
			const payload = signPartSchema.safeParse(json);
			if (!payload.success) {
				return NextResponse.json(
					{ error: "Invalid request", details: payload.error.issues },
					{ status: 400 },
				);
			}

			const multipartContext = await getMultipartContext(payload.data);
			if ("response" in multipartContext) return multipartContext.response;
			if (
				multipartContext.loom &&
				(payload.data.partNumber >
					Math.ceil(LOOM_IMPORT_MAX_BYTES / LOOM_IMPORT_PART_BYTES) ||
					payload.data.contentLength > LOOM_IMPORT_PART_BYTES)
			) {
				return NextResponse.json(
					{ error: "Loom imports are limited to 10 GB" },
					{ status: 400 },
				);
			}

			const partArguments = [
				payload.data.key,
				payload.data.uploadId,
				payload.data.partNumber,
			] as const;
			const url = await (multipartContext.loom
				? multipartContext.bucket.multipart.getPresignedUploadPartUrl(
						...partArguments,
						{ ContentLength: payload.data.contentLength },
					)
				: multipartContext.bucket.multipart.getPresignedUploadPartUrl(
						...partArguments,
					)
			).pipe(runPromise);

			return NextResponse.json({ url });
		}

		if (action === "complete") {
			const payload = completeSchema.safeParse(json);
			if (!payload.success) {
				return NextResponse.json(
					{ error: "Invalid request", details: payload.error.issues },
					{ status: 400 },
				);
			}

			const multipartContext = await getMultipartContext(payload.data);
			if ("response" in multipartContext) return multipartContext.response;
			if (
				multipartContext.loom &&
				(payload.data.parts.length >
					Math.ceil(LOOM_IMPORT_MAX_BYTES / LOOM_IMPORT_PART_BYTES) ||
					payload.data.parts.reduce((size, part) => size + part.size, 0) >
						LOOM_IMPORT_MAX_BYTES ||
					payload.data.parts.some((part) => part.size > LOOM_IMPORT_PART_BYTES))
			) {
				return NextResponse.json(
					{ error: "Loom imports are limited to 10 GB" },
					{ status: 400 },
				);
			}

			const parts = [...payload.data.parts]
				.sort((a, b) => a.partNumber - b.partNumber)
				.map((part) => ({
					PartNumber: part.partNumber,
					ETag: part.etag,
				}));
			if (parts.some((part, index) => part.PartNumber !== index + 1)) {
				return NextResponse.json(
					{ error: "Multipart parts must be contiguous and unique" },
					{ status: 400 },
				);
			}

			const result = await multipartContext.bucket.multipart
				.complete(payload.data.key, payload.data.uploadId, {
					MultipartUpload: { Parts: parts },
					...(multipartContext.fenced || multipartContext.loom
						? { IfNoneMatch: "*" }
						: {}),
				})
				.pipe(runPromise);

			return NextResponse.json({
				success: true,
				location: result.Location,
				objectIdentity: result.ETag,
			});
		}

		if (action === "abort") {
			const payload = baseSchema.safeParse(json);
			if (!payload.success) {
				return NextResponse.json(
					{ error: "Invalid request", details: payload.error.issues },
					{ status: 400 },
				);
			}

			const multipartContext = await getMultipartContext(payload.data, true);
			if ("response" in multipartContext) return multipartContext.response;

			await multipartContext.bucket.multipart
				.abort(payload.data.key, payload.data.uploadId)
				.pipe(runPromise);

			return NextResponse.json({ success: true });
		}

		return NextResponse.json({ error: "Unknown action" }, { status: 404 });
	} catch (error) {
		console.error("[media-server-multipart] Error handling request:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
