import "server-only";

import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	folders,
	importedVideos,
	loomMigrationImports,
	loomMigrationRequests,
	organizationMembers,
	sharedVideos,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { getNewVideoPublic } from "@cap/database/video-sharing-default";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import {
	Folder,
	type Organisation,
	Space,
	SpaceMemberId,
	type User,
	Video,
} from "@cap/web-domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { renewConciergeImport } from "@/lib/loom-concierge";
import {
	getLoomDownloadUrl,
	LoomDownloadTemporaryError,
} from "@/lib/loom-download-url";
import type { LoomImportDestination } from "@/lib/loom-import-destination";
import {
	getLoomImportRunState,
	LOOM_IMPORT_CONFIRMATION_MESSAGE,
	LoomImportStartError,
	restoreLoomImportStartError,
	startLoomImportWorkflow,
} from "@/lib/loom-import-start";
import { LoomMigrationError } from "@/lib/loom-migration-state";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import { runPromise } from "@/lib/server";

export type LoomDownloadMode = "direct-download" | "browser-conversion";

export interface LoomDownloadResult {
	success: boolean;
	videoId?: string;
	videoName?: string;
	downloadUrl?: string;
	downloadMode?: LoomDownloadMode;
	durationSeconds?: number;
	width?: number;
	height?: number;
	requiresProxy?: boolean;
	error?: string;
	errorCode?: LoomImportErrorCode;
	retryAfterMs?: number;
}

export type LoomImportErrorCode = "loom_temporarily_unavailable";

export interface LoomImportResult {
	success: boolean;
	videoId?: Video.VideoId;
	error?: string;
	errorCode?: LoomImportErrorCode;
}

export interface LoomCsvImportRow {
	rowNumber: number;
	loomUrl: string;
	userEmail: string;
	spaceName?: string;
	folderName?: string;
}

export interface LoomCsvImportRowResult {
	rowNumber: number;
	userEmail: string;
	spaceName?: string;
	success: boolean;
	videoId?: Video.VideoId;
	error?: string;
	errorCode?: LoomImportErrorCode;
}

export interface LoomCsvImportResult {
	success: boolean;
	importedCount: number;
	failedCount: number;
	results: LoomCsvImportRowResult[];
	error?: string;
}

export const MAX_LOOM_CSV_ROWS = 500;
export const MAX_LOOM_SPACE_NAME_LENGTH = 255;
export const MAX_LOOM_VIDEO_NAME_LENGTH = 255;
export const LOOM_CSV_LIMIT_ERROR = `CSV imports are limited to ${MAX_LOOM_CSV_ROWS} rows at a time. Contact support to raise this limit.`;
export const LOOM_CSV_PERMISSION_ERROR =
	"Only organization admins and owners can import Loom videos from a CSV.";
export const LOOM_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

export function extractLoomVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (
			parsed.protocol !== "https:" ||
			(parsed.hostname !== "loom.com" && !parsed.hostname.endsWith(".loom.com"))
		) {
			return null;
		}

		const pathParts = parsed.pathname.split("/").filter(Boolean);
		const id = pathParts[pathParts.length - 1] ?? null;

		if (!id || !LOOM_VIDEO_ID_PATTERN.test(id)) {
			return null;
		}

		return id;
	} catch {
		return null;
	}
}

export async function fetchVideoName(videoId: string): Promise<string | null> {
	try {
		const response = await fetch("https://www.loom.com/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"x-loom-request-source": "loom_web",
			},
			body: JSON.stringify({
				operationName: "GetVideoName",
				variables: { videoId, password: null },
				query: `query GetVideoName($videoId: ID!, $password: String) {
					getVideo(id: $videoId, password: $password) {
						... on RegularUserVideo { name }
						... on PrivateVideo { id }
						... on VideoPasswordMissingOrIncorrect { id }
					}
				}`,
			}),
		});

		if (!response.ok) return null;

		const data = await response.json();
		return data?.data?.getVideo?.name ?? null;
	} catch {
		return null;
	}
}

export function isDirectMp4Url(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".mp4");
}

