import type { videos } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import type { Video } from "@cap/web-domain";
import { Effect } from "effect";
import { after } from "next/server";
import {
	exceedsFreePlanMeasuredDuration,
	measuredMediaSeconds,
} from "@/lib/free-plan-duration";
import {
	loadLimitedVideo,
	measureHoldsVideo,
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

const UNAVAILABLE_RETRY_MS = 60_000;
const TIMED_OUT_RETRY_MS = 60_000;
const MAX_UNAVAILABLE_ENTRIES = 5_000;

const FIRST_VIEW_MEASURE_TIMEOUT_MS = 5_000;

// Measured: the length is known (null when the file has no measurable
// length, such as an upload that is still being written). Unmeasurable: the
// media server timed out on this file, so it is tried again later. Skipped:
// nothing was measured, because the video is not limited or the media server
// cannot be reached.
export type FreePlanMeasureOutcome =
	| { kind: "measured"; seconds: number | null }
	| { kind: "unmeasurable" }
	| { kind: "skipped" };

const SKIPPED: FreePlanMeasureOutcome = { kind: "skipped" };
const UNMEASURED: FreePlanMeasureOutcome = { kind: "unmeasurable" };

// Beyond a video's own files, probing more distinct files of one video than
// this in the window means someone is making names up.
const MAX_FILES_PER_VIDEO = 4;
const FILES_PER_VIDEO_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_VIDEOS = 5_000;

// A file measured in the last 30 s is not probed again, so asking for a
// video's files in turn cannot make each request a probe. Thirty seconds is
// also how soon a replacement upload is measured again.
const MEASURED_FILE_TTL_MS = 30_000;

const inFlight = new Map<string, Promise<FreePlanMeasureOutcome>>();
// The outcome for the exact object an upload last completed, so completing the
// same upload again reuses it instead of probing.
const measuredIdentities = new Map<
	string,
	{ identity: string; outcome: FreePlanMeasureOutcome }
>();
const measuredFiles = new Map<
	string,
	{ outcome: FreePlanMeasureOutcome; until: number }
>();
const probedFiles = new Map<string, { keys: Set<string>; until: number }>();

const RAW_UPLOAD_NAMES = new Set(
	["mp4", "webm", "mov", "m4v", "mkv"].map(
		(extension) => `raw-upload.${extension}`,
	),
);

// The files a video itself plays: its MP4 output and its raw upload.
function isVideosOwnFile(
	video: typeof videos.$inferSelect,
	key: string,
): boolean {
	const prefix = `${video.ownerId}/${video.id}/`;
	return (
		key === `${prefix}result.mp4` ||
		RAW_UPLOAD_NAMES.has(key.slice(prefix.length)) ||
		("outputKey" in video.source && key === video.source.outputKey)
	);
}

// Whether this file may be probed now for this video; counts it if so.
function admitFile(videoId: string, key: string): boolean {
	const now = Date.now();
	let entry = probedFiles.get(videoId);
	if (!entry || entry.until <= now) {
		if (probedFiles.size >= MAX_TRACKED_VIDEOS) probedFiles.clear();
		entry = { keys: new Set(), until: now + FILES_PER_VIDEO_WINDOW_MS };
		probedFiles.set(videoId, entry);
	}
	if (entry.keys.has(key)) return true;
	if (entry.keys.size >= MAX_FILES_PER_VIDEO) return false;
	entry.keys.add(key);
	return true;
}
const unavailableUntil = new Map<string, number>();
const timedOutUntil = new Map<string, number>();
const waiting: Array<() => void> = [];
let running = 0;

const objectKey = (videoId: string, key: string) => `${videoId}:${key}`;

async function withMeasurementSlot<T>(task: () => Promise<T>): Promise<T> {
	if (running >= MAX_CONCURRENT_MEASUREMENTS)
		await new Promise<void>((resolve) => waiting.push(resolve));
	running += 1;
	try {
		return await task();
	} finally {
		running -= 1;
		waiting.shift()?.();
	}
}

// `sameObject` says the object still carried the completion's identity both
// before and after the probe, so the length belongs to that upload and not
// to a replacement written meanwhile.
async function probeStoredObject(
	video: typeof videos.$inferSelect,
	key: string,
	identity: string | null,
): Promise<{
	outcome: FreePlanMeasureOutcome | "unavailable";
	sameObject: boolean;
}> {
	if (!isMediaServerConfigured())
		return { outcome: "unavailable", sameObject: false };
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const currentIdentity = () =>
		bucket.headObject(key).pipe(
			Effect.map((head) => head.ETag ?? null),
			Effect.orElseSucceed(() => null),
			runWorkflowPromise,
		);
	const before = identity ? await currentIdentity() : null;
	const url = await bucket
		.getInternalSignedObjectUrl(key, { expiresIn: PROBE_URL_EXPIRES_SECONDS })
		.pipe(runWorkflowPromise);
	const outcome = probeOutcome(await tryProbeVideoViaMediaServer(url));
	const sameObject =
		identity !== null &&
		before === identity &&
		(await currentIdentity()) === identity;
	return { outcome, sameObject };
}

function probeOutcome(
	attempt: Awaited<ReturnType<typeof tryProbeVideoViaMediaServer>>,
): FreePlanMeasureOutcome | "unavailable" {
	if (attempt.status === "ok")
		return {
			kind: "measured",
			seconds: measuredMediaSeconds(attempt.metadata),
		};
	if (attempt.status === "timed_out") return { kind: "unmeasurable" };
	if (attempt.status === "rejected" && attempt.unusable)
		return { kind: "measured", seconds: null };
	return "unavailable";
}

// A completed upload passes fresh, so the file it just wrote is measured
// rather than an earlier one under the same name.
export function measureFreePlanObject(
	videoId: Video.VideoId,
	key: string,
	{
		anyAge = false,
		fresh = false,
		identity,
	}: { anyAge?: boolean; fresh?: boolean; identity?: string | null } = {},
): Promise<FreePlanMeasureOutcome> {
	const id = objectKey(videoId, key);
	const known = identity ? measuredIdentities.get(id) : undefined;
	if (known && known.identity === identity)
		return restoreMeasure(videoId, key, known.outcome, anyAge);
	const previous = inFlight.get(id);
	if (fresh) {
		measuredFiles.delete(id);
		timedOutUntil.delete(id);
		unavailableUntil.delete(id);
	} else {
		const measured = measuredFiles.get(id);
		if (measured && measured.until > Date.now())
			return Promise.resolve(measured.outcome);
		if (previous) return previous;
		if ((unavailableUntil.get(id) ?? 0) > Date.now())
			return Promise.resolve(SKIPPED);
		if ((timedOutUntil.get(id) ?? 0) > Date.now())
			return Promise.resolve(UNMEASURED);
	}
	const measurement: Promise<FreePlanMeasureOutcome> = (
		previous
			? previous.then(
					() => undefined,
					() => undefined,
				)
			: Promise.resolve()
	)
		.then(() =>
			withMeasurementSlot(() =>
				measureNow(videoId, key, anyAge, identity ?? null),
			),
		)
		.finally(() => {
			if (inFlight.get(id) === measurement) inFlight.delete(id);
		});
	inFlight.set(id, measurement);
	return measurement;
}

// The same object completed again: no probe, but its length is written back
// if another upload replaced the saved measurement in the meantime.
async function restoreMeasure(
	videoId: Video.VideoId,
	key: string,
	outcome: FreePlanMeasureOutcome,
	anyAge: boolean,
): Promise<FreePlanMeasureOutcome> {
	if (outcome.kind !== "measured") return outcome;
	try {
		const video = await loadLimitedVideo(videoId, { anyAge });
		if (!video) return SKIPPED;
		const saved = readFreePlanMeasure(video.metadata);
		if (saved?.key !== key || saved.seconds !== outcome.seconds)
			await recordFreePlanMeasure(videoId, key, outcome.seconds);
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not restore %s (%s):",
			videoId,
			key,
			error,
		);
	}
	return outcome;
}

