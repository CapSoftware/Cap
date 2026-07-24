"use server";

import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	agentApiOperations,
	folders,
	organizationMembers,
	organizations,
	s3Buckets,
	sharedVideos,
	spaces,
	spaceVideos,
	storageIntegrations,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Folder, Space, User } from "@cap/web-domain";
import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { start } from "workflow/api";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import {
	buildContentTransferFolderRows,
	CONTENT_TRANSFER_KIND,
	type ContentTransferPayload,
	type ContentTransferProgress,
	type ContentTransferSource,
	findDuplicateTransferVideoIds,
	getContentTransferFolderSubtree,
	getContentTransferStorageBlockReason,
	getContentTransferSubtreeVideoCounts,
	MAX_CONTENT_TRANSFER_FOLDERS,
	MAX_CONTENT_TRANSFER_SOURCE_FOLDERS,
	MAX_CONTENT_TRANSFER_VIDEOS,
	planPersonalFolderDestinations,
} from "@/lib/content-transfer";
import { transferOrganizationContentWorkflow } from "@/workflows/transfer-organization-content";

type ContentManager = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

type SourceMembership = {
	membershipId: string;
	videoId: string;
	name: string;
	sourceFolderId: string | null;
	sourceOwnerId: string;
	ownerEmail: string;
	orgId: string;
	bucketId: string | null;
	bucketOwnerId: string | null;
	bucketOrganizationId: string | null;
	storageIntegrationId: string | null;
	storageIntegrationOwnerId: string | null;
	storageIntegrationOrganizationId: string | null;
	uploadPhase: typeof videoUploads.$inferSelect.phase | null;
};

function requireValidSource(source: ContentTransferSource) {
	if (
		!source ||
		(source.type !== "organization" && source.type !== "space") ||
		(source.type === "space" && !source.spaceId)
	) {
		throw new Error("Invalid source location");
	}
}

async function requireContentManager() {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");
	await requireOrganizationSettingsManager(user.id, user.activeOrganizationId);
	return user;
}

async function requireSourceAccess(
	user: ContentManager,
	source: ContentTransferSource,
) {
	requireValidSource(source);
	if (source.type === "organization") return;

	const [space] = await db()
		.select({ id: spaces.id })
		.from(spaces)
		.where(
			and(
				eq(spaces.id, Space.SpaceId.make(source.spaceId)),
				eq(spaces.organizationId, user.activeOrganizationId),
			),
		)
		.limit(1);
	if (!space) throw new Error("Space not found");
}

function getSourceFolderScope(
	user: ContentManager,
	source: ContentTransferSource,
) {
	return and(
		eq(folders.organizationId, user.activeOrganizationId),
		eq(
			folders.spaceId,
			source.type === "organization"
				? user.activeOrganizationId
				: Space.SpaceId.make(source.spaceId),
		),
	);
}

async function getSourceFolders(
	user: ContentManager,
	source: ContentTransferSource,
) {
	await requireSourceAccess(user, source);
	const rows = await db()
		.select({
			id: folders.id,
			name: folders.name,
			parentId: folders.parentId,
			color: folders.color,
			public: folders.public,
		})
		.from(folders)
		.where(getSourceFolderScope(user, source))
		.orderBy(asc(folders.name))
		.limit(MAX_CONTENT_TRANSFER_SOURCE_FOLDERS + 1);
	if (rows.length > MAX_CONTENT_TRANSFER_SOURCE_FOLDERS) {
		throw new Error(
			`A content location can include up to ${MAX_CONTENT_TRANSFER_SOURCE_FOLDERS} folders`,
		);
	}
	return rows;
}

async function requireTargetMember(user: ContentManager, targetUserId: string) {
	const [[organization], [target], [membership]] = await Promise.all([
		db()
			.select({ ownerId: organizations.ownerId })
			.from(organizations)
			.where(eq(organizations.id, user.activeOrganizationId))
			.limit(1),
		db()
			.select({ id: users.id, name: users.name, email: users.email })
			.from(users)
			.where(eq(users.id, User.UserId.make(targetUserId)))
			.limit(1),
		db()
			.select({ id: organizationMembers.id })
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, user.activeOrganizationId),
					eq(organizationMembers.userId, User.UserId.make(targetUserId)),
				),
			)
			.limit(1),
	]);

	if (!organization || !target) throw new Error("Member not found");
	if (organization.ownerId !== target.id && !membership) {
		throw new Error("The destination user is not an organization member");
	}
	return target;
}

