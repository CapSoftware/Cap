import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { type Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import {
	BROWSER_STUDIO_MANIFEST_SUBPATH,
	type BrowserStudioCloudManifest,
	type BrowserStudioSource,
	createFallbackBrowserStudioManifest,
	isBrowserStudioCloudManifest,
	normalizeBrowserStudioManifest,
	uniqueBrowserStudioSourceSubpaths,
} from "@/lib/browser-studio";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

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

const getManifestKey = (ownerId: string, videoId: string) =>
	`${ownerId}/${videoId}/${BROWSER_STUDIO_MANIFEST_SUBPATH}`;

const getVideoKey = (ownerId: string, videoId: string, subpath: string) =>
	`${ownerId}/${videoId}/${subpath}`;

type StudioBucket = {
	getObject: (
		key: string,
	) => Effect.Effect<Option.Option<string>, unknown, never>;
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
		body: string,
		fields: {
			contentType?: string;
			contentLength?: number;
		},
	) => Effect.Effect<unknown, unknown, never>;
};

const loadManifest = async (
	bucket: StudioBucket,
	video: typeof videos.$inferSelect,
) => {
	const object = await bucket
		.getObject(getManifestKey(video.ownerId, video.id))
		.pipe(runPromise);

	if (Option.isSome(object)) {
		try {
			const parsed = JSON.parse(object.value) as unknown;
			if (isBrowserStudioCloudManifest(parsed)) {
				return normalizeBrowserStudioManifest(parsed);
			}
		} catch {}
	}

	return createFallbackBrowserStudioManifest({
		videoId: video.id,
		title: video.name,
		durationMs: video.duration ? video.duration * 1000 : null,
		width: video.width,
		height: video.height,
	});
};

const loadSources = async (
	bucket: StudioBucket,
	video: typeof videos.$inferSelect,
	manifest: BrowserStudioCloudManifest,
): Promise<BrowserStudioSource[]> =>
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

export async function GET(request: NextRequest) {
	const user = await getCurrentUser();
	const videoId = request.nextUrl.searchParams.get("videoId");

	if (!user?.id) return Response.json({ error: true }, { status: 401 });
	if (!videoId) return Response.json({ error: true }, { status: 400 });

	const video = await findOwnedVideo(videoId, user.id);
	if (!video) return Response.json({ error: true }, { status: 404 });

	const storageVideo = decodeStorageVideo(video);
	const [bucket] =
		await Storage.getAccessForVideo(storageVideo).pipe(runPromise);
	const manifest = await loadManifest(bucket, video);
	const sources = await loadSources(bucket, video, manifest);

	return Response.json({ manifest, sources }, { status: 200 });
}

export async function PUT(request: NextRequest) {
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

	const manifest = normalizeBrowserStudioManifest({
		...body.manifest,
		updatedAt: Date.now(),
	});
	const payload = JSON.stringify(manifest);
	const storageVideo = decodeStorageVideo(video);
	const [bucket] =
		await Storage.getAccessForVideo(storageVideo).pipe(runPromise);

	await bucket
		.putObject(getManifestKey(video.ownerId, video.id), payload, {
			contentType: "application/json",
			contentLength: new TextEncoder().encode(payload).byteLength,
		})
		.pipe(runPromise);

	return Response.json({ manifest }, { status: 200 });
}