export async function fetchLoomOEmbed(
	loomVideoId: string,
): Promise<{ duration?: number; width?: number; height?: number } | null> {
	try {
		const response = await fetch(
			`https://www.loom.com/v1/oembed?url=${encodeURIComponent(`https://www.loom.com/share/${loomVideoId}`)}`,
			{ headers: { Accept: "application/json" } },
		);
		if (!response.ok) return null;
		const data = await response.json();
		return {
			duration: data.duration ? Math.round(data.duration) : undefined,
			width: data.width ?? undefined,
			height: data.height ?? undefined,
		};
	} catch {
		return null;
	}
}

export type LoomImportTransaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

export async function assertConciergeLease(
	tx: LoomImportTransaction,
	requestId: string,
	leaseToken: string | undefined,
) {
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
		!leaseToken ||
		!reservation?.activeOrganizationId ||
		reservation.leaseToken !== leaseToken ||
		!reservation.leaseUntil ||
		reservation.leaseUntil <= new Date()
	) {
		throw new LoomMigrationError(
			"The concierge import expired. Retry this video.",
		);
	}
}

export async function recordConciergeImport(
	tx: LoomImportTransaction,
	videoId: Video.VideoId,
	requestId: string,
) {
	await tx.insert(loomMigrationImports).values({ videoId, requestId });
	await tx
		.update(loomMigrationRequests)
		.set({
			queuedVideoCount: sql`${loomMigrationRequests.queuedVideoCount} + 1`,
			updatedAt: new Date(),
		})
		.where(eq(loomMigrationRequests.id, requestId));
}

