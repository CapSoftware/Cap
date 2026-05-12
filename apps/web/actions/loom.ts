"use server";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	importedVideos,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import {
	type Organisation,
	Space,
	SpaceMemberId,
	type User,
	Video,
} from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { runPromise } from "@/lib/server";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";

interface LoomUrlResponse {
	url?: string;
}

interface LoomDownloadResult {
	success: boolean;
	videoId?: string;
	videoName?: string;
	error?: string;
}

export interface LoomImportResult {
	success: boolean;
	videoId?: Video.VideoId;
	error?: string;
}

export interface LoomCsvImportRow {
	rowNumber: number;
	loomUrl: string;
	userEmail: string;
	spaceName?: string;
}

export interface LoomCsvImportRowResult {
	rowNumber: number;
	userEmail: string;
	spaceName?: string;
	success: boolean;
	videoId?: Video.VideoId;
	error?: string;
}

export interface LoomCsvImportResult {
	success: boolean;
	importedCount: number;
	failedCount: number;
	results: LoomCsvImportRowResult[];
	error?: string;
}

const MAX_LOOM_CSV_ROWS = 100;
const MAX_LOOM_SPACE_NAME_LENGTH = 255;

function extractLoomVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("loom.com")) {
			return null;
		}

		const pathParts = parsed.pathname.split("/").filter(Boolean);
		const id = pathParts[pathParts.length - 1] ?? null;

		if (!id || id.length < 10) {
			return null;
		}

		return id.split("?")[0] ?? null;
	} catch {
		return null;
	}
}

async function fetchLoomEndpoint(
	videoId: string,
	endpoint: string,
	includeBody = true,
): Promise<string | null> {
	try {
		const options: RequestInit = { method: "POST" };
		if (includeBody) {
			options.headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			options.body = JSON.stringify({
				anonID: randomUUID(),
				deviceID: null,
				force_original: false,
				password: null,
			});
		}

		const response = await fetch(
			`https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`,
			options,
		);

		if (!response.ok || response.status === 204) {
			return null;
		}

		const text = await response.text();
		if (!text.trim()) {
			return null;
		}

		const data: LoomUrlResponse = JSON.parse(text);
		return data.url ?? null;
	} catch {
		return null;
	}
}

