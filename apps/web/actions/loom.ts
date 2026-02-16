"use server";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	importedVideos,
	s3Buckets,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
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
	videoId?: string;
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

		return id.split("?")[0] ?? null;
	} catch {
		return null;
	}
}

async function fetchLoomEndpoint(
	videoId: string,
	endpoint: string,
): Promise<string | null> {
	try {
		const response = await fetch(
			`https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					anonID: randomUUID(),
					deviceID: null,
					force_original: false,
					password: null,
				}),
			},
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
	const endpoints = ["transcoded-url", "raw-url"] as const;

	let fallbackStreamingUrl: string | null = null;

	for (const endpoint of endpoints) {
		const url = await fetchLoomEndpoint(loomVideoId, endpoint);
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
		const transcodedUrl = await fetchLoomEndpoint(videoId, "transcoded-url");
		const rawUrl = await fetchLoomEndpoint(videoId, "raw-url");

		if (!transcodedUrl && !rawUrl) {
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

	const loomVideoId = extractLoomVideoId(loomUrl.trim());
	if (!loomVideoId) {
		return {
			success: false,
			error:
				"Invalid Loom URL. Please paste a valid Loom video link (e.g. https://www.loom.com/share/abc123).",
		};
	}

	const existing = await db()
		.select()
		.from(importedVideos)
		.where(
			and(
				eq(importedVideos.orgId, orgId),
				eq(importedVideos.source, "loom"),
				eq(importedVideos.sourceId, loomVideoId),
			),
		);

	if (existing.length > 0) {
		return {
			success: false,
			error: "This Loom video has already been imported.",
		};
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

	const [customBucket] = await db()
		.select()
		.from(s3Buckets)
		.where(eq(s3Buckets.ownerId, user.id));

	const videoId = Video.VideoId.make(nanoId());
	const name =
		videoName ||
		`Loom Import - ${new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}`;

	await db()
		.insert(videos)
		.values({
			id: videoId,
			name,
			ownerId: user.id,
			orgId,
			source: { type: "webMP4" as const },
			bucket: customBucket?.id,
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

	const importId = nanoId();
	await db().insert(importedVideos).values({
		id: importId,
		orgId,
		source: "loom",
		sourceId: loomVideoId,
	});

	const rawFileKey = `${user.id}/${videoId}/raw-upload.mp4`;

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
			userId: user.id,
			rawFileKey,
			bucketId: customBucket?.id ?? null,
			loomDownloadUrl: downloadUrl,
		},
	]);

	revalidatePath("/dashboard/caps");

	return { success: true, videoId };
}
