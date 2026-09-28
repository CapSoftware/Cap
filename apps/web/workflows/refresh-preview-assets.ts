import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError, RetryableError } from "workflow";
import { fetchPreviewAssetsViaMediaServer } from "@/lib/media-client";
import {
	findOutputPreviewAssets,
	getOutputPreviewAssetKeys,
	getReplacementAwaitingPreviewAssets,
} from "@/lib/published-preview-assets";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const PRESIGNED_EXPIRES_SECONDS = 60 * 60;

type RefreshPreviewAssetsInput = { videoId: string; outputKey: string };

async function loadVideoAwaitingAssets({
	videoId,
	outputKey,
}: RefreshPreviewAssetsInput) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));
	return video && getReplacementAwaitingPreviewAssets(video) === outputKey
		? video
		: null;
}

async function renderPreviewAssetsStep(input: RefreshPreviewAssetsInput) {
	"use step";

	const video = await loadVideoAwaitingAssets(input);
	if (!video) return false;
	const [bucket] = await Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(runWorkflowPromise);
	const { thumbnailKey, previewKey } = getOutputPreviewAssetKeys(
		input.outputKey,
	);
	const expiresIn = { expiresIn: PRESIGNED_EXPIRES_SECONDS };
	const [videoUrl, thumbnailPresignedUrl, previewGifPresignedUrl] =
		await Promise.all([
			bucket
				.getInternalSignedObjectUrl(input.outputKey, expiresIn)
				.pipe(runWorkflowPromise),
			bucket
				.getInternalPresignedPutUrl(
					thumbnailKey,
					{ ContentType: "image/jpeg" },
					expiresIn,
				)
				.pipe(runWorkflowPromise),
			bucket
				.getInternalPresignedPutUrl(
					previewKey,
					{
						ContentType: "image/gif",
						CacheControl: "public, max-age=31536000, immutable",
					},
					expiresIn,
				)
				.pipe(runWorkflowPromise),
		]);
	const response = await fetchPreviewAssetsViaMediaServer({
		videoUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
	});
	if (response.ok) return true;
	const details = await response.text().catch(() => "");
	if (response.status === 503 || response.status === 429) {
		throw new RetryableError("Media server is busy", {
			retryAfter: "1 minute",
		});
	}
	// Anything else, like a GIF this video can't make, fails the same way again.
	throw new FatalError(
		`Preview assets failed (${response.status}): ${details.slice(0, 300)}`,
	);
}

renderPreviewAssetsStep.maxRetries = 3;

async function publishPreviewAssetsStep(input: RefreshPreviewAssetsInput) {
	"use step";

	const video = await loadVideoAwaitingAssets(input);
	if (!video) return;
	const assets = await findOutputPreviewAssets(video, input.outputKey);
	if (!assets.thumbnailKey && !assets.previewKey) {
		throw new Error("Preview assets were not stored");
	}
	await db().transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, video.id))
			.for("update");
		if (
			!locked ||
			getReplacementAwaitingPreviewAssets(locked) !== input.outputKey
		)
			return;
		await tx
			.update(videos)
			.set({ source: { ...locked.source, ...assets } })
			.where(eq(videos.id, locked.id));
	});
}

/**
 * Makes the thumbnail and preview GIF from a video's published output, once
 * it has replaced the upload they were first made from.
 */
export async function refreshPreviewAssetsWorkflow(
	input: RefreshPreviewAssetsInput,
) {
	"use workflow";

	if (await renderPreviewAssetsStep(input)) {
		await publishPreviewAssetsStep(input);
	}
}
