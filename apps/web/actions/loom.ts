"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	folders,
	importedVideos,
	loomMigrationImports,
	loomMigrationRequests,
	organizations,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { getNewVideoPublic } from "@cap/database/video-sharing-default";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import {
	type Organisation,
	type Space,
	type Storage as StorageDomain,
	type User,
	Video,
} from "@cap/web-domain";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Effect, Option, Schedule } from "effect";
import { revalidatePath } from "next/cache";
import { getRun } from "workflow/api";
import {
	getOrganizationAccess,
	requireOrganizationAccess,
	requireOrganizationSettingsManager,
} from "@/actions/organization/authorization";
import { requireSpaceManager } from "@/actions/organization/space-authorization";
import {
	releaseConciergeImport,
	requireMigrationOperator,
	reserveConciergeImport,
	toLoomMigrationResult,
} from "@/lib/loom-concierge";
import {
	addImportOwnerToSpace,
	extractLoomVideoId,
	fetchLoomOEmbed,
	fetchVideoName,
	getOrCreateImportSpace,
	getOrganizationMemberByEmail,
	importLoomVideoForOwner,
	isDirectMp4Url,
	isValidImportEmail,
	isValidImportSpaceName,
	LOOM_CSV_PERMISSION_ERROR,
	type LoomCsvImportResult,
	type LoomCsvImportRow,
	type LoomDownloadResult,
	type LoomImportResult,
	normalizeImportEmail,
	normalizeImportSpaceName,
	processLoomCsvRows,
} from "@/lib/loom-csv-import";
import {
	getLoomDownloadUrl,
	LoomDownloadTemporaryError,
} from "@/lib/loom-download-url";
import {
	LOOM_FILE_SINGLE_UPLOAD_MAX_BYTES,
	startLoomFileProcessingWorkflow,
} from "@/lib/loom-file-processing";
import type { LoomImportDestination } from "@/lib/loom-import-destination";
import { LOOM_IMPORT_MAX_BYTES } from "@/lib/loom-import-limits";
import {
	LoomMigrationError,
	type LoomMigrationResult,
} from "@/lib/loom-migration-state";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";
import { runPromise } from "@/lib/server";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { decodeStorageVideo } from "@/lib/video-storage";

export type {
	LoomCsvImportResult,
	LoomCsvImportRow,
	LoomCsvImportRowResult,
	LoomImportErrorCode,
	LoomImportResult,
} from "@/lib/loom-csv-import";

export async function downloadLoomVideo(
	url: string,
): Promise<LoomDownloadResult> {
	if (!url || typeof url !== "string") {
		return { success: false, error: "Please provide a valid URL." };
	}

	const videoId = extractLoomVideoId(url.trim());

	if (!videoId) {
		return {
			success: false,
			error:
				"Invalid Loom URL. Please paste a valid Loom video link (e.g. https://www.loom.com/share/abc123).",
		};
	}

	try {
		const downloadUrl = await getLoomDownloadUrl(videoId);

		if (!downloadUrl) {
			return {
				success: false,
				error:
					"Could not retrieve a download URL. The video may be private, password-protected, or the link may have expired.",
			};
		}

		const [videoName, oembedMeta] = await Promise.all([
			fetchVideoName(videoId),
			fetchLoomOEmbed(videoId),
		]);
		return {
			success: true,
			videoId,
			videoName: videoName ?? undefined,
			downloadUrl,
			downloadMode: isDirectMp4Url(downloadUrl)
				? "direct-download"
				: "browser-conversion",
			durationSeconds: oembedMeta?.duration,
			width: oembedMeta?.width,
			height: oembedMeta?.height,
			requiresProxy: false,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof LoomDownloadTemporaryError
					? error.message
					: "An unexpected error occurred. Please try again or check your internet connection.",
		};
	}
}

async function requireLoomImportLocationAccess(
	userId: User.UserId,
	orgId: Organisation.OrganisationId,
	spaceId?: Space.SpaceIdOrOrganisationId,
) {
	await requireOrganizationAccess(userId, orgId);
	if (!spaceId) return;
	if (spaceId === orgId) {
		await requireOrganizationSettingsManager(userId, orgId);
		return;
	}
	const access = await requireSpaceManager(userId, spaceId);
	if (access.organizationId !== orgId) throw new Error("Space not found");
}

