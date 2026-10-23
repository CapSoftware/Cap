import type { db } from "@cap/database";
import * as Db from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Folder, Organisation, S3Bucket, User, Video } from "@cap/web-domain";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Option } from "effect";
import {
	CONTENT_TRANSFER_KIND,
	getContentTransferStorageBlockReason,
} from "@/lib/content-transfer";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { makeOwnershipMediaStore } from "@/lib/recording-ownership-storage";
import {
	OWNERSHIP_TRANSFER_MODE,
	type OwnershipFields,
	type OwnershipFolderAccess,
	type OwnershipSnapshot,
	OwnershipTransferError,
	type OwnershipTransferPlan,
	ownershipHash,
	type TransferObject,
} from "@/lib/recording-ownership-transfer";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export type OwnershipTransaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];
type Client = ReturnType<typeof db> | OwnershipTransaction;

export type OwnershipTransferPayload = {
	version: 2;
	mode: typeof OWNERSHIP_TRANSFER_MODE;
	requestedByUserId: string;
	requestHash: string;
	plan: OwnershipTransferPlan;
};

export type OwnershipTransferResult = {
	phase: "copying" | "applied" | "rolled_back" | "cancelled";
	afterHash?: string;
	destinations?: TransferObject[];
};

export function readOwnershipOperation(
	operation: typeof Db.agentApiOperations.$inferSelect,
) {
	const payload = operation.payload as OwnershipTransferPayload | null;
	const result = operation.result as OwnershipTransferResult | null;
	if (
		operation.kind !== CONTENT_TRANSFER_KIND ||
		payload?.version !== 2 ||
		payload.mode !== OWNERSHIP_TRANSFER_MODE ||
		payload.plan?.version !== 1 ||
		!/^[a-f0-9]{64}$/.test(payload.plan.originalFolderHash ?? "") ||
		!["upload", "legacy-receipt", "preflight"].includes(
			payload.plan.completion,
		) ||
		(payload.plan.completion === "preflight") !==
			Boolean(payload.plan.preflight) ||
		payload.requestedByUserId !== operation.userId ||
		payload.plan.organizationId !== operation.resourceId ||
		!result ||
		!["copying", "applied", "rolled_back", "cancelled"].includes(result.phase)
	) {
		throw new OwnershipTransferError("UNSUPPORTED");
	}
	return { payload, result };
}

export async function loadOwnershipSnapshot(
	client: Client,
	id: string,
	lock = false,
): Promise<OwnershipSnapshot> {
	const videoId = Video.VideoId.make(id);
	const jobQuery = client
		.select()
		.from(Db.videoProcessingJobs)
		.where(eq(Db.videoProcessingJobs.videoId, videoId));
	const [processing] = await (lock ? jobQuery.for("update") : jobQuery);
	const videoQuery = client
		.select({
			id: Db.videos.id,
			orgId: Db.videos.orgId,
			ownerId: Db.videos.ownerId,
			folderId: Db.videos.folderId,
			bucket: Db.videos.bucket,
			storageIntegrationId: Db.videos.storageIntegrationId,
			source: Db.videos.source,
			metadata: Db.videos.metadata,
			transcriptionStatus: Db.videos.transcriptionStatus,
			jobStatus: Db.videos.jobStatus,
			isScreenshot: Db.videos.isScreenshot,
			duration: Db.videos.duration,
		})
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId));
	const [video] = await (lock ? videoQuery.for("update") : videoQuery);
	if (!video) throw new OwnershipTransferError("SNAPSHOT_CHANGED");
	const uploadQuery = client
		.select()
		.from(Db.videoUploads)
		.where(eq(Db.videoUploads.videoId, videoId));
	const [upload] = await (lock ? uploadQuery.for("update") : uploadQuery);
	const editQuery = client
		.select()
		.from(Db.videoEdits)
		.where(eq(Db.videoEdits.videoId, videoId));
	const [edit] = await (lock ? editQuery.for("update") : editQuery);
	const commentsQuery = client
		.select({
			id: Db.comments.id,
			mediaKey: Db.comments.mediaKey,
			mediaMeta: Db.comments.mediaMeta,
			updatedAt: Db.comments.updatedAt,
		})
		.from(Db.comments)
		.where(eq(Db.comments.videoId, videoId));
	const comments = await (lock ? commentsQuery.for("update") : commentsQuery);
	return {
		video,
		folderAccess: await loadOwnershipFolderAccess(
			client,
			video.folderId,
			video.orgId,
			lock,
		),
		upload: upload ?? null,
		edit: edit ?? null,
		processing: processing ?? null,
		comments: comments.sort((a, b) => a.id.localeCompare(b.id)),
	};
}

