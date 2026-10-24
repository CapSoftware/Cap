import "server-only";

import { db } from "@cap/database";
import {
	importedVideos,
	organizationMembers,
	sharedVideos,
	spaceVideos,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { Organisation, User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Option } from "effect";
import { runPromise } from "@/lib/server";

export type LoomReassignOutcome =
	| { videoId: string; status: "moved"; copiedObjects: number }
	| { videoId: string; status: "skipped" | "failed"; reason: string };

function getAffectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

function storageVideo(id: string, ownerId: string, orgId: string) {
	return Video.Video.make({
		id: Video.VideoId.make(id),
		ownerId: User.UserId.make(ownerId),
		orgId: Organisation.OrganisationId.make(orgId),
		name: "Loom import owner change",
		public: false,
		source: { type: "MediaConvert" },
		metadata: Option.none(),
		bucketId: Option.none(),
		storageIntegrationId: Option.none(),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.none(),
		height: Option.none(),
		duration: Option.none(),
		createdAt: new Date(0),
		updatedAt: new Date(0),
	});
}

async function listObjects(videoId: string, ownerId: string, orgId: string) {
	const [bucket] = await runPromise(
		Storage.getAccessForVideo(storageVideo(videoId, ownerId, orgId)),
	);
	const prefix = `${ownerId}/${videoId}/`;
	const objects: Array<{ key: string; size: number }> = [];
	let continuationToken: string | undefined;
	do {
		const page = await runPromise(
			bucket.listObjects({ prefix, maxKeys: 1_000, continuationToken }),
		);
		for (const object of page.Contents ?? []) {
			if (!object.Key || object.Size === undefined) continue;
			objects.push({ key: object.Key, size: object.Size });
		}
		continuationToken = page.IsTruncated
			? page.NextContinuationToken
			: undefined;
	} while (continuationToken);
	return { bucket, prefix, objects };
}

export async function reassignLoomImport({
	organizationId,
	videoId,
	fromUserId,
	toUserId,
}: {
	organizationId: string;
	videoId: string;
	fromUserId: string;
	toUserId: string;
}): Promise<LoomReassignOutcome> {
	const id = Video.VideoId.make(videoId);
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			orgId: videos.orgId,
			bucketId: videos.bucket,
			storageIntegrationId: videos.storageIntegrationId,
			uploadPhase: videoUploads.phase,
		})
		.from(videos)
		.innerJoin(
			importedVideos,
			and(
				eq(importedVideos.id, videos.id),
				eq(importedVideos.orgId, videos.orgId),
				eq(importedVideos.source, "loom"),
			),
		)
		.leftJoin(videoUploads, eq(videoUploads.videoId, videos.id))
		.where(eq(videos.id, id))
		.limit(1);
	if (!video || video.orgId !== organizationId)
		return { videoId, status: "skipped", reason: "not a Loom import here" };
	if (video.ownerId === toUserId)
		return { videoId, status: "skipped", reason: "already owned" };
	if (video.ownerId !== fromUserId)
		return { videoId, status: "skipped", reason: "different owner" };
	if (video.bucketId || video.storageIntegrationId)
		return { videoId, status: "skipped", reason: "custom storage" };
	if (video.uploadPhase)
		return { videoId, status: "skipped", reason: "import not finished" };

	const [member] = await db()
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(
					organizationMembers.organizationId,
					Organisation.OrganisationId.make(organizationId),
				),
				eq(organizationMembers.userId, User.UserId.make(toUserId)),
			),
		)
		.limit(1);
	if (!member)
		return { videoId, status: "skipped", reason: "new owner not a member" };

	const source = await listObjects(videoId, fromUserId, organizationId);
	if (source.objects.length === 0)
		return { videoId, status: "failed", reason: "no media found" };
	const destinationPrefix = `${toUserId}/${videoId}/`;
	let copiedObjects = 0;
	for (let index = 0; index < source.objects.length; index += 4) {
		await Promise.all(
			source.objects.slice(index, index + 4).map(async (object) => {
				const destinationKey = object.key.replace(
					source.prefix,
					destinationPrefix,
				);
				await runPromise(
					source.bucket.copyObject(
						`${source.bucket.bucketName}/${object.key}`,
						destinationKey,
					),
				);
				const head = await runPromise(source.bucket.headObject(destinationKey));
				if (head.ContentLength !== object.size)
					throw new Error(`Copied object size mismatch for ${object.key}`);
				copiedObjects++;
			}),
		);
	}

	const updated = await db().transaction(async (tx) => {
		const result = await tx
			.update(videos)
			.set({ ownerId: User.UserId.make(toUserId), public: false })
			.where(
				and(
					eq(videos.id, id),
					eq(videos.ownerId, User.UserId.make(fromUserId)),
				),
			);
		if (getAffectedRows(result) !== 1) return false;
		await tx.delete(sharedVideos).where(eq(sharedVideos.videoId, id));
		await tx.delete(spaceVideos).where(eq(spaceVideos.videoId, id));
		return true;
	});
	if (!updated)
		return { videoId, status: "failed", reason: "owner changed during move" };

	await runPromise(
		source.bucket.deleteObjects(
			source.objects.map((object) => ({ Key: object.key })),
		),
	).catch(() => undefined);
	return { videoId, status: "moved", copiedObjects };
}