export async function importLoomVideoForOwner({
	loomUrl,
	orgId,
	ownerId,
	destination = {},
	migrationRequestId,
	migrationLeaseToken,
	importPriority,
}: {
	loomUrl: string;
	orgId: Organisation.OrganisationId;
	ownerId: User.UserId;
	destination?: LoomImportDestination;
	migrationRequestId?: string;
	migrationLeaseToken?: string;
	importPriority?: "customer" | "bulk";
}): Promise<LoomImportResult> {
	const loomVideoId = extractLoomVideoId(loomUrl.trim());
	if (!loomVideoId) {
		return {
			success: false,
			error:
				"Invalid Loom URL. Please paste a valid Loom video link (e.g. https://www.loom.com/share/abc123).",
		};
	}

	const existing = await db()
		.select({
			videoId: videos.id,
			ownerId: videos.ownerId,
			bucketId: videos.bucket,
			metadata: videos.metadata,
			phase: videoUploads.phase,
			rawFileKey: videoUploads.rawFileKey,
			uploadUpdatedAt: videoUploads.updatedAt,
		})
		.from(importedVideos)
		.leftJoin(
			videos,
			and(
				eq(videos.id, importedVideos.id),
				eq(videos.orgId, importedVideos.orgId),
			),
		)
		.leftJoin(videoUploads, eq(videoUploads.videoId, videos.id))
		.where(
			and(
				eq(importedVideos.orgId, orgId),
				eq(importedVideos.source, "loom"),
				eq(importedVideos.sourceId, loomVideoId),
			),
		);

	const existingVideo = existing.find((row) => row.videoId !== null);
	if (existingVideo?.videoId) {
		if (
			existingVideo.phase === "error" &&
			existingVideo.ownerId === ownerId &&
			existingVideo.uploadUpdatedAt
		) {
			const runState = await getLoomImportRunState(
				existingVideo.metadata?.loomImportRun,
			);
			if (runState === "unconfirmed") {
				return { success: false, error: LOOM_IMPORT_CONFIRMATION_MESSAGE };
			}
			if (runState !== "inactive") {
				return {
					success: false,
					error: "This Loom import is already restarting.",
				};
			}
			const rawFileKey =
				existingVideo.rawFileKey ??
				`${ownerId}/${existingVideo.videoId}/raw-upload.mp4`;
			const failedVideoId = existingVideo.videoId;
			const failedUpdatedAt = existingVideo.uploadUpdatedAt;
			const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
			const claimOutcome = await db().transaction(async (tx) => {
				let mappedRequestId: string | undefined;
				if (migrationRequestId) {
					await assertConciergeLease(
						tx,
						migrationRequestId,
						migrationLeaseToken,
					);
					const [mapped] = await tx
						.select({ requestId: loomMigrationImports.requestId })
						.from(loomMigrationImports)
						.where(eq(loomMigrationImports.videoId, failedVideoId))
						.limit(1);
					mappedRequestId = mapped?.requestId;
					if (mappedRequestId && mappedRequestId !== migrationRequestId) {
						return "foreign" as const;
					}
				}
				const claim = await tx
					.update(videoUploads)
					.set({
						phase: "processing",
						processingProgress: 0,
						processingMessage: "Restarting Loom import...",
						processingError: null,
						rawFileKey,
						updatedAt: claimedAt,
					})
					.where(
						and(
							eq(videoUploads.videoId, failedVideoId),
							eq(videoUploads.phase, "error"),
							eq(videoUploads.updatedAt, failedUpdatedAt),
						),
					);
				const affectedRows = Array.isArray(claim)
					? (claim[0] as { affectedRows?: number } | undefined)?.affectedRows
					: (claim as { affectedRows?: number }).affectedRows;
				if (affectedRows !== 1) return "busy" as const;
				if (migrationRequestId && !mappedRequestId) {
					await recordConciergeImport(tx, failedVideoId, migrationRequestId);
				}
				return "claimed" as const;
			});
			if (claimOutcome === "foreign") {
				return {
					success: false,
					error: "This Loom import belongs to another migration request.",
				};
			}
			if (claimOutcome === "busy") {
				return {
					success: false,
					error: "This Loom import is already restarting.",
				};
			}
			try {
				await startLoomImportWorkflow({
					videoId: existingVideo.videoId,
					userId: ownerId,
					rawFileKey,
					bucketId: existingVideo.bucketId,
					loomVideoId,
					reuseExistingRawUpload: true,
					importPriority,
				});
			} catch (error) {
				if (error instanceof LoomImportStartError && error.canRetry) {
					await restoreLoomImportStartError(
						existingVideo.videoId,
						"processing",
						claimedAt,
						error.message,
					);
				}
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Loom import could not restart.",
				};
			}
			revalidatePath("/dashboard/caps");
			return { success: true, videoId: existingVideo.videoId };
		}
		return {
			success: false,
			error: "This Loom video has already been imported.",
		};
	}

	if (existing.length > 0) {
		await db()
			.delete(importedVideos)
			.where(
				and(
					eq(importedVideos.orgId, orgId),
					eq(importedVideos.source, "loom"),
					eq(importedVideos.sourceId, loomVideoId),
				),
			);
	}

	let downloadUrl: string | null;
	try {
		downloadUrl = await getLoomDownloadUrl(loomVideoId);
	} catch (error) {
		if (error instanceof LoomDownloadTemporaryError) {
			return {
				success: false,
				error: error.message,
				errorCode: "loom_temporarily_unavailable",
			};
		}
		throw error;
	}
	if (!downloadUrl) {
		return {
			success: false,
			error:
				"Could not retrieve a download URL. The video may be private, password-protected, or the link may have expired.",
		};
	}

	const [videoName, oembedMeta] = await Promise.all([
		fetchVideoName(loomVideoId),
		fetchLoomOEmbed(loomVideoId),
	]);

	const writableResult = await Storage.getWritableAccessForUser(ownerId, orgId)
		.pipe(runPromise)
		.then(
			(value) => ({ ok: true as const, value }),
			(error) => ({ ok: false as const, error }),
		);

	if (!writableResult.ok) {
		console.error(
			`Loom import: failed to resolve storage access for user ${ownerId} in org ${orgId}:`,
			writableResult.error,
		);
		return {
			success: false,
			error:
				"Could not prepare storage for this import. Please try again or contact support.",
		};
	}

	const writable = writableResult.value;

	const videoId = Video.VideoId.make(nanoId());
	const name = Array.from(
		videoName ||
			`Loom Import - ${new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}`,
	)
		.slice(0, MAX_LOOM_VIDEO_NAME_LENGTH)
		.join("");

	const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	await db().transaction(async (tx) => {
		if (migrationRequestId) {
			await assertConciergeLease(tx, migrationRequestId, migrationLeaseToken);
		}
		await tx.insert(videos).values({
			id: videoId,
			name,
			ownerId,
			orgId,
			folderId: destination.spaceId ? undefined : destination.folderId,
			source: { type: "webMP4" as const },
			bucket: Option.getOrNull(writable.bucketId),
			storageIntegrationId: Option.getOrNull(writable.storageIntegrationId),
			public: await getNewVideoPublic(orgId),
			...(oembedMeta?.duration ? { duration: oembedMeta.duration } : {}),
			...(oembedMeta?.width ? { width: oembedMeta.width } : {}),
			...(oembedMeta?.height ? { height: oembedMeta.height } : {}),
		});

		await tx.insert(videoUploads).values({
			videoId,
			phase: "uploading",
			processingProgress: 0,
			processingMessage: "Importing from Loom...",
			updatedAt: claimedAt,
		});

		await tx.insert(importedVideos).values({
			id: videoId,
			orgId,
			source: "loom",
			sourceId: loomVideoId,
		});
		if (migrationRequestId) {
			await recordConciergeImport(tx, videoId, migrationRequestId);
		}

		if (destination.spaceId === orgId) {
			await tx.insert(sharedVideos).values({
				id: nanoId(),
				videoId,
				organizationId: orgId,
				sharedByUserId: ownerId,
				folderId: destination.folderId,
			});
		} else if (destination.spaceId) {
			await tx.insert(spaceVideos).values({
				id: nanoId(),
				videoId,
				spaceId: destination.spaceId,
				addedById: ownerId,
				folderId: destination.folderId,
			});
		}
	});

	const rawFileKey = `${ownerId}/${videoId}/raw-upload.mp4`;

	if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production") {
		await dub()
			.links.create({
				url: `${serverEnv().WEB_URL}/s/${videoId}`,
				domain: "cap.link",
				key: videoId,
			})
			.catch(() => {});
	}

	try {
		await startLoomImportWorkflow({
			videoId,
			userId: ownerId,
			rawFileKey,
			bucketId: Option.getOrNull(writable.bucketId),
			loomVideoId,
			loomDownloadUrl: downloadUrl,
			importPriority,
		});
	} catch (error) {
		if (error instanceof LoomImportStartError && error.canRetry) {
			await restoreLoomImportStartError(
				videoId,
				"uploading",
				claimedAt,
				error.message,
			);
		}
		return {
			success: false,
			videoId,
			error:
				error instanceof Error ? error.message : "Loom import could not start.",
		};
	}

	revalidatePath("/dashboard/caps");
	if (destination.folderId) revalidatePath("/dashboard/folder/[id]", "page");
	if (destination.spaceId) {
		revalidatePath("/dashboard/spaces/[spaceId]", "page");
		revalidatePath("/dashboard/spaces/[spaceId]/folder/[folderId]", "page");
	}

	return { success: true, videoId };
}

