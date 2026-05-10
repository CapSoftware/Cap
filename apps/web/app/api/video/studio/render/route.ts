import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { Effect } from "effect";
import type { NextRequest } from "next/server";
import {
	BROWSER_STUDIO_MANIFEST_SUBPATH,
	type BrowserStudioCloudManifest,
	isBrowserStudioCloudManifest,
	normalizeBrowserStudioManifest,
	uniqueBrowserStudioSourceSubpaths,
} from "@/lib/browser-studio";
import {
	buildBrowserStudioRenderPlan,
	renderBrowserStudioMp4,
} from "@/lib/browser-studio-render";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

type StudioRenderBucket = {
	getSignedObjectUrl: (key: string) => Effect.Effect<string, unknown, never>;
	headObject: (key: string) => Effect.Effect<
		{
			ContentType?: string;
			ContentLength?: number;
		},
		unknown,
		never
	>;
	putObject: (
		key: string,
		body: Uint8Array | string,
		fields: {
			contentType?: string;
			contentLength?: number;
		},
	) => Effect.Effect<unknown, unknown, never>;
};

const getManifestKey = (ownerId: string, videoId: string) =>
	`${ownerId}/${videoId}/${BROWSER_STUDIO_MANIFEST_SUBPATH}`;

const getVideoKey = (ownerId: string, videoId: string, subpath: string) =>
	`${ownerId}/${videoId}/${subpath}`;

const findOwnedVideo = async (videoId: string, userId: User.UserId) => {
	const [video] = await db()
		.select()
		.from(videos)
		.where(
			and(
				eq(videos.id, Video.VideoId.make(videoId)),
				eq(videos.ownerId, userId),
			),
		)
		.limit(1);

	return video ?? null;
};

const persistManifest = async (
	bucket: StudioRenderBucket,
	video: typeof videos.$inferSelect,
	manifest: BrowserStudioCloudManifest,
) => {
	const payload = JSON.stringify(manifest);

	await bucket
		.putObject(getManifestKey(video.ownerId, video.id), payload, {
			contentType: "application/json",
			contentLength: new TextEncoder().encode(payload).byteLength,
		})
		.pipe(runPromise);
};

const loadRenderSources = async (
	bucket: StudioRenderBucket,
	video: typeof videos.$inferSelect,
	manifest: BrowserStudioCloudManifest,
) =>
	Promise.all(
		uniqueBrowserStudioSourceSubpaths(manifest).map(async (subpath) => {
			const key = getVideoKey(video.ownerId, video.id, subpath);
			const [url, metadata] = await Promise.all([
				bucket.getSignedObjectUrl(key).pipe(runPromise),
				bucket
					.headObject(key)
					.pipe(runPromise)
					.catch(() => null),
			]);

			return {
				subpath,
				url,
				contentType: metadata?.ContentType ?? null,
				size: metadata?.ContentLength ?? null,
			};
		}),
	);

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	const body = (await request.json()) as {
		videoId?: unknown;
		manifest?: unknown;
	};

	if (!user?.id) return Response.json({ error: true }, { status: 401 });
	if (typeof body.videoId !== "string")
		return Response.json({ error: true }, { status: 400 });
	if (!isBrowserStudioCloudManifest(body.manifest))
		return Response.json({ error: true }, { status: 400 });
	if (body.manifest.videoId !== body.videoId)
		return Response.json({ error: true }, { status: 400 });

	const video = await findOwnedVideo(body.videoId, user.id);
	if (!video) return Response.json({ error: true }, { status: 404 });

	const storageVideo = decodeStorageVideo(video);
	const [bucket] =
		await Storage.getAccessForVideo(storageVideo).pipe(runPromise);
	const manifest = normalizeBrowserStudioManifest({
		...body.manifest,
		updatedAt: Date.now(),
	});
	const sources = await loadRenderSources(bucket, video, manifest);
	const plan = buildBrowserStudioRenderPlan(manifest, sources);
	const render = await renderBrowserStudioMp4(plan);

	try {
		const [videoBuffer, thumbnailBuffer] = await Promise.all([
			fs.readFile(render.filePath),
			fs.readFile(render.thumbnailPath),
		]);
		const resultKey = getVideoKey(video.ownerId, video.id, "result.mp4");
		const thumbnailKey = getVideoKey(
			video.ownerId,
			video.id,
			"screenshot/screen-capture.jpg",
		);

		await Promise.all([
			bucket
				.putObject(resultKey, videoBuffer, {
					contentType: "video/mp4",
					contentLength: videoBuffer.byteLength,
				})
				.pipe(runPromise),
			bucket
				.putObject(thumbnailKey, thumbnailBuffer, {
					contentType: "image/jpeg",
					contentLength: thumbnailBuffer.byteLength,
				})
				.pipe(runPromise),
			persistManifest(bucket, video, manifest),
			db()
				.update(videos)
				.set({
					duration: plan.durationMs / 1000,
					width: plan.outputWidth,
					height: plan.outputHeight,
					fps: video.fps,
				})
				.where(eq(videos.id, Video.VideoId.make(video.id))),
			db()
				.update(videoUploads)
				.set({
					phase: "complete",
					processingProgress: 100,
					processingMessage: "Studio export complete",
					processingError: null,
					updatedAt: new Date(),
				})
				.where(eq(videoUploads.videoId, Video.VideoId.make(video.id))),
		]);

		return Response.json(
			{
				manifest,
				result: {
					duration: plan.durationMs / 1000,
					width: plan.outputWidth,
					height: plan.outputHeight,
				},
			},
			{ status: 200 },
		);
	} finally {
		await render.cleanup();
	}
}
