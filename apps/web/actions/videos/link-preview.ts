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

async function readOwnedLinkPreview(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!videoId) throw new Error("Missing video");
	return { user, current: await readExisting(videoId, user.id) };
}

async function readExisting(videoId: Video.VideoId, userId: User.UserId) {
	const [video] = await db()
		.select({ ownerId: videos.ownerId, metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== userId) {
		throw new Error("You don't have permission to update this video");
	}
	const raw = (
		video.metadata as { linkPreview?: { image?: { key?: unknown } } }
	)?.linkPreview?.image?.key;
	return {
		stored: readLinkPreview(video.metadata, videoId),
		// The raw key, not the validated one: a duplicated Cap carries its
		// original's key, which reading ignores but the compare must still see.
		imageKey: typeof raw === "string" ? raw : null,
	};
}

type Existing = Awaited<ReturnType<typeof readExisting>>;

const affectedRows = (result: unknown) => {
	const header = Array.isArray(result) ? result[0] : result;
	return typeof header === "object" &&
		header !== null &&
		"affectedRows" in header &&
		typeof header.affectedRows === "number"
		? header.affectedRows
		: 0;
};

// Compare-and-set on the stored image key: a write only lands if the image is
// still the one this request read, so an image another request swapped in is
// never overwritten with a stale one, and the image this write replaced is
// referenced by nothing once it succeeds.
const writeLinkPreview = async (
	videoId: Video.VideoId,
	ownerId: User.UserId,
	expectedImageKey: string | null,
	linkPreview: StoredLinkPreview | null,
) => {
	const result = await db()
		.update(videos)
		.set({
			metadata: linkPreview
				? sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.linkPreview', CAST(${JSON.stringify(linkPreview)} AS JSON))`
				: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.linkPreview')`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				eq(videos.ownerId, ownerId),
				sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.linkPreview.image.key')), '') = ${expectedImageKey ?? ""}`,
			),
		);
	return affectedRows(result) > 0;
};

const MAX_WRITE_ATTEMPTS = 3;

/**
 * Re-reads and retries when another save or reset got there first. Returns
 * the image key the successful write replaced.
 */
async function writeWithRetry(
	videoId: Video.VideoId,
	ownerId: User.UserId,
	initial: Existing,
	build: (existing: StoredLinkPreview | null) => StoredLinkPreview | null,
) {
	let current = initial;
	for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
		const next = build(current.stored);
		if (!next && !current.stored && !current.imageKey) {
			return { next, replacedImageKey: null };
		}
		if (await writeLinkPreview(videoId, ownerId, current.imageKey, next)) {
			return { next, replacedImageKey: current.imageKey };
		}
		current = await readExisting(videoId, ownerId);
	}
	throw new Error("The link preview changed while saving. Please try again.");
}

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
		console.error("[link-preview] Failed to delete an old preview image", {
			videoId,
			key,
			error,
		});
	}
};

const readField = (formData: FormData, name: string) => {
	const value = formData.get(name);
	return typeof value === "string" ? value : null;
};

export async function saveLinkPreview(
	formData: FormData,
): Promise<LinkPreviewActionResult> {
	const videoId = (readField(formData, "videoId") ?? "") as Video.VideoId;
	const { user, current } = await readOwnedLinkPreview(videoId);

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
					// Unique per upload, so no two requests ever share an object.
					key: linkPreviewImageKey(
						videoId,
						inspection.contentType,
						`${Date.now().toString(36)}${nanoId()}`,
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
	const { title, description } = text.value;
	const build = (
		current: StoredLinkPreview | null,
	): StoredLinkPreview | null => {
		const image = upload?.image ?? (removeImage ? undefined : current?.image);
		return title || description || image
			? {
					version: 1,
					...(title ? { title } : {}),
					...(description ? { description } : {}),
					...(image ? { image } : {}),
					updatedAt: new Date().toISOString(),
				}
			: null;
	};

	if (upload) {
		await putImage(upload.image.key, upload.bytes, upload.image.contentType);
	}

	let written: Awaited<ReturnType<typeof writeWithRetry>>;
	try {
		written = await writeWithRetry(videoId, user.id, current, build);
	} catch (error) {
		if (upload) await deleteImage(videoId, upload.image.key);
		throw error;
	}

	const { next, replacedImageKey } = written;
	if (replacedImageKey && replacedImageKey !== next?.image?.key) {
		await deleteImage(videoId, replacedImageKey);
	}

	revalidatePath(`/s/${videoId}`);

	return { success: true, linkPreview: toLinkPreviewState(videoId, next) };
}

/**
 * Allowed without Cap Pro, so an owner who downgraded can clear what they
 * saved instead of keeping it for later.
 */
export async function resetLinkPreview(
	videoId: Video.VideoId,
): Promise<LinkPreviewActionResult> {
	const { user, current } = await readOwnedLinkPreview(videoId);

	const { replacedImageKey } = await writeWithRetry(
		videoId,
		user.id,
		current,
		() => null,
	);
	if (replacedImageKey) await deleteImage(videoId, replacedImageKey);

	revalidatePath(`/s/${videoId}`);

	return { success: true, linkPreview: null };
}
