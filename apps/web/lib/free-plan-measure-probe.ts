import type { videos } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import type { Video } from "@cap/web-domain";
import { after } from "next/server";
import { measuredMediaSeconds } from "@/lib/free-plan-duration";
import {
	loadLimitedVideo,
	needsFreePlanMeasure,
	readFreePlanMeasure,
	recordFreePlanMeasure,
} from "@/lib/free-plan-measure";
import {
	isMediaServerConfigured,
	tryProbeVideoViaMediaServer,
} from "@/lib/media-client";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const PROBE_URL_EXPIRES_SECONDS = 10 * 60;
const MAX_CONCURRENT_MEASUREMENTS = 4;

const FAILED_PROBE_RETRY_MS = 60_000;
const MAX_FAILED_PROBES = 5_000;

const inFlight = new Set<string>();
const failedUntil = new Map<string, number>();

const failureKey = (videoId: string, key: string) => `${videoId}:${key}`;

async function probeStoredObject(
	video: typeof videos.$inferSelect,
	key: string,
): Promise<{ seconds: number | null } | null> {
	if (!isMediaServerConfigured()) return null;
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const url = await bucket
		.getInternalSignedObjectUrl(key, { expiresIn: PROBE_URL_EXPIRES_SECONDS })
		.pipe(runWorkflowPromise);
	const attempt = await tryProbeVideoViaMediaServer(url);
	if (attempt.status === "ok")
		return { seconds: measuredMediaSeconds(attempt.metadata) };
	if (attempt.status === "rejected" && attempt.unusable)
		return { seconds: null };
	return null;
}

export async function measureFreePlanObject(
	videoId: Video.VideoId,
	key: string,
	{ anyAge = false }: { anyAge?: boolean } = {},
): Promise<void> {
	if (inFlight.has(videoId) || inFlight.size >= MAX_CONCURRENT_MEASUREMENTS)
		return;
	if ((failedUntil.get(failureKey(videoId, key)) ?? 0) > Date.now()) return;
	inFlight.add(videoId);
	try {
		if (!buildEnv.NEXT_PUBLIC_IS_CAP) return;
		const video = await loadLimitedVideo(videoId, { anyAge });
		if (!video) return;
		const measured = await probeStoredObject(video, key);
		if (!measured) {
			if (failedUntil.size >= MAX_FAILED_PROBES) failedUntil.clear();
			failedUntil.set(
				failureKey(videoId, key),
				Date.now() + FAILED_PROBE_RETRY_MS,
			);
			return;
		}
		failedUntil.delete(failureKey(videoId, key));
		await recordFreePlanMeasure(videoId, key, measured.seconds);
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not measure %s (%s):",
			videoId,
			key,
			error,
		);
	} finally {
		inFlight.delete(videoId);
	}
}

export function runAfterResponse(task: () => Promise<void>): void {
	try {
		after(task);
	} catch {
		void task();
	}
}

export function measureFreePlanObjectIfNeeded(
	video: { id: Video.VideoId; createdAt: Date; metadata: object | null },
	key: string,
): void {
	try {
		if (needsFreePlanMeasure(video, key))
			runAfterResponse(() => measureFreePlanObject(video.id, key));
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not schedule a measurement:",
			error,
		);
	}
}

// A held video is measured again while a replacement upload can still land,
// so a shorter replacement is not left held.
export function remeasureHeldVideoIfNeeded(video: {
	id: Video.VideoId;
	createdAt: Date;
	metadata: object | null;
}): void {
	const measure = readFreePlanMeasure(video.metadata);
	if (measure) measureFreePlanObjectIfNeeded(video, measure.key);
}