function loomImportFolderScope(
	userId: User.UserId,
	orgId: Organisation.OrganisationId,
	spaceId?: Space.SpaceIdOrOrganisationId,
) {
	return and(
		eq(folders.organizationId, orgId),
		spaceId
			? eq(folders.spaceId, spaceId)
			: and(isNull(folders.spaceId), eq(folders.createdById, userId)),
	);
}

export async function getLoomImportFolders({
	orgId,
	spaceId,
}: {
	orgId: Organisation.OrganisationId;
	spaceId?: Space.SpaceIdOrOrganisationId;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireLoomImportLocationAccess(user.id, orgId, spaceId);
	return db()
		.select({ id: folders.id, name: folders.name, parentId: folders.parentId })
		.from(folders)
		.where(loomImportFolderScope(user.id, orgId, spaceId))
		.orderBy(asc(folders.name));
}

export async function importFromLoom({
	loomUrl,
	orgId,
	folderId,
	spaceId,
}: {
	loomUrl: string;
	orgId: Organisation.OrganisationId;
} & LoomImportDestination): Promise<LoomImportResult> {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	if (!userIsPro(user)) {
		return {
			success: false,
			error: "Importing from Loom requires a Cap Pro subscription.",
		};
	}

	await requireLoomImportLocationAccess(user.id, orgId, spaceId);
	if (folderId) {
		const [folder] = await db()
			.select({ id: folders.id })
			.from(folders)
			.where(
				and(
					eq(folders.id, folderId),
					loomImportFolderScope(user.id, orgId, spaceId),
				),
			)
			.limit(1);
		if (!folder)
			return {
				success: false,
				error:
					"Destination folder not found. Choose another folder and try again.",
			};
	}

	return importLoomVideoForOwner({
		loomUrl,
		orgId,
		ownerId: user.id,
		destination: { folderId, spaceId },
	});
}

export async function importFromLoomCsv({
	rows,
	orgId,
}: {
	rows: LoomCsvImportRow[];
	orgId: Organisation.OrganisationId;
}): Promise<LoomCsvImportResult> {
	const user = await getCurrentUser();
	if (!user) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error: "Unauthorized",
		};
	}

	if (!userIsPro(user)) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error: "Importing from Loom requires a Cap Pro subscription.",
		};
	}

	const access = await getOrganizationAccess(user.id, orgId);
	if (!canManageOrganizationSettings(access?.role)) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error: LOOM_CSV_PERMISSION_ERROR,
		};
	}

	return processLoomCsvRows({ rows, orgId, actorId: user.id });
}

export async function importFromLoomCsvForConcierge(input: {
	requestId: string;
	rows: LoomCsvImportRow[];
}): Promise<LoomMigrationResult<LoomCsvImportResult>> {
	return toLoomMigrationResult(() => importConciergeCsvRows(input));
}

async function importConciergeCsvRows({
	requestId,
	rows,
}: {
	requestId: string;
	rows: LoomCsvImportRow[];
}): Promise<LoomCsvImportResult> {
	const operator = await requireMigrationOperator();
	if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{15}$/.test(requestId)) {
		throw new LoomMigrationError("Invalid migration request.");
	}
	const [request] = await db()
		.select({
			organizationId: loomMigrationRequests.organizationId,
			status: loomMigrationRequests.status,
			ownerId: organizations.ownerId,
		})
		.from(loomMigrationRequests)
		.innerJoin(
			organizations,
			eq(organizations.id, loomMigrationRequests.organizationId),
		)
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				isNotNull(loomMigrationRequests.activeOrganizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	if (!request || request.status === "completed") {
		throw new LoomMigrationError("The migration request is no longer active.");
	}
	if (!(await isOrganizationOwnerPro(request.organizationId))) {
		throw new LoomMigrationError("The destination workspace needs Cap Pro.");
	}
	if (!Array.isArray(rows) || rows.length > 10) {
		throw new LoomMigrationError(
			"Concierge CSV imports run in batches of 10 videos.",
		);
	}
	const leaseToken = await reserveConciergeImport(requestId, operator.id);
	try {
		const result = await processLoomCsvRows({
			rows,
			orgId: request.organizationId,
			actorId: request.ownerId,
			migrationRequestId: requestId,
			migrationLeaseToken: leaseToken,
		});
		revalidatePath("/dashboard/import/loom");
		revalidatePath("/dashboard/admin/loom-migrations");
		return result;
	} finally {
		await releaseConciergeImport(requestId, leaseToken);
	}
}

