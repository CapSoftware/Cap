import { db } from "@cap/database";
import * as Db from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	Folder,
	Organisation,
	S3Bucket,
	Space,
	Storage as StorageDomain,
	User,
	Video,
} from "@cap/web-domain";
import { and, eq, inArray, isNull, like, notInArray, sql } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import {
	CONTENT_TRANSFER_KIND,
	type ContentTransferPayload,
	type ContentTransferProgress,
	type ContentTransferUploadPhase,
	type ContentTransferVideoPlan,
	getContentTransferStorageBlockReason,
	MAX_CONTENT_TRANSFER_FOLDERS,
	MAX_CONTENT_TRANSFER_VIDEOS,
} from "@/lib/content-transfer";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const CONTENT_TRANSFER_UPLOAD_PHASES = new Set<ContentTransferUploadPhase>([
	"uploading",
	"processing",
	"generating_thumbnail",
	"complete",
	"error",
]);

function parsePayload(value: unknown): ContentTransferPayload {
	if (!value || typeof value !== "object") {
		throw new FatalError("Content transfer payload is invalid");
	}
	const payload = value as Partial<ContentTransferPayload>;
	if (
		payload.version !== 1 ||
		!payload.organizationId ||
		!payload.requestedByUserId ||
		!payload.targetUserId ||
		!payload.targetEmail ||
		!payload.sourceRootFolderId ||
		!payload.source ||
		!Array.isArray(payload.sourceFolderIds) ||
		!Array.isArray(payload.folderPlan) ||
		!Array.isArray(payload.videoPlan)
	) {
		throw new FatalError("Content transfer payload is incomplete");
	}
	if (
		(payload.source.type !== "organization" &&
			payload.source.type !== "space") ||
		(payload.source.type === "space" && !payload.source.spaceId)
	) {
		throw new FatalError("Content transfer source is invalid");
	}
	if (
		payload.sourceFolderIds.length === 0 ||
		payload.sourceFolderIds.length > MAX_CONTENT_TRANSFER_FOLDERS ||
		payload.folderPlan.length !== payload.sourceFolderIds.length ||
		payload.videoPlan.length > MAX_CONTENT_TRANSFER_VIDEOS
	) {
		throw new FatalError("Content transfer payload exceeds its bounds");
	}
	const sourceFolderIds = new Set(payload.sourceFolderIds);
	const destinationFolderIds = new Set<string>();
	for (const plan of payload.folderPlan) {
		if (
			!plan ||
			typeof plan !== "object" ||
			!plan.sourceFolderId ||
			!sourceFolderIds.has(plan.sourceFolderId) ||
			(plan.sourceParentId !== null &&
				typeof plan.sourceParentId !== "string") ||
			typeof plan.sourcePublic !== "boolean" ||
			!plan.destinationFolderId ||
			(plan.destinationParentId !== null &&
				typeof plan.destinationParentId !== "string") ||
			!plan.name ||
			!(["normal", "blue", "red", "yellow"] as const).includes(plan.color) ||
			typeof plan.create !== "boolean"
		) {
			throw new FatalError("Content transfer folder plan is invalid");
		}
		if (destinationFolderIds.has(plan.destinationFolderId)) {
			throw new FatalError("Content transfer destinations are not unique");
		}
		destinationFolderIds.add(plan.destinationFolderId);
	}
	if (
		!sourceFolderIds.has(payload.sourceRootFolderId) ||
		new Set(payload.folderPlan.map((plan) => plan.sourceFolderId)).size !==
			payload.sourceFolderIds.length
	) {
		throw new FatalError("Content transfer source folders are inconsistent");
	}
	const videoIds = new Set<string>();
	const membershipIds = new Set<string>();
	for (const item of payload.videoPlan) {
		if (
			!item ||
			typeof item !== "object" ||
			!item.videoId ||
			!item.name ||
			!item.sourceOwnerId ||
			!item.sourceMembershipId ||
			!sourceFolderIds.has(item.sourceFolderId) ||
			!destinationFolderIds.has(item.destinationFolderId) ||
			(item.sourceUploadPhase !== null &&
				!CONTENT_TRANSFER_UPLOAD_PHASES.has(item.sourceUploadPhase))
		) {
			throw new FatalError("Content transfer video plan is invalid");
		}
		if (
			videoIds.has(item.videoId) ||
			membershipIds.has(item.sourceMembershipId)
		) {
			throw new FatalError("Content transfer video plan contains duplicates");
		}
		videoIds.add(item.videoId);
		membershipIds.add(item.sourceMembershipId);
	}
	return payload as ContentTransferPayload;
}