async function getSourceMemberships(
	user: ContentManager,
	source: ContentTransferSource,
	folderIds: string[],
): Promise<SourceMembership[]> {
	const brandedFolderIds = folderIds.map((id) => Folder.FolderId.make(id));
	const selection = {
		membershipId:
			source.type === "organization" ? sharedVideos.id : spaceVideos.id,
		videoId:
			source.type === "organization"
				? sharedVideos.videoId
				: spaceVideos.videoId,
		name: videos.name,
		sourceFolderId:
			source.type === "organization"
				? sharedVideos.folderId
				: spaceVideos.folderId,
		sourceOwnerId: videos.ownerId,
		ownerEmail: users.email,
		orgId: videos.orgId,
		bucketId: videos.bucket,
		bucketOwnerId: s3Buckets.ownerId,
		bucketOrganizationId: s3Buckets.organizationId,
		storageIntegrationId: videos.storageIntegrationId,
		storageIntegrationOwnerId: storageIntegrations.ownerId,
		storageIntegrationOrganizationId: storageIntegrations.organizationId,
		uploadPhase: videoUploads.phase,
	};

	if (source.type === "organization") {
		return db()
			.select(selection)
			.from(sharedVideos)
			.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
			.innerJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
			.leftJoin(
				storageIntegrations,
				eq(videos.storageIntegrationId, storageIntegrations.id),
			)
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(
				and(
					eq(sharedVideos.organizationId, user.activeOrganizationId),
					inArray(sharedVideos.folderId, brandedFolderIds),
				),
			)
			.limit(MAX_CONTENT_TRANSFER_VIDEOS + 1);
	}

	return db()
		.select(selection)
		.from(spaceVideos)
		.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
		.innerJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(
			storageIntegrations,
			eq(videos.storageIntegrationId, storageIntegrations.id),
		)
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				eq(spaceVideos.spaceId, Space.SpaceId.make(source.spaceId)),
				inArray(spaceVideos.folderId, brandedFolderIds),
			),
		)
		.limit(MAX_CONTENT_TRANSFER_VIDEOS + 1);
}

async function getSourceFolderVideoCounts(
	user: ContentManager,
	source: ContentTransferSource,
	folderIds: string[],
) {
	const brandedFolderIds = folderIds.map((id) => Folder.FolderId.make(id));
	const rows: Array<{ folderId: string | null; count: number }> = [];
	for (let index = 0; index < brandedFolderIds.length; index += 1_000) {
		const folderIdChunk = brandedFolderIds.slice(index, index + 1_000);
		const chunkRows =
			source.type === "organization"
				? await db()
						.select({ folderId: sharedVideos.folderId, count: count() })
						.from(sharedVideos)
						.where(
							and(
								eq(sharedVideos.organizationId, user.activeOrganizationId),
								inArray(sharedVideos.folderId, folderIdChunk),
							),
						)
						.groupBy(sharedVideos.folderId)
				: await db()
						.select({ folderId: spaceVideos.folderId, count: count() })
						.from(spaceVideos)
						.where(
							and(
								eq(spaceVideos.spaceId, Space.SpaceId.make(source.spaceId)),
								inArray(spaceVideos.folderId, folderIdChunk),
							),
						)
						.groupBy(spaceVideos.folderId);
		rows.push(...chunkRows);
	}
	return new Map(
		rows.flatMap((row) =>
			row.folderId ? [[row.folderId as string, row.count] as const] : [],
		),
	);
}

