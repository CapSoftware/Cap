import { db } from "@cap/database";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import { and, asc, eq, isNull, like } from "drizzle-orm";
import { Option } from "effect";
import {
	DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED,
	DesktopRecordingSourceBlockedError,
	SourceCommitPendingError,
} from "@/lib/desktop-recording-jobs";
import { readCompletedRecordingManifest } from "@/lib/desktop-recording-verification";
import { queueDesktopSegmentsFinalization } from "@/lib/desktop-segments-finalization";
import {
	FragmentedMp4Error,
	type FragmentedTrackTiming,
	readFragmentDuration,
	readInitTiming,
} from "@/lib/fragmented-mp4-duration";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

// The September backfill wrote this exact reason for uploads whose segments exist but whose manifest never arrived.
export const MISSING_MANIFEST_ERROR_PREFIX = `${DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED}: The recording manifest is missing`;
const INCOMPLETE_REBUILD_ERROR_PREFIX = `${DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED}: The missing manifest could not be rebuilt`;

const MAX_INIT_BYTES = 1024 * 1024;
const MAX_SEGMENT_SECONDS = 30;
const DURATION_READ_CONCURRENCY = 32;
// Video and audio segments are cut on the same schedule, so a large gap means one track stopped uploading early.
const MAX_TRACK_DURATION_GAP_SECONDS = 5;
const MAX_TRACK_DURATION_GAP_RATIO = 0.05;

type Track = "video" | "audio";

interface SegmentObject {
	index: number;
	size: number;
}

interface TrackInventory {
	initSize?: number;
	segments: SegmentObject[];
}

export type ManifestRebuildInspection =
	| {
			status: "ready";
			videoId: Video.VideoId;
			ownerId: User.UserId;
			manifest: string;
			videoSegments: number;
			audioSegments: number;
			durationSeconds: number;
	  }
	| { status: "not-found" }
	| { status: "not-eligible"; reason: string }
	| { status: "unsupported-storage" }
	| { status: "manifest-exists" }
	| { status: "incomplete"; reason: string };

export type ManifestRebuildResult =
	| Exclude<ManifestRebuildInspection, { status: "ready" }>
	| {
			status: "checked" | "queued" | "already-processing";
			videoSegments: number;
			audioSegments: number;
			durationSeconds: number;
	  }
	| { status: "blocked"; reason: string };

class IncompleteSegmentsError extends Error {}

function incomplete(reason: string): never {
	throw new IncompleteSegmentsError(reason);
}

async function mapBounded<T, R>(
	items: T[],
	limit: number,
	operation: (item: T) => Promise<R>,
) {
	const output = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				output[index] = await operation(items[index] as T);
			}
		}),
	);
	return output;
}

type RecordingBucket = Awaited<ReturnType<typeof loadStorage>>["bucket"];

async function loadStorage(video: typeof videos.$inferSelect) {
	const [bucket, customBucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
		{ resolvePublishedOutput: false },
	).pipe(runPromise);
	return {
		bucket,
		cap: bucket.provider === "s3" && Option.isNone(customBucket),
	};
}

async function listTrack(
	bucket: RecordingBucket,
	source: Video.SegmentsSource,
	track: Track,
): Promise<TrackInventory> {
	const prefix = `${source.ownerId}/${source.videoId}/segments/${track}/`;
	const inventory: TrackInventory = { segments: [] };
	const seen = new Set<number>();
	let continuationToken: string | undefined;
	do {
		const page = await bucket
			.listObjects({ prefix, maxKeys: 1000, continuationToken })
			.pipe(runPromise);
		for (const object of page.Contents ?? []) {
			const key = object.Key ?? "";
			const name = key.slice(prefix.length);
			const size = object.Size ?? 0;
			if (name === "init.mp4") {
				inventory.initSize = size;
				continue;
			}
			const match = /^segment_(\d+)\.m4s$/.exec(name);
			if (!match) continue;
			const index = Number(match[1]);
			const expected =
				track === "video"
					? source.getVideoSegmentKey(index)
					: source.getAudioSegmentKey(index);
			if (key !== expected || seen.has(index))
				incomplete(`${track} segment ${name} does not match its expected name`);
			if (size <= 0) incomplete(`${track} segment ${index} is empty`);
			seen.add(index);
			inventory.segments.push({ index, size });
		}
		continuationToken = page.IsTruncated
			? page.NextContinuationToken
			: undefined;
	} while (continuationToken);
	inventory.segments.sort((left, right) => left.index - right.index);
	inventory.segments.forEach((segment, position) => {
		if (segment.index !== position + 1)
			incomplete(`${track} segment ${position + 1} is missing`);
	});
	return inventory;
}