function canManageContentTransfer(role: string | null | undefined) {
	return role === "owner" || role === "admin";
}

function makeStorageVideo(input: {
	id: string;
	ownerId: string;
	orgId: string;
	bucketId: string | null;
	storageIntegrationId: string | null;
}) {
	return Video.Video.make({
		id: Video.VideoId.make(input.id),
		ownerId: User.UserId.make(input.ownerId),
		orgId: Organisation.OrganisationId.make(input.orgId),
		name: "Content transfer",
		public: false,
		source: { type: "MediaConvert" },
		metadata: Option.none(),
		bucketId: Option.fromNullable(input.bucketId).pipe(
			Option.map(S3Bucket.S3BucketId.make),
		),
		storageIntegrationId: Option.fromNullable(input.storageIntegrationId).pipe(
			Option.map(StorageDomain.StorageIntegrationId.make),
		),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.none(),
		height: Option.none(),
		duration: Option.none(),
		createdAt: new Date(0),
		updatedAt: new Date(0),
	});
}

function initialProgress(
	payload: ContentTransferPayload,
): ContentTransferProgress {
	return {
		phase: "queued",
		totalVideos: payload.videoPlan.length,
		processedVideos: 0,
		transferredVideos: 0,
		alreadyOwnedVideos: 0,
		copiedObjects: 0,
		currentVideoId: null,
		removedSourceFolder: false,
		cleanupWarnings: [],
	};
}

async function claimOperation(operationId: string) {
	"use step";

	return db().transaction(async (tx) => {
		const [operation] = await tx
			.select()
			.from(Db.agentApiOperations)
			.where(eq(Db.agentApiOperations.id, operationId))
			.limit(1)
			.for("update");
		if (!operation)
			throw new FatalError("Content transfer operation not found");
		if (operation.kind !== CONTENT_TRANSFER_KIND) {
			throw new FatalError("Operation is not a content transfer");
		}
		if (operation.state !== "queued") return null;
		const payload = parsePayload(operation.payload);
		const organizationId = Organisation.OrganisationId.make(
			payload.organizationId,
		);
		const requestedByUserId = User.UserId.make(payload.requestedByUserId);
		const targetUserId = User.UserId.make(payload.targetUserId);
		if (
			operation.userId !== payload.requestedByUserId ||
			operation.resourceId !== payload.organizationId
		) {
			throw new FatalError("Content transfer operation scope is invalid");
		}

		const [[organization], [actorMembership], [targetMembership]] =
			await Promise.all([
				tx
					.select({ ownerId: Db.organizations.ownerId })
					.from(Db.organizations)
					.where(
						and(
							eq(Db.organizations.id, organizationId),
							isNull(Db.organizations.tombstoneAt),
						),
					)
					.limit(1),
				tx
					.select({ role: Db.organizationMembers.role })
					.from(Db.organizationMembers)
					.where(
						and(
							eq(Db.organizationMembers.organizationId, organizationId),
							eq(Db.organizationMembers.userId, requestedByUserId),
						),
					)
					.limit(1),
				tx
					.select({ id: Db.organizationMembers.id })
					.from(Db.organizationMembers)
					.where(
						and(
							eq(Db.organizationMembers.organizationId, organizationId),
							eq(Db.organizationMembers.userId, targetUserId),
						),
					)
					.limit(1),
			]);
		if (!organization) throw new FatalError("Organization not found");
		const actorIsManager =
			organization.ownerId === payload.requestedByUserId ||
			canManageContentTransfer(actorMembership?.role);
		if (!actorIsManager) {
			throw new FatalError("The requesting user is no longer an administrator");
		}
		if (organization.ownerId !== payload.targetUserId && !targetMembership) {
			throw new FatalError("The destination user is no longer a member");
		}

		await tx
			.update(Db.agentApiOperations)
			.set({
				state: "running",
				result: initialProgress(payload),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(Db.agentApiOperations.id, operationId),
					eq(Db.agentApiOperations.state, "queued"),
				),
			);
		return payload;
	});
}

