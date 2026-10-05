"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { videos } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import type { User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";
import {
	inspectLinkPreviewImage,
	isLinkPreviewImageKey,
	type LinkPreviewErrors,
	type LinkPreviewState,
	linkPreviewImageKey,
	readLinkPreview,
	type StoredLinkPreview,
	type StoredLinkPreviewImage,
	toLinkPreviewState,
	validateLinkPreviewText,
} from "@/lib/share-link-preview";

export type LinkPreviewActionResult =
	| { success: true; linkPreview: LinkPreviewState | null }
	| { success: false; errors: LinkPreviewErrors; upgradeRequired?: true };

async function loadOwnedVideo(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!videoId) throw new Error("Missing video");

	const [video] = await db()
		.select({ ownerId: videos.ownerId, metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) {
		throw new Error("You don't have permission to update this video");
	}

	return { user, existing: readLinkPreview(video.metadata, videoId) };
}

const writeLinkPreview = (
	videoId: Video.VideoId,
	ownerId: User.UserId,
	linkPreview: StoredLinkPreview | null,
) =>
	db()
		.update(videos)
		.set({
			metadata: linkPreview
				? sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.linkPreview', CAST(${JSON.stringify(linkPreview)} AS JSON))`
				: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.linkPreview')`,
		})
		.where(and(eq(videos.id, videoId), eq(videos.ownerId, ownerId)));

// The image lives in Cap's own bucket, like avatars and organization icons,
// so it does not depend on the video's storage being reachable.
const putImage = (key: string, bytes: Uint8Array, contentType: string) =>
	Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
		yield* bucket.putObject(key, bytes, {
			contentType,
			contentLength: bytes.byteLength,
		});
	}).pipe(runPromise);

const deleteImage = async (videoId: Video.VideoId, key: string) => {
	if (!isLinkPreviewImageKey(videoId, key)) return;
	try {
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			yield* bucket.deleteObject(key);
		}).pipe(runPromise);
	} catch (error) {
		console.error(
			`[link-preview] Failed to delete old preview image for ${videoId}:`,
			error,
		);
	}
};

const readField = (formData: FormData, name: string) => {
	const value = formData.get(name);
	return typeof value === "string" ? value : null;
};

/**
 * Sets a Cap's link preview. Form fields: `videoId`, `title`, `description`,
 * an optional `image` file to replace the image, and `removeImage=1` to drop
 * it. Blank text fields fall back to the defaults.
 */
export async function saveLinkPreview(
	formData: FormData,
): Promise<LinkPreviewActionResult> {
	const videoId = (readField(formData, "videoId") ?? "") as Video.VideoId;
	const { user, existing } = await loadOwnedVideo(videoId);

	if (!userIsPro(user)) {
		return { success: false, errors: {}, upgradeRequired: true };
	}

	const text = validateLinkPreviewText({
		title: readField(formData, "title"),
		description: readField(formData, "description"),
	});
	const errors: LinkPreviewErrors = text.ok ? {} : { ...text.errors };

	const file = formData.get("image");
	let upload: { bytes: Uint8Array; image: StoredLinkPreviewImage } | null =
		null;
	if (file instanceof File && file.size > 0) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const inspection = inspectLinkPreviewImage(bytes);
		if (inspection.ok) {
			upload = {
				bytes,
				image: {
					key: linkPreviewImageKey(
						videoId,
						inspection.contentType,
						`${Date.now().toString(36)}${nanoId().slice(0, 6)}`,
					),
					width: inspection.width,
					height: inspection.height,
					contentType: inspection.contentType,
					size: bytes.byteLength,
				},
			};
		} else {
			errors.image = inspection.error;
		}
	}

	if (!text.ok || errors.image) return { success: false, errors };

	const removeImage = readField(formData, "removeImage") === "1";
	const image = upload?.image ?? (removeImage ? undefined : existing?.image);
	const { title, description } = text.value;

	const next: StoredLinkPreview | null =
		title || description || image
			? {
					version: 1,
					...(title ? { title } : {}),
					...(description ? { description } : {}),
					...(image ? { image } : {}),
					updatedAt: new Date().toISOString(),
				}
			: null;

	if (upload) {
		await putImage(upload.image.key, upload.bytes, upload.image.contentType);
	}

	try {
		await writeLinkPreview(videoId, user.id, next);
	} catch (error) {
		if (upload) await deleteImage(videoId, upload.image.key);
		throw error;
	}

	if (existing?.image && existing.image.key !== image?.key) {
		await deleteImage(videoId, existing.image.key);
	}

	revalidatePath(`/s/${videoId}`);

	return { success: true, linkPreview: toLinkPreviewState(videoId, next) };
}

/**
 * Puts the default preview back. Allowed without Cap Pro, so an owner who
 * downgraded can still take down what they set.
 */
export async function resetLinkPreview(
	videoId: Video.VideoId,
): Promise<LinkPreviewActionResult> {
	const { user, existing } = await loadOwnedVideo(videoId);

	await writeLinkPreview(videoId, user.id, null);
	if (existing?.image) await deleteImage(videoId, existing.image.key);

	revalidatePath(`/s/${videoId}`);

	return { success: true, linkPreview: null };
}
