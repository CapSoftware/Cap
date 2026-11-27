import { db } from "@cap/database";
import { importedVideos, videos } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import {
	desktopLimitAppliesTo,
	exceedsFreePlanMeasuredDuration,
	FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM,
	ownerOrOrganizationHasPro,
} from "@/lib/free-plan-duration";

const FREE_PLAN_MEASURE_KEY = "freePlanMeasure";
const FREE_PLAN_UPLOAD_OPEN_UNTIL_KEY = "freePlanUploadOpenUntil";

const REMEASURE_INTERVAL_MS = 30_000;

export type FreePlanMeasure = {
	key: string;
	seconds: number | null;
	at: string;
};

type MetadataInput = object | null | undefined;

const metadataField = (metadata: MetadataInput, key: string): unknown =>
	metadata ? (metadata as Record<string, unknown>)[key] : undefined;

export function readFreePlanMeasure(
	metadata: MetadataInput,
): FreePlanMeasure | null {
	const value = metadataField(metadata, FREE_PLAN_MEASURE_KEY);
	if (!value || typeof value !== "object") return null;
	const { key, seconds, at } = value as Record<string, unknown>;
	if (typeof key !== "string" || typeof at !== "string") return null;
	return {
		key,
		seconds:
			typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null,
		at,
	};
}

export function measureHoldsVideo(measure: FreePlanMeasure | null): boolean {
	return measure !== null && exceedsFreePlanMeasuredDuration(measure.seconds);
}

function readUploadOpenUntil(metadata: MetadataInput): number | null {
	const value = metadataField(metadata, FREE_PLAN_UPLOAD_OPEN_UNTIL_KEY);
	if (typeof value !== "string") return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : time;
}

function measuredByAge(video: {
	createdAt: Date;
	metadata: MetadataInput;
}): boolean {
	return (
		video.createdAt >= FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM ||
		readUploadOpenUntil(video.metadata) !== null
	);
}

export function needsFreePlanMeasure(
	video: { createdAt: Date; metadata: MetadataInput },
	key: string,
	now: number = Date.now(),
): boolean {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return false;
	if (!measuredByAge(video)) return false;
	const openUntil = readUploadOpenUntil(video.metadata);
	const measure = readFreePlanMeasure(video.metadata);
	if (!measure || measure.key !== key) return true;
	if (openUntil === null) return false;
	const measuredAt = Date.parse(measure.at);
	if (Number.isNaN(measuredAt)) return true;
	return measuredAt <= openUntil && now - measuredAt >= REMEASURE_INTERVAL_MS;
}

async function desktopLimitApplies(videoId: Video.VideoId): Promise<boolean> {
	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			source: videos.source,
			createdAt: videos.createdAt,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	return video ? desktopLimitAppliesTo(video) : false;
}

// Evaluated on every read, so upgrading the owner or the organization owner
// lifts it at once and nothing is deleted.
export async function isVideoOverFreePlanDuration(video: {
	id: Video.VideoId;
	ownerId: Video.Video["ownerId"];
	orgId: Video.Video["orgId"];
	metadata: MetadataInput;
}): Promise<boolean> {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return false;
	const measure = readFreePlanMeasure(video.metadata);
	if (!measureHoldsVideo(measure)) return false;
	if (!(await desktopLimitApplies(video.id))) return false;
	const [imported] = await db()
		.select({ id: importedVideos.id })
		.from(importedVideos)
		.where(eq(importedVideos.id, video.id))
		.limit(1);
	if (imported) return false;
	return !(await ownerOrOrganizationHasPro(video.ownerId, video.orgId));
}

export async function isVideoLockedByFreePlanDuration(
	videoId: Video.VideoId,
): Promise<boolean> {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return false;
	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			orgId: videos.orgId,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!video) return false;
	return isVideoOverFreePlanDuration(video);
}

export async function recordFreePlanMeasure(
	videoId: Video.VideoId,
	key: string,
	seconds: number | null,
): Promise<void> {
	await db()
		.update(videos)
		// Views are not counted for two minutes after a Cap changes, and a
		// measurement can be taken when someone opens it.
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.freePlanMeasure', JSON_OBJECT('key', ${key}, 'seconds', ${seconds}, 'at', ${new Date().toISOString()}))`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(eq(videos.id, videoId));
}

export async function markFreePlanUploadOpen(
	videoId: Video.VideoId,
	expiresInSeconds: number,
): Promise<void> {
	const until = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.freePlanUploadOpenUntil', ${until})`,
		})
		.where(eq(videos.id, videoId));
}

const NOT_LIMITED_CACHE_MS = 10 * 60_000;
const MAX_NOT_LIMITED_ENTRIES = 5_000;
const notLimitedUntil = new Map<string, number>();
const notMeasuredUntil = new Map<string, number>();

function remember(cache: Map<string, number>, videoId: string) {
	if (cache.size >= MAX_NOT_LIMITED_ENTRIES) cache.clear();
	cache.set(videoId, Date.now() + NOT_LIMITED_CACHE_MS);
}

const remembered = (cache: Map<string, number>, videoId: string) =>
	(cache.get(videoId) ?? 0) > Date.now();

export async function loadLimitedVideo(
	videoId: Video.VideoId,
	{ anyAge }: { anyAge: boolean },
) {
	if (remembered(notLimitedUntil, videoId)) return null;
	if (!anyAge && remembered(notMeasuredUntil, videoId)) return null;
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!video) return null;
	if (!desktopLimitAppliesTo(video)) {
		remember(notLimitedUntil, videoId);
		return null;
	}
	if (!anyAge && !measuredByAge(video)) {
		remember(notMeasuredUntil, videoId);
		return null;
	}
	const [imported] = await db()
		.select({ id: importedVideos.id })
		.from(importedVideos)
		.where(eq(importedVideos.id, videoId))
		.limit(1);
	if (
		imported ||
		(await ownerOrOrganizationHasPro(video.ownerId, video.orgId))
	) {
		remember(notLimitedUntil, videoId);
		return null;
	}
	return video;
}

// Records a length the server measured itself for a free plan video, so its
// first viewers do not wait on a probe.
export async function recordFreePlanLength(
	videoId: Video.VideoId,
	key: string,
	seconds: number,
	{ anyAge = false }: { anyAge?: boolean } = {},
): Promise<void> {
	try {
		if (!buildEnv.NEXT_PUBLIC_IS_CAP) return;
		const video = await loadLimitedVideo(videoId, { anyAge });
		if (!video) return;
		await recordFreePlanMeasure(videoId, key, seconds);
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not record %s (%s):",
			videoId,
			key,
			error,
		);
	}
}

// Resolves to whether the video is held by this length.
export async function recordFreePlanOverLength(
	videoId: Video.VideoId,
	key: string,
	seconds: number,
	{ anyAge = false }: { anyAge?: boolean } = {},
): Promise<boolean> {
	if (!exceedsFreePlanMeasuredDuration(seconds)) return false;
	try {
		if (!buildEnv.NEXT_PUBLIC_IS_CAP) return false;
		const video = await loadLimitedVideo(videoId, { anyAge });
		if (!video) return false;
		const measure = readFreePlanMeasure(video.metadata);
		if (
			measure?.key === key &&
			exceedsFreePlanMeasuredDuration(measure.seconds)
		)
			return true;
		await recordFreePlanMeasure(videoId, key, seconds);
		return true;
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not record %s (%s):",
			videoId,
			key,
			error,
		);
		return false;
	}
}