async function verifySourceSnapshot(payload: ContentTransferPayload) {
	"use step";

	const organizationId = Organisation.OrganisationId.make(
		payload.organizationId,
	);
	const sourceFolderIds = payload.sourceFolderIds.map((id) =>
		Folder.FolderId.make(id),
	);
	const sourceSpaceId =
		payload.source.type === "organization"
			? organizationId
			: Space.SpaceId.make(payload.source.spaceId);
	if (payload.source.type === "space") {
		const [sourceSpace] = await db()
			.select({ id: Db.spaces.id })
			.from(Db.spaces)
			.where(
				and(
					eq(Db.spaces.id, sourceSpaceId),
					eq(Db.spaces.organizationId, organizationId),
				),
			)
			.limit(1);
		if (!sourceSpace) throw new FatalError("Source space no longer exists");
	}

	const currentFolders = await db()
		.select({
			id: Db.folders.id,
			name: Db.folders.name,
			parentId: Db.folders.parentId,
			color: Db.folders.color,
			public: Db.folders.public,
		})
		.from(Db.folders)
		.where(
			and(
				inArray(Db.folders.id, sourceFolderIds),
				eq(Db.folders.organizationId, organizationId),
				eq(Db.folders.spaceId, sourceSpaceId),
			),
		);
	if (currentFolders.length !== payload.folderPlan.length) {
		throw new FatalError("Source folder hierarchy changed after review");
	}
	const currentById = new Map(
		currentFolders.map((folder) => [folder.id as string, folder]),
	);
	for (const plan of payload.folderPlan) {
		const current = currentById.get(plan.sourceFolderId);
		if (
			!current ||
			current.name !== plan.name ||
			current.parentId !== plan.sourceParentId ||
			current.color !== plan.color ||
			current.public !== plan.sourcePublic
		) {
			throw new FatalError("Source folder hierarchy changed after review");
		}
	}
}

async function setOperationProgress(
	operationId: string,
	progress: ContentTransferProgress,
) {
	await db()
		.update(Db.agentApiOperations)
		.set({ result: progress, updatedAt: new Date() })
		.where(
			and(
				eq(Db.agentApiOperations.id, operationId),
				eq(Db.agentApiOperations.state, "running"),
			),
		);
}

