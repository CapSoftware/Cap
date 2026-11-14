import "server-only";

import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { makeCurrentUser, Storage, VideosPolicy } from "@cap/web-backend";
import { CurrentUser, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";
import { resolveVideoDownloadAccess } from "@/lib/video-download-access";
import { decodeStorageVideo } from "@/lib/video-storage";

type SessionUser = Parameters<typeof makeCurrentUser>[0];

export type VideoAudioSource =
	| { success: true; sourceUrl: string; filename: string }
	| { success: false; status: 403 | 404 | 409 | 429 | 500; error: string };

const SOURCE_URL_EXPIRES_SECONDS = 60 * 60;
const STILL_PROCESSING =
	"Video is still processing. Try again once it has finished.";

export async function resolveVideoAudioSource(
	videoId: Video.VideoId,
	user: SessionUser | null,
): Promise<VideoAudioSource> {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) {
		return { success: false, status: 404, error: "Video not found" };
	}

	const viewer = Option.fromNullable(user).pipe(Option.map(makeCurrentUser));
	const access = await resolveVideoDownloadAccess({
		viewer,
		video,
		variant: "current",
	});

	if (access === "rate_limited") {
		return {
			success: false,
			status: 429,
			error: "Too many downloads. Please wait a moment and try again.",
		};
	}

	if (access === "denied") {
		return user
			? {
					success: false,
					status: 403,
					error: "You don't have permission to download this video",
				}
			: { success: false, status: 404, error: "Video not found" };
	}

	if (video.source?.type === "desktopSegments") {
		return { success: false, status: 409, error: STILL_PROCESSING };
	}

	const [activeUpload] = await db()
		.select({ phase: videoUploads.phase })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));

	if (activeUpload && activeUpload.phase !== "complete") {
		return {
			success: false,
			status: 409,
			error:
				activeUpload.phase === "error"
					? "Video processing failed, so there is no audio to download."
					: STILL_PROCESSING,
		};
	}

	const decodedVideo = decodeStorageVideo(video);
	const source = Video.Video.getSource(decodedVideo);

	if (access === "viewer" && !(source instanceof Video.Mp4Source)) {
		return {
			success: false,
			status: 404,
			error: "Audio is not available for download yet.",
		};
	}

	const sourceKey =
		source instanceof Video.Mp4Source
			? source.getFileKey()
			: `${video.ownerId}/${video.id}/result.mp4`;

	try {
		const sourceUrl = await Effect.gen(function* () {
			const videosPolicy = yield* VideosPolicy;
			yield* videosPolicy.canViewLoaded(
				decodedVideo,
				Option.fromNullable(video.password),
			);
			const [bucket] = yield* Storage.getAccessForVideo(decodedVideo);
			const exists = yield* bucket.headObject(sourceKey).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			if (!exists) return null;
			return yield* bucket.getInternalSignedObjectUrl(sourceKey, {
				expiresIn: SOURCE_URL_EXPIRES_SECONDS,
			});
		}).pipe(
			(effect) =>
				Option.isSome(viewer)
					? Effect.provideService(effect, CurrentUser, viewer.value)
					: effect,
			runPromise,
		);

		if (!sourceUrl) {
			return {
				success: false,
				status: 404,
				error: "Audio is not available for download yet.",
			};
		}

		return {
			success: true,
			sourceUrl,
			filename: `${video.name}.mp3`,
		};
	} catch (error) {
		console.error("Error preparing audio download:", error);
		return {
			success: false,
			status: 500,
			error: "Failed to prepare the audio download.",
		};
	}
}