function rememberIdentity(
	id: string,
	identity: string | null,
	outcome: FreePlanMeasureOutcome,
) {
	if (!identity) return;
	if (measuredIdentities.size >= MAX_TRACKED_VIDEOS) measuredIdentities.clear();
	measuredIdentities.set(id, { identity, outcome });
}

async function measureNow(
	videoId: Video.VideoId,
	key: string,
	anyAge: boolean,
	identity: string | null,
): Promise<FreePlanMeasureOutcome> {
	try {
		if (!buildEnv.NEXT_PUBLIC_IS_CAP) return SKIPPED;
		const video = await loadLimitedVideo(videoId, { anyAge });
		if (!video) return SKIPPED;
		if (!isVideosOwnFile(video, key) && !admitFile(videoId, key))
			return UNMEASURED;
		const { outcome, sameObject } = await probeStoredObject(
			video,
			key,
			identity,
		);
		const id = objectKey(videoId, key);
		if (outcome === "unavailable") {
			if (unavailableUntil.size >= MAX_UNAVAILABLE_ENTRIES)
				unavailableUntil.clear();
			unavailableUntil.set(id, Date.now() + UNAVAILABLE_RETRY_MS);
			return SKIPPED;
		}
		unavailableUntil.delete(id);
		if (outcome.kind === "unmeasurable") {
			if (timedOutUntil.size >= MAX_UNAVAILABLE_ENTRIES) timedOutUntil.clear();
			timedOutUntil.set(id, Date.now() + TIMED_OUT_RETRY_MS);
			return outcome;
		}
		timedOutUntil.delete(id);
		if (outcome.kind !== "measured") return outcome;
		const existing = readFreePlanMeasure(video.metadata);
		if (outcome.seconds === null && existing && measureHoldsVideo(existing)) {
			const kept: FreePlanMeasureOutcome = {
				kind: "measured",
				seconds: existing.seconds,
			};
			if (sameObject) rememberIdentity(id, identity, kept);
			return kept;
		}
		await recordFreePlanMeasure(videoId, key, outcome.seconds);
		if (sameObject) rememberIdentity(id, identity, outcome);
		if (measuredFiles.size >= MAX_TRACKED_VIDEOS) measuredFiles.clear();
		measuredFiles.set(id, {
			outcome,
			until: Date.now() + MEASURED_FILE_TTL_MS,
		});
		return outcome;
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not measure %s (%s):",
			videoId,
			key,
			error,
		);
		return SKIPPED;
	}
}