async function createDestinationFolders(
	operationId: string,
	payload: ContentTransferPayload,
	progress: ContentTransferProgress,
) {
	"use step";

	const nextProgress = { ...progress, phase: "creating_folders" as const };
	await setOperationProgress(operationId, nextProgress);
	await db().transaction(async (tx) => {
		const organizationId = Organisation.OrganisationId.make(
			payload.organizationId,
		);
		const targetUserId = User.UserId.make(payload.targetUserId);
		for (const plan of payload.folderPlan) {
			const destinationFolderId = Folder.FolderId.make(
				plan.destinationFolderId,
			);
			const destinationParentId = plan.destinationParentId
				? Folder.FolderId.make(plan.destinationParentId)
				: null;
			const [existing] = await tx
				.select({
					id: Db.folders.id,
					name: Db.folders.name,
					parentId: Db.folders.parentId,
					organizationId: Db.folders.organizationId,
					createdById: Db.folders.createdById,
					spaceId: Db.folders.spaceId,
					public: Db.folders.public,
				})
				.from(Db.folders)
				.where(eq(Db.folders.id, destinationFolderId))
				.limit(1)
				.for("update");
			if (existing) {
				if (
					existing.organizationId !== organizationId ||
					existing.createdById !== targetUserId ||
					existing.spaceId !== null ||
					existing.public ||
					existing.parentId !== destinationParentId ||
					existing.name.trim().toLocaleLowerCase() !==
						plan.name.trim().toLocaleLowerCase()
				) {
					throw new FatalError("A destination folder changed after review");
				}
				continue;
			}
			if (!plan.create) {
				throw new FatalError("A destination folder was removed after review");
			}

			const parentCondition = destinationParentId
				? eq(Db.folders.parentId, destinationParentId)
				: isNull(Db.folders.parentId);
			const [nameConflict] = await tx
				.select({ id: Db.folders.id })
				.from(Db.folders)
				.where(
					and(
						eq(Db.folders.organizationId, organizationId),
						eq(Db.folders.createdById, targetUserId),
						isNull(Db.folders.spaceId),
						parentCondition,
						eq(Db.folders.name, plan.name),
					),
				)
				.limit(1);
			if (nameConflict) {
				throw new FatalError(
					"A matching destination folder was created after review",
				);
			}

			await tx.insert(Db.folders).values({
				id: destinationFolderId,
				name: plan.name,
				color: plan.color,
				public: false,
				organizationId,
				createdById: targetUserId,
				parentId: destinationParentId,
				spaceId: null,
			});
		}
	});
	return nextProgress;
}

async function listObjectsForOwner(input: {
	videoId: string;
	ownerId: string;
	organizationId: string;
	bucketId: string | null;
	storageIntegrationId: string | null;
}) {
	const [bucket] = await Storage.getAccessForVideo(
		makeStorageVideo({
			id: input.videoId,
			ownerId: input.ownerId,
			orgId: input.organizationId,
			bucketId: input.bucketId,
			storageIntegrationId: input.storageIntegrationId,
		}),
	).pipe(runWorkflowPromise);
	const prefix = `${input.ownerId}/${input.videoId}/`;
	const objects: Array<{ key: string; size: number }> = [];
	let continuationToken: string | undefined;
	do {
		const page = await bucket
			.listObjects({ prefix, maxKeys: 1_000, continuationToken })
			.pipe(runWorkflowPromise);
		for (const object of page.Contents ?? []) {
			if (!object.Key) continue;
			let size = object.Size;
			if (size === undefined) {
				const head = await bucket
					.headObject(object.Key)
					.pipe(runWorkflowPromise);
				size = head.ContentLength;
			}
			if (size === undefined) {
				throw new FatalError(`Unable to verify source object ${object.Key}`);
			}
			objects.push({ key: object.Key, size });
		}
		continuationToken = page.IsTruncated
			? page.NextContinuationToken
			: undefined;
	} while (continuationToken);
	return { bucket, prefix, objects };
}