type ConciergeLoomFileUploadInput = {
	requestId: string;
	loomUrl: string;
	userEmail: string;
	spaceName: string;
	videoTitle: string;
};

type ConciergeLoomFileUpload = {
	videoId: Video.VideoId;
	uploadTarget: StorageDomain.UploadTarget;
};

export async function createConciergeLoomFileUpload(
	input: ConciergeLoomFileUploadInput,
): Promise<LoomMigrationResult<ConciergeLoomFileUpload>> {
	return toLoomMigrationResult(() => prepareConciergeLoomFileUpload(input));
}

export async function resumeConciergeLoomFileUpload(input: {
	requestId: string;
	loomUrl: string;
	userEmail: string;
	confirmedPreviousProcessingStopped: boolean;
}) {
	return toLoomMigrationResult(async () => {
		await requireMigrationOperator();
		if (input.confirmedPreviousProcessingStopped !== true) {
			throw new LoomMigrationError(
				"Confirm the previous processing has stopped before resuming this upload.",
			);
		}
		if (
			typeof input.requestId !== "string" ||
			!/^[A-Za-z0-9_-]{15}$/.test(input.requestId)
		) {
			throw new LoomMigrationError("Invalid migration request.");
		}
		if (
			typeof input.loomUrl !== "string" ||
			typeof input.userEmail !== "string"
		) {
			throw new LoomMigrationError("Enter a valid Loom URL and owner email.");
		}
		const loomVideoId = extractLoomVideoId(input.loomUrl.trim());
		const ownerEmail = normalizeImportEmail(input.userEmail);
		if (!loomVideoId || !isValidImportEmail(ownerEmail)) {
			throw new LoomMigrationError("Enter a valid Loom URL and owner email.");
		}
		const [record] = await db()
			.select({
				videoId: videos.id,
				ownerId: videos.ownerId,
				ownerEmail: users.email,
				organizationId: videos.orgId,
				metadata: videos.metadata,
			})
			.from(loomMigrationRequests)
			.innerJoin(
				loomMigrationImports,
				eq(loomMigrationImports.requestId, loomMigrationRequests.id),
			)
			.innerJoin(
				importedVideos,
				eq(importedVideos.id, loomMigrationImports.videoId),
			)
			.innerJoin(
				videos,
				and(
					eq(videos.id, importedVideos.id),
					eq(videos.orgId, importedVideos.orgId),
					eq(videos.orgId, loomMigrationRequests.organizationId),
				),
			)
			.innerJoin(users, eq(users.id, videos.ownerId))
			.innerJoin(organizations, eq(organizations.id, videos.orgId))
			.where(
				and(
					eq(loomMigrationRequests.id, input.requestId),
					isNotNull(loomMigrationRequests.activeOrganizationId),
					isNull(organizations.tombstoneAt),
					eq(importedVideos.source, "loom"),
					eq(importedVideos.sourceId, loomVideoId),
				),
			)
			.limit(1);
		if (!record || normalizeImportEmail(record.ownerEmail) !== ownerEmail) {
			throw new LoomMigrationError(
				"No existing Loom recording matches this request and owner.",
			);
		}
		if (!(await isOrganizationOwnerPro(record.organizationId))) {
			throw new LoomMigrationError("The destination workspace needs Cap Pro.");
		}
		const previousRun = record.metadata?.loomImportRun;
		if (previousRun && previousRun.dispatch !== "rejected") {
			let status: string | null;
			try {
				status = await getRun(previousRun.runId).status;
			} catch {
				status = null;
			}
			if (
				status !== "completed" &&
				status !== "failed" &&
				status !== "cancelled"
			) {
				throw new LoomMigrationError(
					"The previous Loom workflow is active or could not be confirmed.",
				);
			}
		}
		return startConciergeLoomFileProcessing({
			requestId: input.requestId,
			videoId: record.videoId,
			expectedOwnerId: record.ownerId,
			maxBytes: LOOM_IMPORT_MAX_BYTES,
		});
	});
}