export async function loadOwnershipFolderAccess(
	client: Client,
	folderId: string | null,
	organizationId: string,
	lock = false,
): Promise<OwnershipFolderAccess | null> {
	if (!folderId) return null;
	const access: OwnershipFolderAccess = { folders: [], spaces: [] };
	const visited = new Set<string>();
	let current: string | null = folderId;
	while (current) {
		if (visited.has(current) || visited.size >= 32)
			throw new OwnershipTransferError("INVALID_REFERENCE");
		visited.add(current);
		const query = client
			.select({
				id: Db.folders.id,
				organizationId: Db.folders.organizationId,
				createdById: Db.folders.createdById,
				parentId: Db.folders.parentId,
				spaceId: Db.folders.spaceId,
				public: Db.folders.public,
				updatedAt: Db.folders.updatedAt,
			})
			.from(Db.folders)
			.where(eq(Db.folders.id, Folder.FolderId.make(current)));
		const [folder] = await (lock ? query.for("share") : query);
		if (!folder || folder.organizationId !== organizationId)
			throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		access.folders.push(folder);
		if (
			folder.spaceId &&
			folder.spaceId !== organizationId &&
			!access.spaces.some((space) => space.id === folder.spaceId)
		) {
			const query = client
				.select({
					id: Db.spaces.id,
					organizationId: Db.spaces.organizationId,
					public: Db.spaces.public,
					privacy: Db.spaces.privacy,
					updatedAt: Db.spaces.updatedAt,
				})
				.from(Db.spaces)
				.where(eq(Db.spaces.id, folder.spaceId));
			const [space] = await (lock ? query.for("share") : query);
			if (!space || space.organizationId !== organizationId)
				throw new OwnershipTransferError("SNAPSHOT_CHANGED");
			access.spaces.push(space);
		}
		current = folder.parentId;
	}
	access.spaces.sort((a, b) => a.id.localeCompare(b.id));
	return access;
}

export async function requireOriginalOwnershipDestination(
	client: Client,
	snapshot: OwnershipSnapshot,
	plan: OwnershipTransferPlan,
	lock = false,
) {
	const access = await loadOwnershipFolderAccess(
		client,
		plan.before.folderId,
		plan.organizationId,
		lock,
	);
	if (ownershipHash(access) !== plan.originalFolderHash)
		throw new OwnershipTransferError("SNAPSHOT_CHANGED");
	await requireOwnershipDestination(
		client,
		snapshot,
		plan.before.ownerId,
		null,
		lock,
	);
}

export async function requireOwnershipAccess(
	client: Client,
	organizationId: string,
	actorId: string,
	targetId: string,
	lock = false,
) {
	const orgQuery = client
		.select({ ownerId: Db.organizations.ownerId })
		.from(Db.organizations)
		.where(
			and(
				eq(
					Db.organizations.id,
					Organisation.OrganisationId.make(organizationId),
				),
				isNull(Db.organizations.tombstoneAt),
			),
		);
	const [organization] = await (lock ? orgQuery.for("update") : orgQuery);
	if (!organization) throw new Error("Forbidden");
	const memberQuery = client
		.select({
			userId: Db.organizationMembers.userId,
			role: Db.organizationMembers.role,
		})
		.from(Db.organizationMembers)
		.where(
			and(
				eq(
					Db.organizationMembers.organizationId,
					Organisation.OrganisationId.make(organizationId),
				),
				inArray(Db.organizationMembers.userId, [
					User.UserId.make(actorId),
					User.UserId.make(targetId),
				]),
			),
		);
	const members = await (lock ? memberQuery.for("share") : memberQuery);
	const role = getEffectiveOrganizationRole({
		userId: actorId,
		ownerId: organization.ownerId,
		memberRole: members.find((member) => member.userId === actorId)?.role,
	});
	if (
		!canManageOrganizationSettings(role) ||
		(organization.ownerId !== targetId &&
			!members.some((member) => member.userId === targetId))
	) {
		throw new Error("Forbidden");
	}
}