async function copyAndVerifyObjects({
	payload,
	item,
	allowDestinationSuperset,
}: {
	payload: ContentTransferPayload;
	item: ContentTransferVideoPlan;
	allowDestinationSuperset: boolean;
}) {
	const listed = await listObjectsForOwner({
		videoId: item.videoId,
		ownerId: item.sourceOwnerId,
		organizationId: payload.organizationId,
		bucketId: item.bucketId,
		storageIntegrationId: item.storageIntegrationId,
	});
	const destination = await listObjectsForOwner({
		videoId: item.videoId,
		ownerId: payload.targetUserId,
		organizationId: payload.organizationId,
		bucketId: item.bucketId,
		storageIntegrationId: item.storageIntegrationId,
	});
	if (listed.objects.length === 0) {
		if (allowDestinationSuperset && destination.objects.length > 0) {
			return {
				...listed,
				copiedObjects: 0,
				destinationPrefix: destination.prefix,
			};
		}
		throw new FatalError(`No media objects were found for ${item.name}`);
	}
	const destinationSizes = new Map(
		destination.objects.map((object) => [object.key, object.size]),
	);
	const expectedDestinationKeys = new Set(
		listed.objects.map((object) =>
			object.key.replace(listed.prefix, destination.prefix),
		),
	);
	if (
		!allowDestinationSuperset &&
		destination.objects.some(
			(object) => !expectedDestinationKeys.has(object.key),
		)
	) {
		throw new FatalError(`Destination media conflicts with ${item.name}`);
	}
	let copiedObjects = 0;
	for (let index = 0; index < listed.objects.length; index += 4) {
		const chunk = listed.objects.slice(index, index + 4);
		const copied = await Promise.all(
			chunk.map(async (object) => {
				const destinationKey = object.key.replace(
					listed.prefix,
					destination.prefix,
				);
				const existingSize = destinationSizes.get(destinationKey) ?? null;
				if (existingSize === object.size) return 0;

				await listed.bucket
					.copyObject(
						`${listed.bucket.bucketName}/${object.key}`,
						destinationKey,
					)
					.pipe(runWorkflowPromise);
				const destinationHead = await listed.bucket
					.headObject(destinationKey)
					.pipe(runWorkflowPromise);
				if (destinationHead.ContentLength !== object.size) {
					throw new FatalError(`Copied object size mismatch for ${item.name}`);
				}
				return 1;
			}),
		);
		copiedObjects += copied.reduce<number>((total, count) => total + count, 0);
	}
	return { ...listed, copiedObjects, destinationPrefix: destination.prefix };
}

async function getCurrentVideo(item: ContentTransferVideoPlan) {
	const [video] = await db()
		.select({
			id: Db.videos.id,
			ownerId: Db.videos.ownerId,
			orgId: Db.videos.orgId,
			folderId: Db.videos.folderId,
			bucketId: Db.videos.bucket,
			bucketOwnerId: Db.s3Buckets.ownerId,
			bucketOrganizationId: Db.s3Buckets.organizationId,
			storageIntegrationId: Db.videos.storageIntegrationId,
			storageIntegrationOwnerId: Db.storageIntegrations.ownerId,
			storageIntegrationOrganizationId: Db.storageIntegrations.organizationId,
			uploadPhase: Db.videoUploads.phase,
		})
		.from(Db.videos)
		.leftJoin(Db.s3Buckets, eq(Db.videos.bucket, Db.s3Buckets.id))
		.leftJoin(
			Db.storageIntegrations,
			eq(Db.videos.storageIntegrationId, Db.storageIntegrations.id),
		)
		.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId))
		.where(eq(Db.videos.id, Video.VideoId.make(item.videoId)))
		.limit(1);
	return video;
}