async function prepareConciergeLoomFileUpload({
	requestId,
	loomUrl,
	userEmail,
	spaceName,
	videoTitle,
}: ConciergeLoomFileUploadInput): Promise<ConciergeLoomFileUpload> {
	const operator = await requireMigrationOperator();
	if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{15}$/.test(requestId)) {
		throw new LoomMigrationError("Invalid migration request.");
	}
	const loomVideoId = extractLoomVideoId(loomUrl.trim());
	if (!loomVideoId)
		throw new LoomMigrationError("Enter a valid Loom video URL.");
	const normalizedEmail = normalizeImportEmail(userEmail);
	if (!isValidImportEmail(normalizedEmail)) {
		throw new LoomMigrationError("Enter a valid destination owner email.");
	}
	const normalizedSpaceName = normalizeImportSpaceName(spaceName);
	if (!isValidImportSpaceName(normalizedSpaceName)) {
		throw new LoomMigrationError("Space name is too long.");
	}
	const normalizedTitle = videoTitle.trim();
	if (!normalizedTitle || normalizedTitle.length > 255) {
		throw new LoomMigrationError(
			"Enter a video title of 255 characters or fewer.",
		);
	}
	const [request] = await db()
		.select({
			organizationId: loomMigrationRequests.organizationId,
			ownerId: organizations.ownerId,
		})
		.from(loomMigrationRequests)
		.innerJoin(
			organizations,
			eq(organizations.id, loomMigrationRequests.organizationId),
		)
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				isNotNull(loomMigrationRequests.activeOrganizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	if (!request)
		throw new LoomMigrationError("The migration request is no longer active.");
	if (!(await isOrganizationOwnerPro(request.organizationId))) {
		throw new LoomMigrationError("The destination workspace needs Cap Pro.");
	}
	const leaseToken = await reserveConciergeImport(requestId, operator.id);
	try {
		const [existing] = await db()
			.select({
				id: importedVideos.id,
				ownerId: videos.ownerId,
				ownerEmail: users.email,
				bucket: videos.bucket,
				storageIntegrationId: videos.storageIntegrationId,
				rawFileKey: videoUploads.rawFileKey,
				phase: videoUploads.phase,
				processingMessage: videoUploads.processingMessage,
			})
			.from(importedVideos)
			.leftJoin(
				videos,
				and(
					eq(videos.id, importedVideos.id),
					eq(videos.orgId, importedVideos.orgId),
				),
			)
			.leftJoin(users, eq(users.id, videos.ownerId))
			.leftJoin(videoUploads, eq(videoUploads.videoId, importedVideos.id))
			.where(
				and(
					eq(importedVideos.orgId, request.organizationId),
					eq(importedVideos.source, "loom"),
					eq(importedVideos.sourceId, loomVideoId),
				),
			)
			.limit(1);
		if (existing) {
			const existingRawFileKey =
				existing.rawFileKey ??
				(existing.phase === "error" && existing.ownerId
					? `${existing.ownerId}/${existing.id}/raw-upload.mp4`
					: null);
			if (
				!existing.ownerId ||
				!existing.ownerEmail ||
				normalizeImportEmail(existing.ownerEmail) !== normalizedEmail ||
				!existingRawFileKey ||
				(existing.phase !== "error" &&
					(existing.phase !== "uploading" ||
						existing.processingMessage !== "Uploading Loom video..."))
			) {
				throw new LoomMigrationError(
					"This Loom video is already in the Cap import inventory.",
				);
			}
			const retryUpload = await Storage.createUploadTargetForUser(
				existing.ownerId,
				existingRawFileKey,
				{
					contentType: "video/mp4",
					videoTitle: normalizedTitle,
					method: "put",
					fields: { "x-amz-meta-userid": existing.ownerId },
				},
				request.organizationId,
			).pipe(runPromise);
			if (
				Option.getOrNull(retryUpload.bucketId) !== existing.bucket ||
				Option.getOrNull(retryUpload.storageIntegrationId) !==
					existing.storageIntegrationId
			) {
				throw new LoomMigrationError(
					"The Cap storage destination changed. Review this upload before retrying.",
				);
			}
			const [mapped] = await db()
				.select({ requestId: loomMigrationImports.requestId })
				.from(loomMigrationImports)
				.where(
					eq(loomMigrationImports.videoId, Video.VideoId.make(existing.id)),
				)
				.limit(1);
			if (mapped && mapped.requestId !== requestId) {
				throw new LoomMigrationError(
					"This Loom import belongs to another migration request.",
				);
			}
			if (!mapped || !existing.rawFileKey) {
				await db().transaction(async (tx) => {
					const [reservation] = await tx
						.select({
							activeOrganizationId: loomMigrationRequests.activeOrganizationId,
							leaseToken: loomMigrationRequests.activeImportLeaseToken,
							leaseUntil: loomMigrationRequests.activeImportLeaseUntil,
						})
						.from(loomMigrationRequests)
						.where(eq(loomMigrationRequests.id, requestId))
						.limit(1)
						.for("update");
					if (
						!reservation?.activeOrganizationId ||
						reservation.leaseToken !== leaseToken ||
						!reservation.leaseUntil ||
						reservation.leaseUntil <= new Date()
					) {
						throw new LoomMigrationError(
							"The concierge import expired. Retry this video.",
						);
					}
					if (!existing.rawFileKey) {
						await tx
							.update(videoUploads)
							.set({ rawFileKey: existingRawFileKey, updatedAt: new Date() })
							.where(
								and(
									eq(videoUploads.videoId, Video.VideoId.make(existing.id)),
									eq(videoUploads.phase, "error"),
									isNull(videoUploads.rawFileKey),
								),
							);
					}
					if (mapped) return;
					await tx.insert(loomMigrationImports).values({
						videoId: Video.VideoId.make(existing.id),
						requestId,
					});
					await tx
						.update(loomMigrationRequests)
						.set({
							queuedVideoCount: sql`${loomMigrationRequests.queuedVideoCount} + 1`,
							updatedAt: new Date(),
						})
						.where(eq(loomMigrationRequests.id, requestId));
				});
			}
			return {
				videoId: Video.VideoId.make(existing.id),
				uploadTarget: retryUpload.upload,
			};
		}
		let member = await getOrganizationMemberByEmail(
			request.organizationId,
			normalizedEmail,
		);
		if (!member) {
			const provisioned = await provisionOrganizationInvitee({
				organizationId: request.organizationId,
				email: normalizedEmail,
				invitedByUserId: request.ownerId,
				role: "member",
			});
			member = { userId: provisioned.userId, email: normalizedEmail };
		}
		const space = normalizedSpaceName
			? await getOrCreateImportSpace({
					orgId: request.organizationId,
					createdById: request.ownerId,
					name: normalizedSpaceName,
					spaceCache: new Map(),
				})
			: null;
		if (space) {
			await addImportOwnerToSpace({ spaceId: space.id, userId: member.userId });
		}
		const videoId = Video.VideoId.make(nanoId());
		const rawFileKey = `${member.userId}/${videoId}/raw-upload.mp4`;
		const upload = await Storage.createUploadTargetForUser(
			member.userId,
			rawFileKey,
			{
				contentType: "video/mp4",
				videoTitle: normalizedTitle,
				method: "put",
				fields: { "x-amz-meta-userid": member.userId },
			},
			request.organizationId,
		).pipe(runPromise);
		const isPublic = await getNewVideoPublic(request.organizationId);
		await db().transaction(async (tx) => {
			const [reservation] = await tx
				.select({
					activeOrganizationId: loomMigrationRequests.activeOrganizationId,
					leaseToken: loomMigrationRequests.activeImportLeaseToken,
					leaseUntil: loomMigrationRequests.activeImportLeaseUntil,
				})
				.from(loomMigrationRequests)
				.where(eq(loomMigrationRequests.id, requestId))
				.limit(1)
				.for("update");
			if (
				!reservation?.activeOrganizationId ||
				reservation.leaseToken !== leaseToken ||
				!reservation.leaseUntil ||
				reservation.leaseUntil <= new Date()
			) {
				throw new LoomMigrationError(
					"The concierge import expired. Retry this video.",
				);
			}
			await tx.insert(videos).values({
				id: videoId,
				name: normalizedTitle,
				ownerId: member.userId,
				orgId: request.organizationId,
				source: { type: "webMP4" as const },
				bucket: Option.getOrNull(upload.bucketId),
				storageIntegrationId: Option.getOrNull(upload.storageIntegrationId),
				public: isPublic,
			});
			await tx.insert(videoUploads).values({
				videoId,
				mode: "singlepart",
				phase: "uploading",
				processingProgress: 0,
				processingMessage: "Uploading Loom video...",
				rawFileKey,
			});
			await tx.insert(importedVideos).values({
				id: videoId,
				orgId: request.organizationId,
				source: "loom",
				sourceId: loomVideoId,
			});
			await tx.insert(loomMigrationImports).values({ videoId, requestId });
			await tx
				.update(loomMigrationRequests)
				.set({
					queuedVideoCount: sql`${loomMigrationRequests.queuedVideoCount} + 1`,
					updatedAt: new Date(),
				})
				.where(eq(loomMigrationRequests.id, requestId));
			if (space) {
				await tx.insert(spaceVideos).values({
					id: nanoId(),
					videoId,
					spaceId: space.id,
					addedById: request.ownerId,
				});
			}
		});
		revalidatePath("/dashboard/admin/loom-migrations");
		return { videoId, uploadTarget: upload.upload };
	} finally {
		await releaseConciergeImport(requestId, leaseToken);
	}
}