export function normalizeImportEmail(email: string) {
	return email.trim().toLowerCase();
}

export function normalizeImportSpaceName(spaceName: string) {
	return spaceName.trim().replace(/\s+/g, " ");
}

export function getSpaceNameCacheKey(spaceName: string) {
	return normalizeImportSpaceName(spaceName).toLowerCase();
}

export function isValidImportEmail(email: string) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidImportSpaceName(spaceName: string) {
	return spaceName.length <= MAX_LOOM_SPACE_NAME_LENGTH;
}

export async function getOrganizationMemberByEmail(
	orgId: Organisation.OrganisationId,
	email: string,
) {
	const [member] = await db()
		.select({
			userId: organizationMembers.userId,
			email: users.email,
		})
		.from(organizationMembers)
		.innerJoin(users, eq(organizationMembers.userId, users.id))
		.where(
			and(
				eq(organizationMembers.organizationId, orgId),
				eq(users.email, email),
			),
		)
		.limit(1);

	return member ?? null;
}

export type ImportSpaceCacheValue = {
	id: Space.SpaceIdOrOrganisationId;
	name: string;
};

export async function getOrCreateImportSpace({
	orgId,
	createdById,
	name,
	spaceCache,
}: {
	orgId: Organisation.OrganisationId;
	createdById: User.UserId;
	name: string;
	spaceCache: Map<string, ImportSpaceCacheValue>;
}) {
	const normalizedName = normalizeImportSpaceName(name);
	const cacheKey = getSpaceNameCacheKey(normalizedName);
	const cached = spaceCache.get(cacheKey);
	if (cached) return cached;

	const [existingSpace] = await db()
		.select({
			id: spaces.id,
			name: spaces.name,
		})
		.from(spaces)
		.where(
			and(eq(spaces.organizationId, orgId), eq(spaces.name, normalizedName)),
		)
		.limit(1);

	if (existingSpace) {
		const value = {
			id: existingSpace.id,
			name: existingSpace.name,
		};
		spaceCache.set(cacheKey, value);
		return value;
	}

	const spaceId = Space.SpaceId.make(nanoId());

	await db().transaction(async (tx) => {
		await tx.insert(spaces).values({
			id: spaceId,
			name: normalizedName,
			organizationId: orgId,
			createdById,
			iconUrl: null,
		});

		await tx.insert(spaceMembers).values({
			id: SpaceMemberId.make(nanoId()),
			spaceId,
			userId: createdById,
			role: "admin",
		});
	});

	const value = {
		id: spaceId,
		name: normalizedName,
	};
	spaceCache.set(cacheKey, value);
	return value;
}