async function transferOneVideo(
	operationId: string,
	payload: ContentTransferPayload,
	item: ContentTransferVideoPlan,
	progress: ContentTransferProgress,
) {
	"use step";
	const organizationId = Organisation.OrganisationId.make(
		payload.organizationId,
	);
	const targetUserId = User.UserId.make(payload.targetUserId);
	const videoId = Video.VideoId.make(item.videoId);
	const destinationFolderId = Folder.FolderId.make(item.destinationFolderId);

	const current = await getCurrentVideo(item);
	if (!current || current.orgId !== payload.organizationId) {
		throw new FatalError(`Cap ${item.name} is no longer in this organization`);
	}
	if (
		current.ownerId !== item.sourceOwnerId &&
		current.ownerId !== payload.targetUserId
	) {
		throw new FatalError(`Ownership changed for ${item.name}`);
	}
	if (
		current.bucketId !== item.bucketId ||
		current.storageIntegrationId !== item.storageIntegrationId ||
		current.uploadPhase !== item.sourceUploadPhase
	) {
		throw new FatalError(`Storage changed for ${item.name}`);
	}
	if (current.uploadPhase && current.uploadPhase !== "complete") {
		throw new FatalError(`Cap ${item.name} is not ready to transfer`);
	}
	const storageBlockReason = getContentTransferStorageBlockReason({
		sourceOwnerId: current.ownerId,
		targetUserId: payload.targetUserId,
		organizationId: payload.organizationId,
		bucketId: current.bucketId,
		bucketOwnerId: current.bucketOwnerId,
		bucketOrganizationId: current.bucketOrganizationId,
		storageIntegrationId: current.storageIntegrationId,
		storageIntegrationOwnerId: current.storageIntegrationOwnerId,
		storageIntegrationOrganizationId: current.storageIntegrationOrganizationId,
	});
	if (storageBlockReason) throw new FatalError(storageBlockReason);

	const ownerChanged = current.ownerId !== payload.targetUserId;
	const copied =
		item.sourceOwnerId !== payload.targetUserId
			? await copyAndVerifyObjects({
					payload,
					item,
					allowDestinationSuperset: !ownerChanged,
				})
			: null;

	await db().transaction(async (tx) => {
		const accessRows = await tx
			.select({
				ownerId: Db.organizations.ownerId,
				memberUserId: Db.organizationMembers.userId,
				memberRole: Db.organizationMembers.role,
			})
			.from(Db.organizations)
			.leftJoin(
				Db.organizationMembers,
				and(
					eq(Db.organizationMembers.organizationId, Db.organizations.id),
					inArray(Db.organizationMembers.userId, [
						User.UserId.make(payload.requestedByUserId),
						targetUserId,
					]),
				),
			)
			.where(
				and(
					eq(Db.organizations.id, organizationId),
					isNull(Db.organizations.tombstoneAt),
				),
			)
			.for("share");
		const organization = accessRows[0];
		const actorMembership = accessRows.find(
			(row) => row.memberUserId === payload.requestedByUserId,
		);
		const targetMembership = accessRows.find(
			(row) => row.memberUserId === payload.targetUserId,
		);
		if (!organization) throw new FatalError("Organization no longer exists");
		if (
			organization.ownerId !== payload.requestedByUserId &&
			!canManageContentTransfer(actorMembership?.memberRole)
		) {
			throw new FatalError("The requesting user is no longer an administrator");
		}
		if (organization.ownerId !== payload.targetUserId && !targetMembership) {
			throw new FatalError("The destination user is no longer a member");
		}

		const [lockedVideo] = await tx
			.select({
				ownerId: Db.videos.ownerId,
				bucketId: Db.videos.bucket,
				storageIntegrationId: Db.videos.storageIntegrationId,
				uploadPhase: Db.videoUploads.phase,
			})
			.from(Db.videos)
			.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId))
			.where(eq(Db.videos.id, videoId))
			.limit(1)
			.for("update");
		if (!lockedVideo) throw new FatalError(`Cap ${item.name} no longer exists`);
		if (
			lockedVideo.ownerId !== item.sourceOwnerId &&
			lockedVideo.ownerId !== payload.targetUserId
		) {
			throw new FatalError(`Ownership changed for ${item.name}`);
		}
		if (
			lockedVideo.bucketId !== item.bucketId ||
			lockedVideo.storageIntegrationId !== item.storageIntegrationId ||
			lockedVideo.uploadPhase !== item.sourceUploadPhase
		) {
			throw new FatalError(`Storage changed for ${item.name}`);
		}

		const [destinationFolder] = await tx
			.select({ id: Db.folders.id })
			.from(Db.folders)
			.where(
				and(
					eq(Db.folders.id, destinationFolderId),
					eq(Db.folders.organizationId, organizationId),
					eq(Db.folders.createdById, targetUserId),
					isNull(Db.folders.spaceId),
					eq(Db.folders.public, false),
				),
			)
			.limit(1);
		if (!destinationFolder) {
			throw new FatalError(`Destination folder is missing for ${item.name}`);
		}

		const sourceMembership =
			payload.source.type === "organization"
				? (
						await tx
							.select({
								id: Db.sharedVideos.id,
								folderId: Db.sharedVideos.folderId,
							})
							.from(Db.sharedVideos)
							.where(
								and(
									eq(Db.sharedVideos.id, item.sourceMembershipId),
									eq(Db.sharedVideos.videoId, videoId),
									eq(Db.sharedVideos.organizationId, organizationId),
								),
							)
							.limit(1)
							.for("update")
					)[0]
				: (
						await tx
							.select({
								id: Db.spaceVideos.id,
								folderId: Db.spaceVideos.folderId,
							})
							.from(Db.spaceVideos)
							.where(
								and(
									eq(Db.spaceVideos.id, item.sourceMembershipId),
									eq(Db.spaceVideos.videoId, videoId),
									eq(
										Db.spaceVideos.spaceId,
										Space.SpaceId.make(payload.source.spaceId),
									),
								),
							)
							.limit(1)
							.for("update")
					)[0];
		const alreadyComplete =
			lockedVideo.ownerId === payload.targetUserId && !sourceMembership;
		if (!sourceMembership && !alreadyComplete) {
			throw new FatalError(`Source placement changed for ${item.name}`);
		}
		if (sourceMembership && sourceMembership.folderId !== item.sourceFolderId) {
			throw new FatalError(`Source placement changed for ${item.name}`);
		}

		await tx
			.update(Db.videos)
			.set({
				ownerId: targetUserId,
				folderId: destinationFolderId,
				updatedAt: new Date(),
			})
			.where(eq(Db.videos.id, videoId));

		if (item.sourceOwnerId !== payload.targetUserId) {
			const sourcePrefix = `${item.sourceOwnerId}/${item.videoId}/`;
			const destinationPrefix = `${payload.targetUserId}/${item.videoId}/`;
			await tx
				.update(Db.videoUploads)
				.set({
					rawFileKey: sql`REPLACE(${Db.videoUploads.rawFileKey}, ${sourcePrefix}, ${destinationPrefix})`,
				})
				.where(
					and(
						eq(Db.videoUploads.videoId, videoId),
						like(Db.videoUploads.rawFileKey, `${sourcePrefix}%`),
					),
				);
			await tx
				.update(Db.videoEdits)
				.set({
					sourceKey: sql`REPLACE(${Db.videoEdits.sourceKey}, ${sourcePrefix}, ${destinationPrefix})`,
				})
				.where(
					and(
						eq(Db.videoEdits.videoId, videoId),
						like(Db.videoEdits.sourceKey, `${sourcePrefix}%`),
					),
				);
		}

		if (sourceMembership) {
			if (payload.source.type === "organization") {
				await tx
					.delete(Db.sharedVideos)
					.where(eq(Db.sharedVideos.id, item.sourceMembershipId));
			} else {
				await tx
					.delete(Db.spaceVideos)
					.where(eq(Db.spaceVideos.id, item.sourceMembershipId));
			}
		}
	});

	const cleanupWarnings: string[] = [];
	if (copied) {
		try {
			for (let index = 0; index < copied.objects.length; index += 1_000) {
				await copied.bucket
					.deleteObjects(
						copied.objects.slice(index, index + 1_000).map((object) => ({
							Key: object.key,
						})),
					)
					.pipe(runWorkflowPromise);
			}
		} catch {
			cleanupWarnings.push(`Old media copies remain for ${item.name}`);
		}
	}

	const nextProgress: ContentTransferProgress = {
		...progress,
		phase: "transferring",
		processedVideos: progress.processedVideos + 1,
		transferredVideos: progress.transferredVideos + (ownerChanged ? 1 : 0),
		alreadyOwnedVideos: progress.alreadyOwnedVideos + (ownerChanged ? 0 : 1),
		copiedObjects: progress.copiedObjects + (copied?.copiedObjects ?? 0),
		currentVideoId: item.videoId,
		cleanupWarnings: [...progress.cleanupWarnings, ...cleanupWarnings],
	};
	await setOperationProgress(operationId, nextProgress);
	return nextProgress;
}