export async function requireOwnershipDestination(
	client: Client,
	snapshot: OwnershipSnapshot,
	targetId: string,
	folderId: string | null,
	lock = false,
) {
	const original = snapshot.folderAccess?.folders[0];
	const preservedCollection =
		original?.id === folderId && original.public && original.spaceId === null;
	if (folderId && !preservedCollection) {
		const query = client
			.select({ id: Db.folders.id })
			.from(Db.folders)
			.where(
				and(
					eq(Db.folders.id, Folder.FolderId.make(folderId)),
					eq(Db.folders.createdById, User.UserId.make(targetId)),
					eq(Db.folders.organizationId, snapshot.video.orgId),
					isNull(Db.folders.spaceId),
					eq(Db.folders.public, false),
				),
			);
		const [folder] = await (lock ? query.for("share") : query);
		if (!folder) throw new OwnershipTransferError("SNAPSHOT_CHANGED");
	}
	if (snapshot.video.bucket) {
		const query = client
			.select({
				ownerId: Db.s3Buckets.ownerId,
				organizationId: Db.s3Buckets.organizationId,
			})
			.from(Db.s3Buckets)
			.where(eq(Db.s3Buckets.id, snapshot.video.bucket));
		const [bucket] = await (lock ? query.for("share") : query);
		if (
			getContentTransferStorageBlockReason({
				sourceOwnerId: snapshot.video.ownerId,
				targetUserId: targetId,
				organizationId: snapshot.video.orgId,
				bucketId: snapshot.video.bucket,
				bucketOwnerId: bucket?.ownerId ?? null,
				bucketOrganizationId: bucket?.organizationId ?? null,
				storageIntegrationId: snapshot.video.storageIntegrationId,
				storageIntegrationOwnerId: null,
				storageIntegrationOrganizationId: null,
			})
		)
			throw new OwnershipTransferError("UNSUPPORTED");
	}
}

export async function ownershipStore(
	plan: Pick<
		OwnershipTransferPlan,
		"videoId" | "organizationId" | "bucketId" | "before"
	>,
) {
	const [access] = await Storage.getAccessForVideo(
		Video.Video.make({
			id: Video.VideoId.make(plan.videoId),
			orgId: Organisation.OrganisationId.make(plan.organizationId),
			ownerId: User.UserId.make(plan.before.ownerId),
			name: "Ownership transfer",
			public: false,
			source: plan.before.source,
			metadata: Option.none(),
			bucketId: Option.fromNullable(plan.bucketId).pipe(
				Option.map(S3Bucket.S3BucketId.make),
			),
			storageIntegrationId: Option.none(),
			folderId: Option.none(),
			transcriptionStatus: Option.none(),
			width: Option.none(),
			height: Option.none(),
			duration: Option.none(),
			createdAt: new Date(0),
			updatedAt: new Date(0),
		}),
		{ resolvePublishedOutput: false },
	).pipe(runWorkflowPromise);
	return makeOwnershipMediaStore(access);
}

export async function writeOwnershipFields(
	tx: OwnershipTransaction,
	snapshot: OwnershipSnapshot,
	fields: OwnershipFields,
) {
	const metadata = snapshot.video.metadata
		? { ...snapshot.video.metadata }
		: null;
	if (metadata) {
		delete metadata.desktopRecordingUpload;
		delete metadata.agentUpload;
		if (fields.desktopRecordingUpload)
			metadata.desktopRecordingUpload = fields.desktopRecordingUpload;
		if (fields.agentUpload) metadata.agentUpload = fields.agentUpload;
	}
	await tx
		.update(Db.videos)
		.set({
			ownerId: fields.ownerId,
			folderId: fields.folderId,
			source: fields.source,
			metadata,
		})
		.where(eq(Db.videos.id, snapshot.video.id));
	if (snapshot.upload) {
		await tx
			.update(Db.videoUploads)
			.set({ rawFileKey: fields.rawFileKey })
			.where(eq(Db.videoUploads.videoId, snapshot.video.id));
	}
	if (snapshot.edit && fields.editSourceKey) {
		await tx
			.update(Db.videoEdits)
			.set({ sourceKey: fields.editSourceKey })
			.where(eq(Db.videoEdits.videoId, snapshot.video.id));
	}
	for (const comment of fields.comments) {
		if (!comment.mediaKey && !comment.mediaMeta?.thumbnailKey) continue;
		await tx
			.update(Db.comments)
			.set({ mediaKey: comment.mediaKey, mediaMeta: comment.mediaMeta })
			.where(
				and(
					eq(Db.comments.id, comment.id),
					eq(Db.comments.videoId, snapshot.video.id),
				),
			);
	}
}