export async function addImportedVideoToSpace({
	videoId,
	spaceId,
	addedById,
}: {
	videoId: Video.VideoId;
	spaceId: Space.SpaceIdOrOrganisationId;
	addedById: User.UserId;
}) {
	const [existingSpaceVideo] = await db()
		.select({ id: spaceVideos.id })
		.from(spaceVideos)
		.where(
			and(eq(spaceVideos.spaceId, spaceId), eq(spaceVideos.videoId, videoId)),
		)
		.limit(1);

	if (existingSpaceVideo) return;

	await db().insert(spaceVideos).values({
		id: nanoId(),
		spaceId,
		videoId,
		addedById,
	});
}

export async function addImportOwnerToSpace({
	spaceId,
	userId,
}: {
	spaceId: Space.SpaceIdOrOrganisationId;
	userId: User.UserId;
}) {
	const [existingSpaceMember] = await db()
		.select({ id: spaceMembers.id })
		.from(spaceMembers)
		.where(
			and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)),
		)
		.limit(1);

	if (existingSpaceMember) return;

	await db()
		.insert(spaceMembers)
		.values({
			id: SpaceMemberId.make(nanoId()),
			spaceId,
			userId,
			role: "member",
		});
}

async function getOrCreatePersonalImportFolder({
	orgId,
	ownerId,
	name,
}: {
	orgId: Organisation.OrganisationId;
	ownerId: User.UserId;
	name: string;
}) {
	const match = () =>
		db()
			.select({ id: folders.id })
			.from(folders)
			.where(
				and(
					eq(folders.organizationId, orgId),
					eq(folders.createdById, ownerId),
					eq(folders.name, name),
					isNull(folders.spaceId),
					isNull(folders.parentId),
				),
			)
			.orderBy(asc(folders.createdAt))
			.limit(1);
	const [existing] = await match();
	if (existing) return existing.id;
	await db()
		.insert(folders)
		.values({
			id: Folder.FolderId.make(nanoId()),
			name,
			organizationId: orgId,
			createdById: ownerId,
		});
	const [created] = await match();
	return created?.id;
}