export type FirstViewDecision = "play" | "held" | "pending";

const decisionFor = (outcome: FreePlanMeasureOutcome): FirstViewDecision =>
	outcome.kind === "unmeasurable"
		? "pending"
		: outcome.kind === "measured" &&
				exceedsFreePlanMeasuredDuration(outcome.seconds)
			? "held"
			: "play";

// Someone other than the owner is about to play an object nobody has
// measured yet: measure it first, so a video over the limit is never served
// before it is held. A measurement still running after a few seconds leaves
// the video pending, and the viewer tries again. An unreachable media server
// leaves the video playable, as it was before measuring.
export async function firstViewDecision(
	video: { id: Video.VideoId; createdAt: Date; metadata: object | null },
	key: string,
): Promise<FirstViewDecision> {
	try {
		if (!needsFreePlanMeasure(video, key)) return "play";
		let timer: Parameters<typeof clearTimeout>[0];
		const outcome = await Promise.race([
			measureFreePlanObject(video.id, key),
			new Promise<"pending">((resolve) => {
				timer = setTimeout(
					() => resolve("pending"),
					FIRST_VIEW_MEASURE_TIMEOUT_MS,
				);
			}),
		]).finally(() => clearTimeout(timer));
		return outcome === "pending" ? "pending" : decisionFor(outcome);
	} catch (error) {
		console.error(
			"[free-plan-measure] Could not measure before viewing:",
			error,
		);
		return "play";
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
