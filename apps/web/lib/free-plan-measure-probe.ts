import type { videos } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import type { Video } from "@cap/web-domain";
import { after } from "next/server";
import {
	exceedsFreePlanMeasuredDuration,
	measuredMediaSeconds,
} from "@/lib/free-plan-duration";
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

const FIRST_VIEW_MEASURE_TIMEOUT_MS = 5_000;

const inFlight = new Map<string, Promise<number | null | undefined>>();
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

// Resolves to the measured length, null when it cannot be known, or
// undefined when nothing was measured.
export function measureFreePlanObject(
	videoId: Video.VideoId,
	key: string,
	{ anyAge = false }: { anyAge?: boolean } = {},
): Promise<number | null | undefined> {
	const running = inFlight.get(videoId);
	if (running) return running;
	if (inFlight.size >= MAX_CONCURRENT_MEASUREMENTS)
		return Promise.resolve(undefined);
	if ((failedUntil.get(failureKey(videoId, key)) ?? 0) > Date.now())
		return Promise.resolve(undefined);
	const measurement = measureNow(videoId, key, anyAge).finally(() =>
		inFlight.delete(videoId),
	);
	inFlight.set(videoId, measurement);
	return measurement;
}

async function measureNow(
	videoId: Video.VideoId,
	key: string,
	anyAge: boolean,
): Promise<number | null | undefined> {
	try {
		if (!buildEnv.NEXT_PUBLIC_IS_CAP) return undefined;
		const video = await loadLimitedVideo(videoId, { anyAge });
		if (!video) return undefined;
		const measured = await probeStoredObject(video, key);
		if (!measured) {
			if (failedUntil.size >= MAX_FAILED_PROBES) failedUntil.clear();
			failedUntil.set(
				failureKey(videoId, key),
				Date.now() + FAILED_PROBE_RETRY_MS,
			);
			return undefined;
		}
		failedUntil.delete(failureKey(videoId, key));
		if (
			measured.seconds === null &&
			exceedsFreePlanMeasuredDuration(
				readFreePlanMeasure(video.metadata)?.seconds ?? null,
			)
		)
			return undefined;
		await recordFreePlanMeasure(videoId, key, measured.seconds);
		return measured.seconds;
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not measure %s (%s):",
			videoId,
			key,
			error,
		);
		return undefined;
	}
}

// Someone other than the owner is about to play an object nobody has
// measured yet: measure it first, so a video over the limit is never served
// before it is held.
export async function isHeldOnFirstView(
	video: { id: Video.VideoId; createdAt: Date; metadata: object | null },
	key: string,
): Promise<boolean> {
	try {
		if (!needsFreePlanMeasure(video, key)) return false;
		let timer: Parameters<typeof clearTimeout>[0];
		const seconds = await Promise.race([
			measureFreePlanObject(video.id, key),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(resolve, FIRST_VIEW_MEASURE_TIMEOUT_MS);
			}),
		]).finally(() => clearTimeout(timer));
		return exceedsFreePlanMeasuredDuration(seconds ?? null);
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not measure before viewing:",
			error,
		);
		return false;
	}
}

export function runAfterResponse(task: () => Promise<unknown>): void {
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

const isMediaKey = (key: string) => !/\.(json|m3u8)$/i.test(key);

// A held video is measured again while a replacement upload can still land,
// so a shorter replacement is not left held.
export function remeasureHeldVideoIfNeeded(video: {
	id: Video.VideoId;
	createdAt: Date;
	metadata: object | null;
}): void {
	const measure = readFreePlanMeasure(video.metadata);
	if (measure && isMediaKey(measure.key))
		measureFreePlanObjectIfNeeded(video, measure.key);
}