async function cleanupSourceFolders(
	operationId: string,
	payload: ContentTransferPayload,
	progress: ContentTransferProgress,
) {
	"use step";

	const nextProgress: ContentTransferProgress = {
		...progress,
		phase: "cleaning_up",
		currentVideoId: null,
	};
	await setOperationProgress(operationId, nextProgress);

	const warning = await db().transaction(async (tx) => {
		const organizationId = Organisation.OrganisationId.make(
			payload.organizationId,
		);
		const sourceFolderIds = payload.sourceFolderIds.map((id) =>
			Folder.FolderId.make(id),
		);
		const sourceSpaceId =
			payload.source.type === "organization"
				? organizationId
				: Space.SpaceId.make(payload.source.spaceId);
		const lockedFolders = await tx
			.select({ id: Db.folders.id })
			.from(Db.folders)
			.where(
				and(
					inArray(Db.folders.id, sourceFolderIds),
					eq(Db.folders.organizationId, organizationId),
					eq(Db.folders.spaceId, sourceSpaceId),
				),
			)
			.for("update");
		if (lockedFolders.length !== payload.sourceFolderIds.length) {
			return "Source folders changed during the transfer";
		}

		const [organizationPlacement] = await tx
			.select({ id: Db.sharedVideos.id })
			.from(Db.sharedVideos)
			.where(inArray(Db.sharedVideos.folderId, sourceFolderIds))
			.limit(1);
		const [spacePlacement] = await tx
			.select({ id: Db.spaceVideos.id })
			.from(Db.spaceVideos)
			.where(inArray(Db.spaceVideos.folderId, sourceFolderIds))
			.limit(1);
		const [personalPlacement] = await tx
			.select({ id: Db.videos.id })
			.from(Db.videos)
			.where(inArray(Db.videos.folderId, sourceFolderIds))
			.limit(1);
		const [newChild] = await tx
			.select({ id: Db.folders.id })
			.from(Db.folders)
			.where(
				and(
					inArray(Db.folders.parentId, sourceFolderIds),
					notInArray(Db.folders.id, sourceFolderIds),
				),
			)
			.limit(1);
		if (
			organizationPlacement ||
			spacePlacement ||
			personalPlacement ||
			newChild
		) {
			return "Source folders were kept because they received new content";
		}

		await tx
			.delete(Db.folders)
			.where(
				and(
					inArray(Db.folders.id, sourceFolderIds),
					eq(Db.folders.organizationId, organizationId),
					eq(Db.folders.spaceId, sourceSpaceId),
				),
			);
		return null;
	});

	const completed: ContentTransferProgress = {
		...nextProgress,
		removedSourceFolder: warning === null,
		cleanupWarnings: warning
			? [...nextProgress.cleanupWarnings, warning]
			: nextProgress.cleanupWarnings,
	};
	await setOperationProgress(operationId, completed);
	return completed;
}