async function fetchVideoName(videoId: string): Promise<string | null> {
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

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

async function getLoomDownloadUrl(loomVideoId: string): Promise<string | null> {
	const requestVariants: Array<{ endpoint: string; includeBody: boolean }> = [
		{ endpoint: "transcoded-url", includeBody: true },
		{ endpoint: "raw-url", includeBody: true },
		{ endpoint: "transcoded-url", includeBody: false },
		{ endpoint: "raw-url", includeBody: false },
	];

	let fallbackStreamingUrl: string | null = null;

	for (const { endpoint, includeBody } of requestVariants) {
		const url = await fetchLoomEndpoint(loomVideoId, endpoint, includeBody);
		if (!url) continue;

		if (!isStreamingUrl(url)) return url;

		if (!fallbackStreamingUrl) fallbackStreamingUrl = url;
	}

	return fallbackStreamingUrl;
}

async function fetchLoomOEmbed(
	loomVideoId: string,
): Promise<{ duration?: number; width?: number; height?: number } | null> {
	try {
		const response = await fetch(
			`https://www.loom.com/v1/oembed?url=https://www.loom.com/share/${loomVideoId}`,
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

		const videoName = await fetchVideoName(videoId);
		return {
			success: true,
			videoId,
			videoName: videoName ?? undefined,
		};
	} catch {
		return {
			success: false,
			error:
				"An unexpected error occurred. Please try again or check your internet connection.",
		};
	}
}

async function importLoomVideoForOwner({
	loomUrl,
	orgId,
	ownerId,
}: {
	loomUrl: string;
	orgId: Organisation.OrganisationId;
	ownerId: User.UserId;
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
		})
		.from(importedVideos)
		.leftJoin(
			videos,
			and(
				eq(videos.id, importedVideos.id),
				eq(videos.orgId, importedVideos.orgId),
			),
		)
		.where(
			and(
				eq(importedVideos.orgId, orgId),
				eq(importedVideos.source, "loom"),
				eq(importedVideos.sourceId, loomVideoId),
			),
		);

	if (existing.some((row) => row.videoId !== null)) {
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

	const downloadUrl = await getLoomDownloadUrl(loomVideoId);
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

	const writable = await Storage.getWritableAccessForUser(ownerId, orgId).pipe(
		runPromise,
	);

	const videoId = Video.VideoId.make(nanoId());
	const name =
		videoName ||
		`Loom Import - ${new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}`;

	await db()
		.insert(videos)
		.values({
			id: videoId,
			name,
			ownerId,
			orgId,
			source: { type: "webMP4" as const },
			bucket: Option.getOrNull(writable.bucketId),
			storageIntegrationId: Option.getOrNull(writable.storageIntegrationId),
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			...(oembedMeta?.duration ? { duration: oembedMeta.duration } : {}),
			...(oembedMeta?.width ? { width: oembedMeta.width } : {}),
			...(oembedMeta?.height ? { height: oembedMeta.height } : {}),
		});

	await db().insert(videoUploads).values({
		videoId,
		phase: "uploading",
		processingProgress: 0,
		processingMessage: "Importing from Loom...",
	});

	await db().insert(importedVideos).values({
		id: videoId,
		orgId,
		source: "loom",
		sourceId: loomVideoId,
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

	await start(importLoomVideoWorkflow, [
		{
			videoId,
			userId: ownerId,
			rawFileKey,
			bucketId: Option.getOrNull(writable.bucketId),
			loomDownloadUrl: downloadUrl,
			loomVideoId,
		},
	]);

	revalidatePath("/dashboard/caps");

	return { success: true, videoId };
}

export async function importFromLoom({
	loomUrl,
	orgId,
}: {
	loomUrl: string;
	orgId: Organisation.OrganisationId;
}): Promise<LoomImportResult> {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	if (!userIsPro(user)) {
		return {
			success: false,
			error: "Importing from Loom requires a Cap Pro subscription.",
		};
	}

	await requireOrganizationAccess(user.id, orgId);

	return importLoomVideoForOwner({
		loomUrl,
		orgId,
		ownerId: user.id,
	});
}

function normalizeImportEmail(email: string) {
	return email.trim().toLowerCase();
}

function normalizeImportSpaceName(spaceName: string) {
	return spaceName.trim().replace(/\s+/g, " ");
}

function getSpaceNameCacheKey(spaceName: string) {
	return normalizeImportSpaceName(spaceName).toLowerCase();
}

function isValidImportEmail(email: string) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidImportSpaceName(spaceName: string) {
	return spaceName.length <= MAX_LOOM_SPACE_NAME_LENGTH;
}

async function getOrganizationMemberByEmail(
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

async function isOrganizationOwner(
	userId: User.UserId,
	orgId: Organisation.OrganisationId,
) {
	const [organization] = await db()
		.select({
			ownerId: organizations.ownerId,
		})
		.from(organizations)
		.where(and(eq(organizations.id, orgId), isNull(organizations.tombstoneAt)))
		.limit(1);

	return organization?.ownerId === userId;
}

type ImportSpaceCacheValue = {
	id: Space.SpaceIdOrOrganisationId;
	name: string;
};

async function getOrCreateImportSpace({
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
			role: "Admin",
		});
	});

	const value = {
		id: spaceId,
		name: normalizedName,
	};
	spaceCache.set(cacheKey, value);
	return value;
}

async function addImportedVideoToSpace({
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

	if (!(await isOrganizationOwner(user.id, orgId))) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error:
				"Only the organization owner can import Loom videos from a CSV. Ask the owner to do it.",
		};
	}

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
			error: `CSV imports are limited to ${MAX_LOOM_CSV_ROWS} rows at a time.`,
		};
	}

	const results: LoomCsvImportRowResult[] = [];
	const spaceCache = new Map<string, ImportSpaceCacheValue>();
	const touchedSpaceIds = new Set<Space.SpaceIdOrOrganisationId>();

	for (const row of normalizedRows) {
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

		const member = await getOrganizationMemberByEmail(orgId, row.userEmail);

		if (!member) {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName || undefined,
				success: false,
				error: "This email is not a member of the organization.",
			});
			continue;
		}

		try {
			const result = await importLoomVideoForOwner({
				loomUrl: row.loomUrl,
				orgId,
				ownerId: member.userId,
			});

			let spaceName = row.spaceName || undefined;
			let spaceError: string | undefined;
			if (result.success && result.videoId && row.spaceName) {
				try {
					const space = await getOrCreateImportSpace({
						orgId,
						createdById: user.id,
						name: row.spaceName,
						spaceCache,
					});
					await addImportedVideoToSpace({
						videoId: result.videoId,
						spaceId: space.id,
						addedById: user.id,
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
