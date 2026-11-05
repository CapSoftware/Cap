import "server-only";

import { randomUUID } from "node:crypto";
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
import { Folder, Organisation, User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Option } from "effect";
import { getEditTranscriptObjectKey } from "@/lib/edit-transcript";
import {
	decryptEditTranscriptObject,
	encryptEditTranscriptObject,
} from "@/lib/edit-transcript-storage";
import {
	getOwnerOriginalKey,
	LOOM_REASSIGN_CLAIM_TTL_MS,
} from "@/lib/loom-original-key";
import { runPromise } from "@/lib/server";

export type LoomReassignOptions = {
	keepSharing?: boolean;
	folderId?: string | null;
};

export type LoomReassignOutcome =
	| {
			videoId: string;
			status: "moved";
			copiedObjects: number;
			cleanup: "done" | "failed";
	  }
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
	options = {},
}: {
	organizationId: string;
	videoId: string;
	fromUserId: string;
	toUserId: string;
	options?: LoomReassignOptions;
}): Promise<LoomReassignOutcome> {
	const id = Video.VideoId.make(videoId);
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			orgId: videos.orgId,
			source: videos.source,
			metadata: videos.metadata,
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
	if (video.source && "outputKey" in video.source && video.source.outputKey)
		return { videoId, status: "skipped", reason: "edited video" };
	if (video.metadata?.loomDeferredProcessing?.status === "started")
		return { videoId, status: "skipped", reason: "conversion running" };

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

	const token = randomUUID();
	const claimedAt = new Date();
	const claim = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.loomReassignClaim', JSON_OBJECT('token', ${token}, 'at', ${claimedAt.toISOString()}))`,
		})
		.where(
			and(
				eq(videos.id, id),
				eq(videos.ownerId, User.UserId.make(fromUserId)),
				sql`(JSON_EXTRACT(${videos.metadata}, '$.loomReassignClaim') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomReassignClaim.at')) < ${new Date(claimedAt.getTime() - LOOM_REASSIGN_CLAIM_TTL_MS).toISOString()})`,
			),
		);
	if (getAffectedRows(claim) !== 1)
		return { videoId, status: "skipped", reason: "another move is running" };
	try {
		return await moveClaimedVideo({
			id,
			videoId,
			organizationId,
			fromUserId,
			toUserId,
			token,
			options,
			originalKey: video.metadata?.loomDeferredProcessing?.rawFileKey,
		});
	} finally {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_REMOVE(${videos.metadata}, '$.loomReassignClaim')`,
			})
			.where(
				and(
					eq(videos.id, id),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomReassignClaim.token')) = ${token}`,
				),
			);
	}
}

async function moveClaimedVideo({
	id,
	videoId,
	organizationId,
	fromUserId,
	toUserId,
	token,
	options,
	originalKey,
}: {
	id: Video.VideoId;
	videoId: string;
	organizationId: string;
	fromUserId: string;
	toUserId: string;
	token: string;
	options: LoomReassignOptions;
	originalKey: unknown;
}): Promise<LoomReassignOutcome> {
	const source = await listObjects(videoId, fromUserId, organizationId);
	if (source.objects.length === 0)
		return { videoId, status: "failed", reason: "no media found" };
	const destination = await listObjects(videoId, toUserId, organizationId);
	if (destination.objects.length > 0)
		return {
			videoId,
			status: "skipped",
			reason: "new owner already has files for this video",
		};

	const transcriptKey = getEditTranscriptObjectKey(fromUserId, videoId);
	const written: string[] = [];
	try {
		for (let index = 0; index < source.objects.length; index += 4) {
			await Promise.all(
				source.objects.slice(index, index + 4).map(async (object) => {
					const destinationKey = object.key.replace(
						source.prefix,
						destination.prefix,
					);
					written.push(destinationKey);
					if (object.key === transcriptKey) {
						const stored = Option.getOrNull(
							await runPromise(source.bucket.getObject(object.key)),
						);
						const transcript =
							stored &&
							decryptEditTranscriptObject(stored, fromUserId, videoId);
						if (!transcript)
							throw new Error(`Could not read the transcript for ${videoId}`);
						await runPromise(
							source.bucket.putObject(
								destinationKey,
								encryptEditTranscriptObject(transcript, toUserId, videoId),
								{ contentType: "application/octet-stream" },
							),
						);
						return;
					}
					await runPromise(
						source.bucket.copyObjectForRecording(
							`${source.bucket.bucketName}/${object.key}`,
							destinationKey,
						),
					);
					const head = await runPromise(
						source.bucket.headObject(destinationKey),
					);
					if (head.ContentLength !== object.size)
						throw new Error(`Copied object size mismatch for ${object.key}`);
				}),
			);
		}
	} catch (error) {
		await runPromise(
			source.bucket.deleteObjects(written.map((key) => ({ Key: key }))),
		).catch(() => undefined);
		throw error;
	}
	const copiedObjects = written.length;

	const movedOriginalKey = getOwnerOriginalKey(originalKey, toUserId, videoId);
	const updated = await db().transaction(async (tx) => {
		const result = await tx
			.update(videos)
			.set({
				...(movedOriginalKey
					? {
							metadata: sql`JSON_SET(${videos.metadata}, '$.loomDeferredProcessing.rawFileKey', ${movedOriginalKey})`,
						}
					: {}),
				ownerId: User.UserId.make(toUserId),
				folderId: options.folderId
					? Folder.FolderId.make(options.folderId)
					: null,
				...(options.keepSharing ? {} : { public: false }),
			})
			.where(
				and(
					eq(videos.id, id),
					eq(videos.ownerId, User.UserId.make(fromUserId)),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomReassignClaim.token')) = ${token}`,
					sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.status')), '') <> 'started'`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.rawFileKey')) <=> ${typeof originalKey === "string" ? originalKey : null}`,
				),
			);
		if (getAffectedRows(result) !== 1) return false;
		if (!options.keepSharing) {
			await tx.delete(sharedVideos).where(eq(sharedVideos.videoId, id));
			await tx.delete(spaceVideos).where(eq(spaceVideos.videoId, id));
		}
		return true;
	});
	if (!updated) {
		await runPromise(
			source.bucket.deleteObjects(written.map((key) => ({ Key: key }))),
		).catch(() => undefined);
		return {
			videoId,
			status: "failed",
			reason: "video changed during the move",
		};
	}

	try {
		await runPromise(
			source.bucket.deleteObjects(
				source.objects.map((object) => ({ Key: object.key })),
			),
		);
	} catch (error) {
		console.error("[loom-import-reassign] Old files remain", {
			prefix: source.prefix,
			error,
		});
		return { videoId, status: "moved", copiedObjects, cleanup: "failed" };
	}
	return { videoId, status: "moved", copiedObjects, cleanup: "done" };
}