async function completeOperation(
	operationId: string,
	progress: ContentTransferProgress,
) {
	"use step";

	const now = new Date();
	await db()
		.update(Db.agentApiOperations)
		.set({
			state: "succeeded",
			result: { ...progress, currentVideoId: null },
			completedAt: now,
			updatedAt: now,
			errorCode: null,
			errorMessage: null,
		})
		.where(eq(Db.agentApiOperations.id, operationId));
}

async function failOperation(operationId: string, error: unknown) {
	"use step";

	const now = new Date();
	await db()
		.update(Db.agentApiOperations)
		.set({
			state: "failed",
			errorCode: "CONTENT_TRANSFER_FAILED",
			errorMessage:
				error instanceof Error ? error.message : "Content transfer failed",
			completedAt: now,
			updatedAt: now,
		})
		.where(eq(Db.agentApiOperations.id, operationId));
}

export async function transferOrganizationContentWorkflow(input: {
	operationId: string;
}) {
	"use workflow";

	try {
		const payload = await claimOperation(input.operationId);
		if (!payload) return;
		let progress = initialProgress(payload);
		await verifySourceSnapshot(payload);
		progress = await createDestinationFolders(
			input.operationId,
			payload,
			progress,
		);
		for (const item of payload.videoPlan) {
			progress = await transferOneVideo(
				input.operationId,
				payload,
				item,
				progress,
			);
		}
		progress = await cleanupSourceFolders(input.operationId, payload, progress);
		await completeOperation(input.operationId, progress);
	} catch (error) {
		await failOperation(input.operationId, error);
		throw error;
	}
}
