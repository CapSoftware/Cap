"use server";

import { randomBytes } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import {
	type CustomThumbnailMetadata,
	customThumbnailKey,
	getCustomThumbnailMetadata,
	Storage,
} from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { getFfmpegPath } from "@/lib/audio-extract";
import {
	CUSTOM_THUMBNAIL_FRAME_FILTER,
	CUSTOM_THUMBNAIL_MAX_BYTES,
	clampThumbnailFrameTime,
	isJpegData,
} from "@/lib/custom-thumbnail";
import { grabFrame } from "@/lib/og/poster-frame";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

const FRAME_TIMEOUT_MS = 20_000;

export type CustomThumbnailResult =
	| { success: true }
	| { success: false; error: string };

type OwnedVideo = typeof videos.$inferSelect;

async function loadOwnedVideo(
	videoId: Video.VideoId,
): Promise<OwnedVideo | string> {
	const user = await getCurrentUser();
	if (!user) return "Sign in to change this thumbnail";

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video || video.ownerId !== user.id) {
		return "Only the owner can change this thumbnail";
	}
	if (video.isScreenshot) {
		return "Screenshots already use the image as their thumbnail";
	}
	return video;
}

const newThumbnailFileName = () =>
	`custom-${Date.now().toString(36)}${randomBytes(3).toString("hex")}.jpg`;

function writeCustomThumbnailMetadata(
	video: OwnedVideo,
	value: CustomThumbnailMetadata | null,
) {
	const patch = JSON.stringify({ customThumbnail: value });
	return db()
		.update(videos)
		.set({
			metadata: sql`JSON_MERGE_PATCH(JSON_MERGE_PATCH(COALESCE(${videos.metadata}, JSON_OBJECT()), CAST('{"customThumbnail":null}' AS JSON)), CAST(${patch} AS JSON))`,
		})
		.where(and(eq(videos.id, video.id), eq(videos.ownerId, video.ownerId)));
}

const deleteThumbnailObject = (video: OwnedVideo, file: string) =>
	Effect.gen(function* () {
		const [bucket] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
		);
		yield* bucket.deleteObject(
			customThumbnailKey({ id: video.id, ownerId: video.ownerId, file }),
		);
	})
		.pipe(runPromise)
		.catch((error) => {
			console.warn(
				`[custom-thumbnail] Failed to delete old thumbnail for ${video.id}`,
				error,
			);
		});

async function saveCustomThumbnail(
	video: OwnedVideo,
	data: Uint8Array,
	details: Pick<CustomThumbnailMetadata, "source" | "time">,
) {
	const previous = getCustomThumbnailMetadata(video.metadata);
	const file = newThumbnailFileName();

	await Effect.gen(function* () {
		const [bucket] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
		);
		yield* bucket.putObject(
			customThumbnailKey({ id: video.id, ownerId: video.ownerId, file }),
			data,
			{ contentType: "image/jpeg", contentLength: data.byteLength },
		);
	}).pipe(runPromise);

	await writeCustomThumbnailMetadata(video, {
		file,
		source: details.source,
		...(details.time === undefined ? {} : { time: details.time }),
		updatedAt: new Date().toISOString(),
	});

	if (previous && previous.file !== file) {
		await deleteThumbnailObject(video, previous.file);
	}
}

export async function uploadCustomThumbnail(
	formData: FormData,
): Promise<CustomThumbnailResult> {
	const videoId = formData.get("videoId");
	const image = formData.get("image");
	if (typeof videoId !== "string" || !(image instanceof Blob)) {
		return { success: false, error: "Choose an image to upload" };
	}
	if (image.size === 0 || image.size > CUSTOM_THUMBNAIL_MAX_BYTES) {
		return { success: false, error: "That image is too large" };
	}

	const video = await loadOwnedVideo(Video.VideoId.make(videoId));
	if (typeof video === "string") return { success: false, error: video };

	const data = new Uint8Array(await image.arrayBuffer());
	if (!isJpegData(data)) {
		return { success: false, error: "That file isn't a valid image" };
	}

	try {
		await saveCustomThumbnail(video, data, { source: "upload" });
		return { success: true };
	} catch (error) {
		console.error(`[custom-thumbnail] Upload failed for ${video.id}`, error);
		return { success: false, error: "Couldn't save the thumbnail" };
	}
}

export async function setCustomThumbnailFromFrame(
	videoId: Video.VideoId,
	time: number,
): Promise<CustomThumbnailResult> {
	const video = await loadOwnedVideo(videoId);
	if (typeof video === "string") return { success: false, error: video };

	const seek = clampThumbnailFrameTime(time, video.duration);
	if (seek === null) return { success: false, error: "Pick a frame first" };

	try {
		const sourceUrl = await Effect.gen(function* () {
			const storageVideo = decodeStorageVideo(video);
			const source = Video.Video.getSource(storageVideo);
			if (!(source instanceof Video.Mp4Source)) return null;
			const [bucket] = yield* Storage.getAccessForVideo(storageVideo);
			return yield* bucket.getInternalSignedObjectUrl(source.getFileKey());
		}).pipe(runPromise);

		if (!sourceUrl) {
			return {
				success: false,
				error: "Frames can be picked once the video finishes processing",
			};
		}

		const frame = await grabFrame(
			getFfmpegPath(),
			sourceUrl,
			seek.toFixed(3),
			FRAME_TIMEOUT_MS,
			{ filter: CUSTOM_THUMBNAIL_FRAME_FILTER, quality: "3" },
		);
		const data = new Uint8Array(frame);
		if (!isJpegData(data) || data.byteLength > 8 * 1024 * 1024) {
			return { success: false, error: "Couldn't read that frame" };
		}

		await saveCustomThumbnail(video, data, { source: "frame", time: seek });
		return { success: true };
	} catch (error) {
		console.error(`[custom-thumbnail] Frame failed for ${video.id}`, error);
		return { success: false, error: "Couldn't read that frame" };
	}
}

export async function resetCustomThumbnail(
	videoId: Video.VideoId,
): Promise<CustomThumbnailResult> {
	const video = await loadOwnedVideo(videoId);
	if (typeof video === "string") return { success: false, error: video };

	const previous = getCustomThumbnailMetadata(video.metadata);
	if (!previous) return { success: true };

	try {
		await writeCustomThumbnailMetadata(video, null);
	} catch (error) {
		console.error(`[custom-thumbnail] Reset failed for ${video.id}`, error);
		return { success: false, error: "Couldn't reset the thumbnail" };
	}
	await deleteThumbnailObject(video, previous.file);
	return { success: true };
}