export async function finishConciergeLoomFileUpload(input: {
	requestId: string;
	videoId: Video.VideoId;
}) {
	return toLoomMigrationResult(() => startConciergeLoomFileProcessing(input));
}

async function startConciergeLoomFileProcessing({
	requestId,
	videoId,
	expectedOwnerId,
	maxBytes,
}: {
	requestId: string;
	videoId: Video.VideoId;
	expectedOwnerId?: User.UserId;
	maxBytes?: number;
}) {
	const operator = await requireMigrationOperator();
	if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{15}$/.test(requestId)) {
		throw new LoomMigrationError("Invalid migration request.");
	}
	const leaseToken = await reserveConciergeImport(requestId, operator.id);
	try {
		const [record] = await db()
			.select({
				video: videos,
				loomVideoId: importedVideos.sourceId,
				rawFileKey: videoUploads.rawFileKey,
				phase: videoUploads.phase,
				processingMessage: videoUploads.processingMessage,
			})
			.from(videos)
			.innerJoin(
				importedVideos,
				and(
					eq(importedVideos.id, videos.id),
					eq(importedVideos.orgId, videos.orgId),
				),
			)
			.innerJoin(videoUploads, eq(videoUploads.videoId, videos.id))
			.innerJoin(
				loomMigrationImports,
				eq(loomMigrationImports.videoId, videos.id),
			)
			.innerJoin(
				loomMigrationRequests,
				and(
					eq(loomMigrationRequests.id, loomMigrationImports.requestId),
					eq(loomMigrationRequests.organizationId, importedVideos.orgId),
				),
			)
			.where(
				and(
					eq(videos.id, videoId),
					expectedOwnerId ? eq(videos.ownerId, expectedOwnerId) : undefined,
					eq(loomMigrationRequests.id, requestId),
					eq(importedVideos.source, "loom"),
					isNotNull(loomMigrationRequests.activeOrganizationId),
				),
			)
			.limit(1);
		if (
			!record ||
			(expectedOwnerId && record.video.ownerId !== expectedOwnerId) ||
			!record.rawFileKey ||
			(record.phase !== "error" &&
				(record.phase !== "uploading" ||
					record.processingMessage !== "Uploading Loom video..."))
		) {
			throw new LoomMigrationError("This Loom upload is no longer available.");
		}
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(record.video),
		).pipe(runPromise);
		const head = await bucket
			.headObject(record.rawFileKey)
			.pipe(
				Effect.retry({
					times: 3,
					schedule: Schedule.exponential("100 millis"),
				}),
				runPromise,
			)
			.catch(() => {
				throw new LoomMigrationError(
					"The uploaded file was not found in storage. Upload it again.",
				);
			});
		if ((head.ContentLength ?? 0) <= 0)
			throw new LoomMigrationError("The uploaded file is empty.");
		if (maxBytes !== undefined && (head.ContentLength ?? 0) > maxBytes) {
			throw new LoomMigrationError("The uploaded Loom file exceeds 10 GB.");
		}
		const processingInput = {
			videoId,
			userId: record.video.ownerId,
			rawFileKey: record.rawFileKey,
			bucketId: record.video.bucket,
			processingMessage: "Processing Loom video...",
			startFailureMessage: "Loom file processing could not start.",
		};
		const status =
			bucket.provider === "s3" &&
			(head.ContentLength ?? 0) > LOOM_FILE_SINGLE_UPLOAD_MAX_BYTES
				? await startLoomFileProcessingWorkflow({
						...processingInput,
						loomVideoId: record.loomVideoId,
					})
				: await startVideoProcessingWorkflow(processingInput);
		revalidatePath("/dashboard/import/loom");
		revalidatePath("/dashboard/admin/loom-migrations");
		return { status };
	} finally {
		await releaseConciergeImport(requestId, leaseToken);
	}
}