function buildPreviewToken(input: unknown) {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function buildTransferState({
	user,
	source,
	sourceRootFolderId,
	targetUserId,
}: {
	user: ContentManager;
	source: ContentTransferSource;
	sourceRootFolderId: string;
	targetUserId: string;
}) {
	const [sourceFolders, target] = await Promise.all([
		getSourceFolders(user, source),
		requireTargetMember(user, targetUserId),
	]);
	const sourceRows = buildContentTransferFolderRows(sourceFolders);
	const sourceRoot = sourceRows.find(
		(folder) => folder.id === sourceRootFolderId,
	);
	if (!sourceRoot) throw new Error("Source folder not found");
	const subtree = getContentTransferFolderSubtree(
		sourceFolders,
		sourceRootFolderId,
	);
	const sourceFolderIds = subtree.map((folder) => folder.id);
	if (sourceFolderIds.length > MAX_CONTENT_TRANSFER_FOLDERS) {
		throw new Error(
			`A transfer can include up to ${MAX_CONTENT_TRANSFER_FOLDERS} folders`,
		);
	}

	const [memberships, targetFolders] = await Promise.all([
		getSourceMemberships(user, source, sourceFolderIds),
		db()
			.select({
				id: folders.id,
				name: folders.name,
				parentId: folders.parentId,
				color: folders.color,
				public: folders.public,
			})
			.from(folders)
			.where(
				and(
					eq(folders.organizationId, user.activeOrganizationId),
					eq(folders.createdById, target.id),
					isNull(folders.spaceId),
				),
			),
	]);

	const duplicateVideoIds = findDuplicateTransferVideoIds(memberships);
	const blockedVideos = memberships.flatMap((membership) => {
		if (membership.orgId !== user.activeOrganizationId) {
			return [
				{
					videoId: membership.videoId,
					name: membership.name,
					reason: "The Cap belongs to another organization",
				},
			];
		}
		if (membership.uploadPhase && membership.uploadPhase !== "complete") {
			return [
				{
					videoId: membership.videoId,
					name: membership.name,
					reason: `The Cap upload is ${membership.uploadPhase.replaceAll("_", " ")}`,
				},
			];
		}
		const reason = getContentTransferStorageBlockReason({
			sourceOwnerId: membership.sourceOwnerId,
			targetUserId: target.id,
			organizationId: user.activeOrganizationId,
			bucketId: membership.bucketId,
			bucketOwnerId: membership.bucketOwnerId,
			bucketOrganizationId: membership.bucketOrganizationId,
			storageIntegrationId: membership.storageIntegrationId,
			storageIntegrationOwnerId: membership.storageIntegrationOwnerId,
			storageIntegrationOrganizationId:
				membership.storageIntegrationOrganizationId,
		});
		return reason
			? [{ videoId: membership.videoId, name: membership.name, reason }]
			: [];
	});
	const blockedReasons = [
		...(memberships.length > MAX_CONTENT_TRANSFER_VIDEOS
			? [`A transfer can include up to ${MAX_CONTENT_TRANSFER_VIDEOS} Caps`]
			: []),
		...(duplicateVideoIds.length > 0
			? [
					`${duplicateVideoIds.length} Caps appear more than once in the selected folder tree`,
				]
			: []),
		...(blockedVideos.length > 0
			? [`${blockedVideos.length} Caps cannot be transferred safely`]
			: []),
	];
	const previewFolderPlan = planPersonalFolderDestinations({
		sourceFolders,
		sourceRootFolderId,
		targetFolders,
		makeId: (() => {
			let index = 0;
			return () => `preview-${++index}`;
		})(),
	});
	const publicDestinationFolderIds = new Set<string>(
		targetFolders.filter((folder) => folder.public).map((folder) => folder.id),
	);
	const publicDestinationCount = previewFolderPlan.filter((plan) =>
		publicDestinationFolderIds.has(plan.destinationFolderId),
	).length;
	if (publicDestinationCount > 0) {
		blockedReasons.push(
			`${publicDestinationCount} matching destination folders are public`,
		);
	}
	const previewToken = buildPreviewToken({
		organizationId: user.activeOrganizationId,
		source,
		sourceRootFolderId,
		targetUserId,
		sourceFolders: [...subtree].sort((a, b) => a.id.localeCompare(b.id)),
		targetFolders: [...targetFolders].sort((a, b) => a.id.localeCompare(b.id)),
		memberships: [...memberships].sort((a, b) =>
			a.membershipId.localeCompare(b.membershipId),
		),
	});

	return {
		sourceFolders,
		sourceFolderIds,
		sourceRoot,
		subtree,
		target,
		targetFolders,
		memberships,
		previewFolderPlan,
		previewToken,
		blockedReasons,
		blockedVideos,
	};
}

function toOperationResponse(
	operation: typeof agentApiOperations.$inferSelect,
) {
	return {
		id: operation.id,
		state: operation.state,
		result: operation.result,
		errorMessage: operation.errorMessage,
		createdAt: operation.createdAt.toISOString(),
		updatedAt: operation.updatedAt.toISOString(),
		completedAt: operation.completedAt?.toISOString() ?? null,
	};
}

export async function getContentManagementSetup() {
	const user = await requireContentManager();
	const [organizationRows, memberRows, spaceRows, operationRows] =
		await Promise.all([
			db()
				.select({
					id: users.id,
					name: users.name,
					email: users.email,
				})
				.from(organizations)
				.innerJoin(users, eq(organizations.ownerId, users.id))
				.where(eq(organizations.id, user.activeOrganizationId))
				.limit(1),
			db()
				.select({
					id: users.id,
					name: users.name,
					email: users.email,
				})
				.from(organizationMembers)
				.innerJoin(users, eq(organizationMembers.userId, users.id))
				.where(
					eq(organizationMembers.organizationId, user.activeOrganizationId),
				)
				.orderBy(asc(users.email)),
			db()
				.select({ id: spaces.id, name: spaces.name })
				.from(spaces)
				.where(eq(spaces.organizationId, user.activeOrganizationId))
				.orderBy(asc(spaces.name)),
			db()
				.select()
				.from(agentApiOperations)
				.where(
					and(
						eq(agentApiOperations.kind, CONTENT_TRANSFER_KIND),
						eq(agentApiOperations.resourceId, user.activeOrganizationId),
					),
				)
				.orderBy(desc(agentApiOperations.createdAt))
				.limit(20),
		]);
	const members = new Map(
		[...organizationRows, ...memberRows].map((member) => [member.id, member]),
	);

	return {
		members: [...members.values()]
			.map((member) => ({
				...member,
				name: member.name ?? member.email,
			}))
			.sort((a, b) => a.email.localeCompare(b.email)),
		spaces: spaceRows,
		operations: operationRows.map(toOperationResponse),
	};
}

export async function getContentTransferFolders(source: ContentTransferSource) {
	const user = await requireContentManager();
	const sourceFolders = await getSourceFolders(user, source);
	const folderIds = sourceFolders.map((folder) => folder.id);
	if (folderIds.length === 0) return [];
	const directCounts = await getSourceFolderVideoCounts(
		user,
		source,
		folderIds,
	);
	const subtreeCounts = getContentTransferSubtreeVideoCounts(
		sourceFolders,
		directCounts,
	);

	return buildContentTransferFolderRows(sourceFolders).map((folder) => ({
		...folder,
		videoCount: subtreeCounts.get(folder.id) ?? 0,
	}));
}

export async function getContentTransferPreview(input: {
	source: ContentTransferSource;
	sourceRootFolderId: string;
	targetUserId: string;
}) {
	const user = await requireContentManager();
	const state = await buildTransferState({ user, ...input });
	const ownerEmails = new Set(
		state.memberships.map((membership) => membership.ownerEmail),
	);

	return {
		previewToken: state.previewToken,
		sourceFolderPath: state.sourceRoot.path,
		target: state.target,
		folderCount: state.subtree.length,
		videoCount: state.memberships.length,
		ownerCount: ownerEmails.size,
		publicFolderCount: state.subtree.filter((folder) => folder.public).length,
		foldersToCreate: state.previewFolderPlan.filter((plan) => plan.create)
			.length,
		foldersToReuse: state.previewFolderPlan.filter((plan) => !plan.create)
			.length,
		blockedReasons: state.blockedReasons,
		blockedVideos: state.blockedVideos.slice(0, 25),
	};
}

export async function startContentTransfer(input: {
	source: ContentTransferSource;
	sourceRootFolderId: string;
	targetUserId: string;
	previewToken: string;
}) {
	const user = await requireContentManager();
	const state = await buildTransferState({ user, ...input });
	if (state.previewToken !== input.previewToken) {
		throw new Error("The folder contents changed. Review the transfer again.");
	}
	if (state.blockedReasons.length > 0) {
		throw new Error(state.blockedReasons[0]);
	}

	const folderPlan = planPersonalFolderDestinations({
		sourceFolders: state.sourceFolders,
		sourceRootFolderId: input.sourceRootFolderId,
		targetFolders: state.targetFolders,
		makeId: nanoId,
	});
	const destinationBySource = new Map(
		folderPlan.map((plan) => [plan.sourceFolderId, plan.destinationFolderId]),
	);
	const payload: ContentTransferPayload = {
		version: 1,
		organizationId: user.activeOrganizationId,
		requestedByUserId: user.id,
		source: input.source,
		sourceRootFolderId: input.sourceRootFolderId,
		sourceFolderIds: state.sourceFolderIds,
		targetUserId: state.target.id,
		targetEmail: state.target.email,
		folderPlan,
		videoPlan: state.memberships.map((membership) => {
			if (!membership.sourceFolderId) {
				throw new Error("A source membership is missing its folder");
			}
			const destinationFolderId = destinationBySource.get(
				membership.sourceFolderId,
			);
			if (!destinationFolderId) {
				throw new Error("A destination folder could not be planned");
			}
			return {
				videoId: membership.videoId,
				name: membership.name,
				sourceOwnerId: membership.sourceOwnerId,
				sourceMembershipId: membership.membershipId,
				sourceFolderId: membership.sourceFolderId,
				destinationFolderId,
				bucketId: membership.bucketId,
				storageIntegrationId: membership.storageIntegrationId,
				sourceUploadPhase: membership.uploadPhase,
			};
		}),
		createdAt: new Date().toISOString(),
	};
	const operationId = nanoId();
	const initialProgress: ContentTransferProgress = {
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

	await db().transaction(async (tx) => {
		const [organization] = await tx
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.id, user.activeOrganizationId))
			.limit(1)
			.for("update");
		if (!organization) throw new Error("Organization not found");

		const [activeOperation] = await tx
			.select({ id: agentApiOperations.id })
			.from(agentApiOperations)
			.where(
				and(
					eq(agentApiOperations.kind, CONTENT_TRANSFER_KIND),
					eq(agentApiOperations.resourceId, user.activeOrganizationId),
					inArray(agentApiOperations.state, ["queued", "running"]),
				),
			)
			.limit(1);
		if (activeOperation) {
			throw new Error("Another content transfer is already running");
		}

		await tx.insert(agentApiOperations).values({
			id: operationId,
			userId: user.id,
			kind: CONTENT_TRANSFER_KIND,
			resourceId: user.activeOrganizationId,
			payload,
			result: initialProgress,
			state: "queued",
		});
	});

	try {
		await start(transferOrganizationContentWorkflow, [{ operationId }]);
	} catch (error) {
		await db()
			.update(agentApiOperations)
			.set({
				state: "failed",
				errorCode: "WORKFLOW_START_FAILED",
				errorMessage:
					error instanceof Error ? error.message : "Unable to start transfer",
				completedAt: new Date(),
			})
			.where(eq(agentApiOperations.id, operationId));
		throw error;
	}

	return { operationId };
}

export async function getContentTransferOperations() {
	const user = await requireContentManager();
	const operations = await db()
		.select()
		.from(agentApiOperations)
		.where(
			and(
				eq(agentApiOperations.kind, CONTENT_TRANSFER_KIND),
				eq(agentApiOperations.resourceId, user.activeOrganizationId),
			),
		)
		.orderBy(desc(agentApiOperations.createdAt))
		.limit(20);
	return operations.map(toOperationResponse);
}