function rangeReader(bucket: RecordingBucket, key: string) {
	let url: Promise<string | undefined> | undefined;
	return async (start: number, end: number) => {
		url ??= bucket
			.getInternalSignedObjectUrl(key, { expiresIn: 600 })
			.pipe(runPromise);
		const signedUrl = await url;
		if (!signedUrl) throw new Error("Segment URL could not be signed");
		const response = await fetch(signedUrl, {
			headers: { Range: `bytes=${start}-${end - 1}` },
		});
		if (response.status !== 206 && response.status !== 200)
			throw new Error(`Segment read failed with HTTP ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		// A server that ignores Range returns the whole object from byte 0.
		return response.status === 200 ? bytes.subarray(start, end) : bytes;
	};
}

async function trackDurations(
	bucket: RecordingBucket,
	source: Video.SegmentsSource,
	track: Track,
	inventory: TrackInventory,
) {
	const initKey =
		track === "video" ? source.getVideoInitKey() : source.getAudioInitKey();
	if (!inventory.initSize || inventory.initSize > MAX_INIT_BYTES)
		incomplete(`${track} init segment is missing or too large`);
	let timing: FragmentedTrackTiming;
	try {
		timing = readInitTiming(
			await rangeReader(bucket, initKey)(0, inventory.initSize),
		);
	} catch (error) {
		if (!(error instanceof FragmentedMp4Error)) throw error;
		incomplete(`${track} init segment is unreadable (${error.message})`);
	}
	return mapBounded(
		inventory.segments,
		DURATION_READ_CONCURRENCY,
		async (segment) => {
			const key =
				track === "video"
					? source.getVideoSegmentKey(segment.index)
					: source.getAudioSegmentKey(segment.index);
			let duration: number;
			try {
				duration = await readFragmentDuration(
					rangeReader(bucket, key),
					segment.size,
					timing,
				);
			} catch (error) {
				// Only the bytes themselves prove a segment is broken; a failed read is retried on the next run.
				if (!(error instanceof FragmentedMp4Error)) throw error;
				incomplete(
					`${track} segment ${segment.index} is unreadable (${error.message})`,
				);
			}
			if (!(duration > 0 && duration <= MAX_SEGMENT_SECONDS))
				incomplete(`${track} segment ${segment.index} lasts ${duration} s`);
			return { index: segment.index, duration: Number(duration.toFixed(6)) };
		},
	);
}

async function loadCandidate(videoId: Video.VideoId) {
	const [row] = await db()
		.select({
			video: videos,
			processingError: videoUploads.processingError,
			job: videoProcessingJobs,
		})
		.from(videos)
		.leftJoin(videoUploads, eq(videoUploads.videoId, videos.id))
		.leftJoin(videoProcessingJobs, eq(videoProcessingJobs.videoId, videos.id))
		.where(eq(videos.id, videoId))
		.limit(1);
	return row;
}

export async function inspectMissingManifestRecording(
	videoId: Video.VideoId,
): Promise<ManifestRebuildInspection> {
	const row = await loadCandidate(videoId);
	if (!row) return { status: "not-found" };
	const { video, processingError, job } = row;
	if (video.source.type !== "desktopSegments")
		return { status: "not-eligible", reason: `source is ${video.source.type}` };
	if (!processingError?.startsWith(MISSING_MANIFEST_ERROR_PREFIX))
		return {
			status: "not-eligible",
			reason: "the upload is not waiting on a missing manifest",
		};
	if (
		job &&
		(job.state !== "source-blocked" ||
			job.errorCode !== DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED ||
			job.source !== null ||
			job.verification !== null)
	)
		return {
			status: "not-eligible",
			reason: `processing job is ${job.state}${job.errorCode ? ` (${job.errorCode})` : ""}`,
		};
	const { bucket, cap } = await loadStorage(video);
	if (!cap) return { status: "unsupported-storage" };
	const source = new Video.SegmentsSource({ videoId, ownerId: video.ownerId });
	const existing = Option.getOrUndefined(
		await bucket.getObject(source.getManifestKey()).pipe(runPromise),
	);

	try {
		const [videoTrack, audioTrack] = await Promise.all([
			listTrack(bucket, source, "video"),
			listTrack(bucket, source, "audio"),
		]);
		if (videoTrack.segments.length === 0)
			incomplete("no video segments were uploaded");
		const hasAudio = audioTrack.segments.length > 0;
		if (!hasAudio && audioTrack.initSize !== undefined)
			incomplete("audio init was uploaded without any audio segments");
		const [videoSegments, audioSegments] = await Promise.all([
			trackDurations(bucket, source, "video", videoTrack),
			hasAudio
				? trackDurations(bucket, source, "audio", audioTrack)
				: Promise.resolve([]),
		]);
		const total = (entries: { duration: number }[]) =>
			entries.reduce((sum, entry) => sum + entry.duration, 0);
		const videoSeconds = total(videoSegments);
		if (hasAudio) {
			const gap = Math.abs(videoSeconds - total(audioSegments));
			if (
				gap >
				Math.max(
					MAX_TRACK_DURATION_GAP_SECONDS,
					videoSeconds * MAX_TRACK_DURATION_GAP_RATIO,
				)
			)
				incomplete(
					`audio covers ${total(audioSegments).toFixed(1)} s of ${videoSeconds.toFixed(1)} s of video`,
				);
		}
		const manifest = `${JSON.stringify(
			{
				version: 2,
				video_init_uploaded: true,
				audio_init_uploaded: hasAudio,
				video_segments: videoSegments,
				audio_segments: audioSegments,
				is_complete: true,
			},
			null,
			2,
		)}\n`;
		readCompletedRecordingManifest(manifest);
		// The rebuild is deterministic, so an identical manifest is one an earlier run wrote before it could queue.
		if (existing !== undefined && existing !== manifest)
			return { status: "manifest-exists" };
		return {
			status: "ready",
			videoId,
			ownerId: video.ownerId as User.UserId,
			manifest,
			videoSegments: videoSegments.length,
			audioSegments: audioSegments.length,
			durationSeconds: Number(videoSeconds.toFixed(3)),
		};
	} catch (error) {
		if (!(error instanceof IncompleteSegmentsError)) throw error;
		return existing === undefined
			? { status: "incomplete", reason: error.message }
			: { status: "manifest-exists" };
	}
}

export async function rebuildMissingManifest(
	videoId: Video.VideoId,
	{ dryRun }: { dryRun: boolean },
): Promise<ManifestRebuildResult> {
	const inspected = await inspectMissingManifestRecording(videoId);
	if (inspected.status === "incomplete" && !dryRun) {
		await db()
			.update(videoUploads)
			.set({
				processingError: `${INCOMPLETE_REBUILD_ERROR_PREFIX}: ${inspected.reason}. Uploaded files are retained.`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					like(
						videoUploads.processingError,
						`${MISSING_MANIFEST_ERROR_PREFIX}%`,
					),
				),
			);
	}
	if (inspected.status !== "ready") return inspected;
	const summary = {
		videoSegments: inspected.videoSegments,
		audioSegments: inspected.audioSegments,
		durationSeconds: inspected.durationSeconds,
	};
	if (dryRun) return { status: "checked", ...summary };

	const row = await loadCandidate(videoId);
	if (!row) return { status: "not-found" };
	const { bucket } = await loadStorage(row.video);
	const source = new Video.SegmentsSource({
		videoId,
		ownerId: inspected.ownerId,
	});
	// The desktop client that owned this upload stopped months ago, so the only writer to race is another operator run.
	const current = Option.getOrUndefined(
		await bucket.getObject(source.getManifestKey()).pipe(runPromise),
	);
	if (current !== undefined && current !== inspected.manifest)
		return { status: "manifest-exists" };
	if (current === undefined)
		await bucket
			.putObject(source.getManifestKey(), inspected.manifest, {
				contentType: "application/json",
			})
			.pipe(runPromise);

	let status: "queued" | "already-processing";
	try {
		status = await queueDesktopSegmentsFinalization({
			videoId,
			userId: inspected.ownerId,
		});
	} catch (error) {
		if (error instanceof DesktopRecordingSourceBlockedError)
			return { status: "blocked", reason: error.message };
		if (!(error instanceof SourceCommitPendingError)) throw error;
		status = "queued";
	}
	// A reset job keeps its old upload row; only clear it while it still shows the missing-manifest reason.
	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Securing recording source...",
			processingError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				like(videoUploads.processingError, `${MISSING_MANIFEST_ERROR_PREFIX}%`),
			),
		);
	return { status, ...summary };
}

export async function listMissingManifestCandidates(limit: number) {
	const rows = await db()
		.select({ videoId: videoUploads.videoId })
		.from(videoUploads)
		.innerJoin(videos, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				like(videoUploads.processingError, `${MISSING_MANIFEST_ERROR_PREFIX}%`),
				isNull(videos.bucket),
				isNull(videos.storageIntegrationId),
			),
		)
		.orderBy(asc(videos.createdAt))
		.limit(limit);
	return rows.map((row: { videoId: string }) => row.videoId);
}
