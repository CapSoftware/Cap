"use server";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	folders,
	importedVideos,
	sharedVideos,
	spaceVideos,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { getNewVideoPublic } from "@cap/database/video-sharing-default";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import {
	type Organisation,
	type Space,
	type User,
	Video,
} from "@cap/web-domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import {
	requireOrganizationAccess,
	requireOrganizationSettingsManager,
} from "@/actions/organization/authorization";
import { requireSpaceManager } from "@/actions/organization/space-authorization";
import type { LoomImportDestination } from "@/lib/loom-import-destination";
import { runPromise } from "@/lib/server";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";

interface LoomUrlResponse {
	url?: string;
}

type LoomDownloadMode = "direct-download" | "browser-conversion";

interface LoomDownloadResult {
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
}

export interface LoomImportResult {
	success: boolean;
	videoId?: Video.VideoId;
	error?: string;
}

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

		const trailingLoomId = id.match(/([0-9a-f]{32})$/i)?.[1];
		if (trailingLoomId) return trailingLoomId.toLowerCase();

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

async function fetchVideoDetails(
	videoId: string,
): Promise<{ name: string | null; createdAt: string | null }> {
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
						... on RegularUserVideo { name createdAt }
						... on PrivateVideo { id }
						... on VideoPasswordMissingOrIncorrect { id }
					}
				}`,
			}),
		});

		if (!response.ok) return { name: null, createdAt: null };

		const data = await response.json();
		const video = data?.data?.getVideo;
		const createdAt =
			typeof video?.createdAt === "string" &&
			!Number.isNaN(Date.parse(video.createdAt))
				? new Date(video.createdAt).toISOString()
				: null;
		return { name: video?.name ?? null, createdAt };
	} catch {
		return { name: null, createdAt: null };
	}
}

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

function isDirectMp4Url(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".mp4");
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

		const [details, oembedMeta] = await Promise.all([
			fetchVideoDetails(videoId),
			fetchLoomOEmbed(videoId),
		]);
		return {
			success: true,
			videoId,
			videoName: details.name ?? undefined,
			downloadUrl,
			downloadMode: isDirectMp4Url(downloadUrl)
				? "direct-download"
				: "browser-conversion",
			durationSeconds: oembedMeta?.duration,
			width: oembedMeta?.width,
			height: oembedMeta?.height,
			requiresProxy: false,
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
	destination = {},
}: {
	loomUrl: string;
	orgId: Organisation.OrganisationId;
	ownerId: User.UserId;
	destination?: LoomImportDestination;
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

	const [details, oembedMeta] = await Promise.all([
		fetchVideoDetails(loomVideoId),
		fetchLoomOEmbed(loomVideoId),
	]);
	const videoName = details.name;

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
	const name =
		videoName ||
		`Loom Import - ${new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}`;
	const rawFileKey = `${ownerId}/${videoId}/raw-upload.mp4`;

	await db().transaction(async (tx) => {
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
			...(details.createdAt
				? { metadata: { customCreatedAt: details.createdAt } }
				: {}),
		});

		await tx.insert(videoUploads).values({
			videoId,
			phase: "uploading",
			processingProgress: 0,
			processingMessage: "Importing from Loom...",
			rawFileKey,
		});

		await tx.insert(importedVideos).values({
			id: videoId,
			orgId,
			source: "loom",
			sourceId: loomVideoId,
		});

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
			loomVideoId,
		},
	]);

	revalidatePath("/dashboard/caps");
	if (destination.folderId) revalidatePath("/dashboard/folder/[id]", "page");
	if (destination.spaceId) {
		revalidatePath("/dashboard/spaces/[spaceId]", "page");
		revalidatePath("/dashboard/spaces/[spaceId]/folder/[folderId]", "page");
	}

	return { success: true, videoId };
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
