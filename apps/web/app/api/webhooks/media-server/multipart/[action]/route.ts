import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

const baseSchema = z.object({
	videoId: z.string().min(1),
	key: z.string().min(1),
	uploadId: z.string().min(1),
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

async function getMultipartContext(payload: MultipartPayload) {
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

	const expectedKey = `${video.ownerId}/${video.id}/result.mp4`;
	if (payload.key !== expectedKey) {
		return {
			response: NextResponse.json(
				{ error: "Invalid multipart upload key" },
				{ status: 400 },
			),
		};
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

	return { bucket };
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

			const url = await multipartContext.bucket.multipart
				.getPresignedUploadPartUrl(
					payload.data.key,
					payload.data.uploadId,
					payload.data.partNumber,
				)
				.pipe(runPromise);

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

			const parts = [...payload.data.parts]
				.sort((a, b) => a.partNumber - b.partNumber)
				.map((part) => ({
					PartNumber: part.partNumber,
					ETag: part.etag,
				}));

			const result = await multipartContext.bucket.multipart
				.complete(payload.data.key, payload.data.uploadId, {
					MultipartUpload: { Parts: parts },
				})
				.pipe(runPromise);

			return NextResponse.json({ success: true, location: result.Location });
		}

		if (action === "abort") {
			const payload = baseSchema.safeParse(json);
			if (!payload.success) {
				return NextResponse.json(
					{ error: "Invalid request", details: payload.error.issues },
					{ status: 400 },
				);
			}

			const multipartContext = await getMultipartContext(payload.data);
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