export async function processLoomCsvRows({
	rows,
	orgId,
	actorId,
	migrationRequestId,
	migrationLeaseToken,
	allowFolders = false,
	importPriority,
}: {
	rows: LoomCsvImportRow[];
	orgId: Organisation.OrganisationId;
	actorId: User.UserId;
	migrationRequestId?: string;
	migrationLeaseToken?: string;
	allowFolders?: boolean;
	importPriority?: "customer" | "bulk";
}): Promise<LoomCsvImportResult> {
	const inputRows = Array.isArray(rows) ? rows : [];
	const normalizedRows = inputRows
		.map((row, index) => ({
			rowNumber:
				Number.isInteger(row.rowNumber) && row.rowNumber > 0
					? row.rowNumber
					: index + 2,
			loomUrl: typeof row.loomUrl === "string" ? row.loomUrl.trim() : "",
			userEmail:
				typeof row.userEmail === "string"
					? normalizeImportEmail(row.userEmail)
					: "",
			spaceName:
				typeof row.spaceName === "string"
					? normalizeImportSpaceName(row.spaceName)
					: "",
			folderName:
				allowFolders && typeof row.folderName === "string"
					? normalizeImportSpaceName(row.folderName)
					: "",
		}))
		.filter((row) => row.loomUrl || row.userEmail || row.spaceName);

	if (normalizedRows.length === 0) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error: "No rows found to import.",
		};
	}

	if (normalizedRows.length > MAX_LOOM_CSV_ROWS) {
		return {
			success: false,
			importedCount: 0,
			failedCount: normalizedRows.length,
			results: [],
			error: LOOM_CSV_LIMIT_ERROR,
		};
	}

	const results: LoomCsvImportRowResult[] = [];
	const spaceCache = new Map<string, ImportSpaceCacheValue>();
	const touchedSpaceIds = new Set<Space.SpaceIdOrOrganisationId>();

	for (const row of normalizedRows) {
		if (migrationRequestId) {
			if (!migrationLeaseToken) {
				throw new LoomMigrationError(
					"The concierge import is missing its reservation.",
				);
			}
			await renewConciergeImport(migrationRequestId, migrationLeaseToken);
		}
		if (!row.loomUrl) {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName || undefined,
				success: false,
				error: "Missing Loom video URL.",
			});
			continue;
		}

		if (!isValidImportEmail(row.userEmail)) {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName || undefined,
				success: false,
				error: "Missing or invalid user email.",
			});
			continue;
		}

		if (!isValidImportSpaceName(row.spaceName)) {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName,
				success: false,
				error: `Space name must be ${MAX_LOOM_SPACE_NAME_LENGTH} characters or fewer.`,
			});
			continue;
		}

		let member = await getOrganizationMemberByEmail(orgId, row.userEmail);

		if (!member) {
			try {
				const provisionedMember = await provisionOrganizationInvitee({
					organizationId: orgId,
					email: row.userEmail,
					invitedByUserId: actorId,
					role: "member",
				});
				member = {
					userId: provisionedMember.userId,
					email: row.userEmail,
				};
			} catch {
				results.push({
					rowNumber: row.rowNumber,
					userEmail: row.userEmail,
					spaceName: row.spaceName || undefined,
					success: false,
					error: "Could not add this email to the organization.",
				});
				continue;
			}
		}

		try {
			const folderId = row.folderName
				? await getOrCreatePersonalImportFolder({
						orgId,
						ownerId: member.userId,
						name: row.folderName,
					})
				: undefined;
			const result = await importLoomVideoForOwner({
				loomUrl: row.loomUrl,
				orgId,
				ownerId: member.userId,
				destination: folderId ? { folderId } : {},
				migrationRequestId,
				migrationLeaseToken,
				importPriority,
			});

			let spaceName = row.spaceName || undefined;
			let spaceError: string | undefined;
			if (result.success && result.videoId && row.spaceName) {
				try {
					const space = await getOrCreateImportSpace({
						orgId,
						createdById: actorId,
						name: row.spaceName,
						spaceCache,
					});
					await addImportedVideoToSpace({
						videoId: result.videoId,
						spaceId: space.id,
						addedById: actorId,
					});
					await addImportOwnerToSpace({
						spaceId: space.id,
						userId: member.userId,
					});
					touchedSpaceIds.add(space.id);
					spaceName = space.name;
				} catch {
					spaceError = "Import started, but it could not be added to a space.";
				}
			}

			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName,
				success: result.success,
				videoId: result.videoId,
				error: result.error ?? spaceError,
				...(result.errorCode ? { errorCode: result.errorCode } : {}),
			});
		} catch {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName || undefined,
				success: false,
				error: "Failed to start this import.",
			});
		}
	}

	const importedCount = results.filter((result) => result.success).length;
	const failedCount = results.length - importedCount;

	for (const spaceId of touchedSpaceIds) {
		revalidatePath(`/dashboard/spaces/${spaceId}`);
	}

	if (touchedSpaceIds.size > 0) {
		revalidatePath("/dashboard");
	}

	return {
		success: importedCount > 0,
		importedCount,
		failedCount,
		results,
		error: importedCount > 0 ? undefined : "No Loom videos were imported.",
	};
}
