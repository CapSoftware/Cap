import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videoEdits, videos, videoUploads } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function POST(request: NextRequest) {
	if (process.env.NODE_ENV !== "development") {
		return Response.json({ error: "dev only" }, { status: 403 });
	}
	if (request.headers.get("origin") !== request.nextUrl.origin) {
		return Response.json({ error: "same origin required" }, { status: 403 });
	}
	const user = await getCurrentUser();
	if (!user) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const videoIdParam = request.nextUrl.searchParams.get("videoId");
	if (!videoIdParam) {
		return Response.json({ error: "videoId required" }, { status: 400 });
	}
	const videoId = videoIdParam as Video.VideoId;

	const [video] = await db()
		.select()
		.from(videos)
		.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));
	if (!video) {
		return Response.json({ error: "video not found" }, { status: 404 });
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const deleted: string[] = [];
	for (const prefix of [
		`${video.ownerId}/${video.id}/transcription`,
		`${video.ownerId}/${video.id}/audio`,
	]) {
		const listed = await bucket.listObjects({ prefix }).pipe(runPromise);
		const objects = (listed.Contents ?? [])
			.map((object) => ({ Key: object.Key }))
			.filter((object): object is { Key: string } => Boolean(object.Key));
		if (objects.length > 0) {
			await bucket.deleteObjects(objects).pipe(runPromise);
			deleted.push(...objects.map((object) => object.Key));
		}
	}

	const [edit] = await db()
		.select()
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));
	let restoredOriginal = false;
	let restoredDuration: number | null = null;
	if (edit) {
		await bucket
			.copyObject(
				`${bucket.bucketName}/${edit.sourceKey}`,
				`${video.ownerId}/${video.id}/result.mp4`,
			)
			.pipe(runPromise);
		await bucket.deleteObject(edit.sourceKey).pipe(runPromise);
		deleted.push(edit.sourceKey);
		restoredOriginal = true;
		restoredDuration = edit.editSpec.sourceDuration;
		await db().delete(videoEdits).where(eq(videoEdits.videoId, videoId));
	}

	const metadata = {
		...((video.metadata as Record<string, unknown> | null) ?? {}),
	};
	delete metadata.summary;
	delete metadata.chapters;
	delete metadata.aiGenerationStatus;
	delete metadata.editTranscriptBackfill;

	await db()
		.update(videos)
		.set({
			transcriptionStatus: null,
			metadata,
			...(restoredDuration === null ? {} : { duration: restoredDuration }),
		})
		.where(eq(videos.id, videoId));
	await db().delete(videoUploads).where(eq(videoUploads.videoId, videoId));

	return Response.json({
		ok: true,
		resolvedBucket: bucket.bucketName,
		deleted,
		restoredOriginal,
		restoredDuration,
	});
}
