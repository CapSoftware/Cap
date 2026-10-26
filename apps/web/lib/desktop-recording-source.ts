import { createHash, randomUUID } from "node:crypto";
import type { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { getPublishedRecordingOutputKey } from "@cap/web-backend/src/Storage/recording-output";
import { Video } from "@cap/web-domain";
import { Effect, Option, Runtime } from "effect";
import { z } from "zod";
import {
	type DesktopRecordingSourceCheckpoint,
	desktopRecordingSourceCheckpointSchema,
	SOURCE_COMMIT_AWS_PAGE_SIZE,
	SOURCE_COMMIT_GOOGLE_DRIVE_PAGE_SIZE,
	SOURCE_COMMIT_MAX_OBJECTS,
	SOURCE_COMMIT_MAX_TREE_PAGE_ENTRIES,
	SOURCE_COMMIT_PAGE_SIZE,
	SOURCE_COMMIT_PART_BATCH_SIZE,
	SOURCE_COMMIT_PART_PAGE_SIZE,
	SOURCE_COMMIT_TREE_PAGE_SIZE,
	type SourceCommitPageReference,
	type SourceCommitReference,
	sourceCommitPageReferenceSchema,
	sourceCommitPartSchema,
} from "@/lib/desktop-recording-source-checkpoint";
import {
	type RecordingVerification,
	readCompletedRecordingManifest,
	recordingObjectIdentitySchema,
	recordingVerificationSchema,
} from "@/lib/desktop-recording-verification";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const sourceObjectSchema = z.object({
	key: z.string().min(1),
	originalKey: z.string().min(1),
	originalIdentity: recordingObjectIdentitySchema,
	objectIdentity: recordingObjectIdentitySchema,
	size: z.number().int().positive().safe(),
	track: z.enum(["video", "audio", "mp4"]),
	index: z.number().int().nonnegative(),
});

export const desktopRecordingSourceSchema = z.object({
	version: z.literal(1),
	kind: z.enum(["segments", "mp4"]),
	manifestSha256: sha256Schema.optional(),
	inventorySha256: sha256Schema,
	inventoryKey: z.string().min(1),
	requiredAudio: z.boolean(),
	mp4: z
		.object({
			fileSize: z.number().int().positive().safe(),
			duration: z.number().finite().positive().optional(),
			objectIdentity: z.string().min(1),
		})
		.optional(),
});

export type DesktopRecordingSource = z.infer<
	typeof desktopRecordingSourceSchema
>;
type SourceObject = z.infer<typeof sourceObjectSchema>;
type DbVideo = typeof videos.$inferSelect;
type RecordingStorageAccess = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>;
type RecordingStorage = RecordingStorageAccess[0];

const sourceInventorySchema = z.object({
	version: z.literal(1),
	kind: z.enum(["segments", "mp4"]),
	manifestSha256: sha256Schema.optional(),
	objects: z.array(sourceObjectSchema).min(1).max(100_002),
});

export class DesktopRecordingSourceError extends Error {
	constructor(
		readonly code:
			| "source-incomplete"
			| "source-changed"
			| "source-missing"
			| "source-invalid",
		message: string,
	) {
		super(message);
		this.name = "DesktopRecordingSourceError";
	}
}

class SourceCopyExpiredError extends Error {}

function hash(content: string) {
	return createHash("sha256").update(content).digest("hex");
}

function sourceStorageError(error: unknown): unknown {
	if (error instanceof DesktopRecordingSourceError) return error;
	const pending = [error];
	const visited = new Set<unknown>();
	for (let index = 0; index < pending.length && index < 16; index++) {
		const value = pending[index];
		if (typeof value !== "object" || value === null || visited.has(value))
			continue;
		visited.add(value);
		if (Runtime.isFiberFailure(value))
			pending.push(value[Runtime.FiberFailureCauseId]);
		const record = value as Record<string, unknown>;
		if (record.name === "NoSuchUpload") {
			return new SourceCopyExpiredError(
				"Recording source multipart copy expired",
			);
		}
		const metadata = record.$metadata;
		const status =
			record.name === "GoogleDriveRequestError"
				? record.status
				: typeof metadata === "object" &&
						metadata !== null &&
						"httpStatusCode" in metadata
					? metadata.httpStatusCode
					: undefined;
		if (status === 412 || record.name === "PreconditionFailed") {
			return new DesktopRecordingSourceError(
				"source-changed",
				"Recording source changed while its durable copy was being secured",
			);
		}
		if (
			status === 404 ||
			record.name === "NoSuchKey" ||
			record.name === "NotFound"
		) {
			return new DesktopRecordingSourceError(
				"source-missing",
				"Recording source is missing or has not finished uploading; existing files are retained",
			);
		}
		pending.push(record.cause, record.error);
	}
	return error;
}

function sourcePrefix(video: DbVideo) {
	return `${video.ownerId}/${video.id}/.recording/sources/`;
}

function assertSourceKey(video: DbVideo, key: string) {
	if (
		!key.startsWith(sourcePrefix(video)) ||
		key.includes("..") ||
		!/^[a-zA-Z0-9_./-]+$/.test(key)
	) {
		throw new DesktopRecordingSourceError(
			"source-invalid",
			"Recording source snapshot belongs to a different recording",
		);
	}
}

export function getDesktopRecordingOutputKey(
	ownerId: string,
	videoId: string,
	generation: string,
	attemptId: string,
) {
	identifierSchema.parse(ownerId);
	identifierSchema.parse(videoId);
	identifierSchema.parse(generation);
	identifierSchema.parse(attemptId);
	return `${ownerId}/${videoId}/.recording/outputs/${generation}/${attemptId}.mp4`;
}

async function readRequiredObject(bucket: RecordingStorage, key: string) {
	const content = await runWorkflowPromise(bucket.getObject(key)).catch(
		(error: unknown) => {
			throw sourceStorageError(error);
		},
	);
	if (Option.isNone(content)) {
		throw new DesktopRecordingSourceError(
			"source-missing",
			"The recording source manifest has not finished uploading",
		);
	}
	return content.value;
}

const originalObjectSchema = sourceObjectSchema.omit({
	key: true,
	objectIdentity: true,
});
type OriginalObject = z.infer<typeof originalObjectSchema>;
type WorkflowContext = Effect.Effect.Context<
	Parameters<typeof runWorkflowPromise>[0]
>;
type SourceRun = <A, E>(
	operation: Effect.Effect<A, E, WorkflowContext>,
) => Promise<A>;
type SourceContext = {
	video: DbVideo;
	bucket: RecordingStorage;
	prefix: string;
	run: SourceRun;
	concurrency: number;
	pageSize: number;
	// Only a commit in progress may reuse pages it verified; committed sources must prove their pages still exist.
	reuseVerifiedPages?: boolean;
	// Cap's own bucket lists sizes and ETags, so a commit can check every fragment with a few listings.
	listed?: boolean;
};
type TreeKind = "plan" | "objects" | "parts";

const sourcePlanSchema = z.object({
	version: z.literal(1),
	kind: z.enum(["segments", "mp4"]),
	manifestSha256: sha256Schema.optional(),
	manifestKey: z.string().optional(),
	originalManifestKey: z.string().optional(),
	requiredAudio: z.boolean(),
	videoCount: z.number().int().nonnegative(),
	audioCount: z.number().int().nonnegative(),
	objectCount: z.number().int().positive().max(SOURCE_COMMIT_MAX_OBJECTS),
	sourcePreparation: z.boolean().optional(),
	mp4: z
		.object({
			originalKey: z.string(),
			duration: z.number().positive().finite().optional(),
		})
		.optional(),
});
type SourcePlan = z.infer<typeof sourcePlanSchema>;

const treePageSchema = z.discriminatedUnion("type", [
	z.object({
		version: z.literal(1),
		type: z.literal("leaf"),
		kind: z.enum(["plan", "objects", "parts"]),
		scope: z.string(),
		start: z.number().int().nonnegative(),
		entries: z
			.array(z.unknown())
			.min(1)
			.max(SOURCE_COMMIT_MAX_TREE_PAGE_ENTRIES),
	}),
	z.object({
		version: z.literal(1),
		type: z.literal("branch"),
		kind: z.enum(["plan", "objects", "parts"]),
		scope: z.string(),
		children: z.tuple([
			sourceCommitPageReferenceSchema,
			sourceCommitPageReferenceSchema,
		]),
	}),
]);
const pagedInventorySchema = z.object({
	version: z.literal(2),
	kind: z.literal("segments"),
	manifestSha256: sha256Schema,
	objectCount: z.number().int().positive().max(SOURCE_COMMIT_MAX_OBJECTS),
	scope: sha256Schema,
	roots: z.array(sourceCommitPageReferenceSchema).min(1).max(18),
});
const committedInventorySchema = z.union([
	sourceInventorySchema,
	pagedInventorySchema,
]);
const SOURCE_COMMIT_STEP_TIMEOUT_MS = 180_000;
const SOURCE_COMMIT_IO_TIMEOUT_MS = 60_000;
const SOURCE_COMMIT_CONCURRENCY = 8;
const SOURCE_COMMIT_AWS_CONCURRENCY = 256;
// About 100 Drive requests a second, half of Drive's 12,000-a-minute per-user quota; driveFetch backs off on rate limits.
const SOURCE_COMMIT_GOOGLE_DRIVE_CONCURRENCY = 32;

function sourceLimits([bucket, customBucket]: RecordingStorageAccess) {
	if (bucket.provider === "s3" && Option.isNone(customBucket))
		return {
			concurrency: SOURCE_COMMIT_AWS_CONCURRENCY,
			pageSize: SOURCE_COMMIT_AWS_PAGE_SIZE,
			listed: true,
		};
	if (bucket.provider === "googleDrive")
		return {
			concurrency: SOURCE_COMMIT_GOOGLE_DRIVE_CONCURRENCY,
			pageSize: SOURCE_COMMIT_GOOGLE_DRIVE_PAGE_SIZE,
		};
	return {
		concurrency: SOURCE_COMMIT_CONCURRENCY,
		pageSize: SOURCE_COMMIT_PAGE_SIZE,
	};
}

function invalidSource(message: string): never {
	throw new DesktopRecordingSourceError("source-invalid", message);
}

function parseSourceJson(content: string): unknown {
	try {
		return JSON.parse(content) as unknown;
	} catch {
		return invalidSource("Recording source metadata is not valid JSON");
	}
}

async function mapBounded<T, R>(
	items: T[],
	operation: (item: T) => Promise<R>,
	concurrency = SOURCE_COMMIT_CONCURRENCY,
) {
	const output = new Array<R>(items.length);
	const entries = items.entries();
	let failure: unknown;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (failure === undefined) {
				const next = entries.next();
				if (next.done) return;
				const [index, item] = next.value;
				try {
					output[index] = await operation(item);
				} catch (error) {
					failure = error;
				}
			}
		}),
	);
	if (failure !== undefined) throw failure;
	return output;
}

function assertContextKey(context: SourceContext, key: string) {
	assertSourceKey(context.video, key);
	if (!key.startsWith(`${context.prefix}/`))
		invalidSource("Recording checkpoint points outside its snapshot");
}

async function readSourceText(context: SourceContext, key: string) {
	const result = await context.run(context.bucket.getObject(key));
	if (Option.isNone(result))
		throw new DesktopRecordingSourceError(
			"source-missing",
			"A required recording source object is missing",
		);
	return result.value;
}

// Checkpoint pages are addressed by their SHA-256, so a page this process already wrote and read back, or
// read and verified, can be served from memory: storage could only return these same bytes or fail the hash.
const VERIFIED_PAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const verifiedPages = new Map<string, string>();
let verifiedPageBytes = 0;

function rememberVerifiedPage(key: string, sha256: string, content: string) {
	const id = `${key}\n${sha256}`;
	if (verifiedPages.has(id) || content.length > VERIFIED_PAGE_CACHE_MAX_BYTES)
		return;
	verifiedPages.set(id, content);
	verifiedPageBytes += content.length;
	for (const [oldest, value] of verifiedPages) {
		if (verifiedPageBytes <= VERIFIED_PAGE_CACHE_MAX_BYTES) break;
		verifiedPages.delete(oldest);
		verifiedPageBytes -= value.length;
	}
}

async function readReference(
	context: SourceContext,
	reference: SourceCommitReference,
) {
	assertContextKey(context, reference.key);
	const cached = context.reuseVerifiedPages
		? verifiedPages.get(`${reference.key}\n${reference.sha256}`)
		: undefined;
	if (cached !== undefined) return parseSourceJson(cached);
	const content = await readSourceText(context, reference.key);
	if (hash(content) !== reference.sha256)
		throw new DesktopRecordingSourceError(
			"source-changed",
			"A recording source checkpoint changed after it was saved",
		);
	rememberVerifiedPage(reference.key, reference.sha256, content);
	return parseSourceJson(content);
}

async function writeSourceText(
	context: SourceContext,
	key: string,
	content: string,
) {
	assertContextKey(context, key);
	const bucket = context.bucket;
	// Cap's bucket answers a single-part PUT with the MD5 of the bytes it stored, which proves the write as a
	// readback does; any other answer still reads the object back.
	if (context.listed && "putObjectWithETag" in bucket) {
		const stored = await context.run(
			bucket.putObjectWithETag(key, content, {
				contentType: "application/json",
			}),
		);
		if (
			stored.ETag !== `"${createHash("md5").update(content).digest("hex")}"` &&
			(await readSourceText(context, key)) !== content
		)
			throw new Error("Durable recording source readback did not match");
	} else {
		await context.run(
			bucket.putObject(key, content, { contentType: "application/json" }),
		);
		if ((await readSourceText(context, key)) !== content)
			throw new Error("Durable recording source readback did not match");
	}
	const sha256 = hash(content);
	rememberVerifiedPage(key, sha256, content);
	return { key, sha256 };
}

async function writeReference(context: SourceContext, value: unknown) {
	const key = `${context.prefix}/pages/${randomUUID()}.json`;
	const content = JSON.stringify(value);
	const bucket = context.bucket;
	// Pages get a fresh random key, so no other writer can replace them; a SHA-256 Drive computed from the
	// stored bytes proves the write as well as reading it back, which costs another Drive round trip.
	if (bucket.provider === "googleDrive" && "putObjectWithChecksum" in bucket) {
		assertContextKey(context, key);
		const sha256 = hash(content);
		const stored = await context.run(
			bucket.putObjectWithChecksum(key, content, {
				contentType: "application/json",
			}),
		);
		if (stored.sha256Checksum !== sha256) {
			if (stored.sha256Checksum !== null)
				throw new Error("Durable recording source readback did not match");
			if ((await readSourceText(context, key)) !== content)
				throw new Error("Durable recording source readback did not match");
		}
		rememberVerifiedPage(key, sha256, content);
		return { key, sha256 };
	}
	return writeSourceText(context, key, content);
}

function treeCount(roots: SourceCommitPageReference[]) {
	let next = 0;
	let previousLevel = 18;
	for (const root of roots) {
		if (root.start !== next || root.level >= previousLevel)
			invalidSource(
				"Recording source pages have an incomplete or overlapping inventory",
			);
		next += root.count;
		previousLevel = root.level;
	}
	return next;
}

async function appendTree(
	context: SourceContext,
	roots: SourceCommitPageReference[],
	kind: TreeKind,
	scope: string,
	entries: unknown[],
) {
	if (entries.length === 0 || entries.length > SOURCE_COMMIT_TREE_PAGE_SIZE)
		invalidSource("Invalid source page size");
	const start = treeCount(roots);
	const leaf = await writeReference(context, {
		version: 1,
		type: "leaf",
		kind,
		scope,
		start,
		entries,
	});
	let next: SourceCommitPageReference = {
		...leaf,
		start,
		count: entries.length,
		level: 0,
	};
	const result = [...roots];
	while (result.at(-1)?.level === next.level) {
		const previous = result.pop();
		if (!previous || previous.start + previous.count !== next.start)
			invalidSource("Recording source page order changed");
		const branch = await writeReference(context, {
			version: 1,
			type: "branch",
			kind,
			scope,
			children: [previous, next],
		});
		next = {
			...branch,
			start: previous.start,
			count: previous.count + next.count,
			level: next.level + 1,
		};
	}
	result.push(next);
	return result;
}

async function readTree<T>(
	context: SourceContext,
	roots: SourceCommitPageReference[],
	kind: TreeKind,
	scope: string,
	schema: z.ZodType<T>,
	start = 0,
	end = treeCount(roots),
): Promise<T[]> {
	const count = treeCount(roots);
	if (start < 0 || end > count || end < start)
		invalidSource("Recording source page range is invalid");
	const overlaps = (ref: SourceCommitPageReference) =>
		ref.start < end && ref.start + ref.count > start;
	let pending = roots.filter(overlaps);
	const leaves: { start: number; entries: T[] }[] = [];
	while (pending.length > 0) {
		const pages = await mapBounded(
			pending,
			async (reference) => {
				const parsed = treePageSchema.safeParse(
					await readReference(context, reference),
				);
				if (!parsed.success) invalidSource("Recording source page is invalid");
				const page = parsed.data;
				if (page.kind !== kind || page.scope !== scope)
					invalidSource(
						"Recording source page belongs to a different snapshot",
					);
				if (page.type === "leaf") {
					if (
						reference.level !== 0 ||
						page.start !== reference.start ||
						page.entries.length !== reference.count
					)
						invalidSource(
							"Recording source leaf does not match its committed range",
						);
					return {
						children: [],
						leaf: {
							start: page.start,
							entries: page.entries.map((entry) => {
								const parsed = schema.safeParse(entry);
								if (!parsed.success)
									invalidSource(
										"Recording source page contains an invalid receipt",
									);
								return parsed.data;
							}),
						},
					};
				}
				const [left, right] = page.children;
				if (
					left.start !== reference.start ||
					left.start + left.count !== right.start ||
					left.count + right.count !== reference.count ||
					left.level + 1 !== reference.level ||
					right.level !== left.level
				)
					invalidSource(
						"Recording source branch does not match its committed range",
					);
				return { children: page.children.filter(overlaps), leaf: null };
			},
			context.concurrency,
		);
		pending = [];
		for (const page of pages) {
			pending.push(...page.children);
			if (page.leaf) leaves.push(page.leaf);
		}
	}
	leaves.sort((left, right) => left.start - right.start);
	const result = leaves.flatMap((leaf) =>
		leaf.entries.slice(
			Math.max(0, start - leaf.start),
			Math.min(leaf.entries.length, end - leaf.start),
		),
	);
	if (result.length !== end - start)
		invalidSource("Recording source page inventory is incomplete");
	return result;
}

async function createSourcePlan(
	context: SourceContext,
	verification?: RecordingVerification,
): Promise<SourceCommitReference> {
	const segmented =
		context.video.source.type === "desktopSegments" ||
		verification?.artifact.kind === "segments";
	const directory = `${context.prefix}/plans/${randomUUID()}`;
	let plan: SourcePlan;
	if (segmented) {
		const segments = new Video.SegmentsSource({
			videoId: context.video.id,
			ownerId: context.video.ownerId,
		});
		const originalManifestKey = segments.getManifestKey();
		const content = await readSourceText(context, originalManifestKey);
		let manifest: ReturnType<typeof readCompletedRecordingManifest>;
		try {
			manifest = readCompletedRecordingManifest(content);
		} catch {
			throw new DesktopRecordingSourceError(
				"source-incomplete",
				"The recording manifest is incomplete or invalid; the original is retained",
			);
		}
		if (
			verification?.artifact.kind === "mp4" ||
			(verification?.artifact.kind === "segments" &&
				verification.artifact.manifestSha256 !== manifest.manifestSha256) ||
			(verification?.requiredAudio && !manifest.hasAudio)
		) {
			throw new DesktopRecordingSourceError(
				"source-changed",
				"The completed source does not match the recording verification request",
			);
		}
		const videoCount = manifest.videoSegments.length + 1;
		const audioCount = manifest.hasAudio
			? manifest.audioSegments.length + 1
			: 0;
		if (videoCount + audioCount > SOURCE_COMMIT_MAX_OBJECTS)
			invalidSource(
				"The recording source inventory exceeds the supported object count",
			);
		const manifestKey = `${directory}/manifest.json`;
		// The plan is only referenced once both files are durable, so the manifest copy can be written
		// alongside the plan; a failure leaves both unreferenced in this plan's own directory.
		const [, planReference] = await Promise.all([
			writeSourceText(context, manifestKey, content),
			context
				.run(
					context.bucket
						.getObject(preparationMarkerKey(context.video))
						.pipe(Effect.timeout("2 seconds")),
				)
				.then(
					(marker) =>
						Option.isSome(marker) &&
						z
							.object({ version: z.literal(1) })
							.safeParse(JSON.parse(marker.value)).success,
				)
				.catch(() => false)
				.then((sourcePreparation) =>
					writeSourceText(
						context,
						`${directory}/plan.json`,
						JSON.stringify({
							version: 1,
							kind: "segments",
							manifestSha256: manifest.manifestSha256,
							manifestKey,
							originalManifestKey,
							requiredAudio: manifest.hasAudio,
							videoCount,
							audioCount,
							objectCount: videoCount + audioCount,
							sourcePreparation,
						} satisfies SourcePlan),
					),
				),
		]);
		return planReference;
	} else {
		const video = context.video;
		const publishedKey = getPublishedRecordingOutputKey(video);
		if (
			video.source.type === "desktopMP4" &&
			video.source.outputKey &&
			!publishedKey
		)
			invalidSource(
				"Published recording source belongs to a different recording",
			);
		const artifact = verification?.artifact;
		plan = {
			version: 1,
			kind: "mp4",
			requiredAudio: verification?.requiredAudio ?? false,
			videoCount: 0,
			audioCount: 0,
			objectCount: 1,
			mp4: {
				originalKey:
					artifact?.kind === "mp4"
						? `${video.ownerId}/${video.id}/result.mp4`
						: (publishedKey ?? `${video.ownerId}/${video.id}/result.mp4`),
				...(artifact?.kind === "mp4" ? { duration: artifact.duration } : {}),
			},
		};
	}
	return writeSourceText(
		context,
		`${directory}/plan.json`,
		JSON.stringify(plan),
	);
}

function originalAt(video: DbVideo, plan: SourcePlan, position: number) {
	if (position < 0 || position >= plan.objectCount)
		invalidSource("Recording source position is invalid");
	if (plan.kind === "mp4") {
		if (!plan.mp4 || plan.objectCount !== 1)
			invalidSource("Recording MP4 plan is incomplete");
		return {
			originalKey: plan.mp4.originalKey,
			track: "mp4" as const,
			index: 0,
		};
	}
	const segments = new Video.SegmentsSource({
		videoId: video.id,
		ownerId: video.ownerId,
	});
	const track =
		position < plan.videoCount ? ("video" as const) : ("audio" as const);
	const index = track === "video" ? position : position - plan.videoCount;
	const originalKey =
		track === "video"
			? index === 0
				? segments.getVideoInitKey()
				: segments.getVideoSegmentKey(index)
			: index === 0
				? segments.getAudioInitKey()
				: segments.getAudioSegmentKey(index);
	return { originalKey, track, index };
}

async function captureOriginal(
	context: SourceContext,
	original: ReturnType<typeof originalAt>,
	verification?: RecordingVerification,
): Promise<OriginalObject> {
	const head = await context.run(
		context.bucket.headObject(original.originalKey),
	);
	const expectedIdentity =
		original.track === "mp4" && verification?.artifact.kind === "mp4"
			? verification.artifact.objectIdentity
			: undefined;
	const identity = getRecordingObjectIdentity(head, expectedIdentity);
	if (!identity && "RecordingContentETag" in head) {
		throw new Error("Recording content identity is unavailable");
	}
	if (
		!identity ||
		!recordingObjectIdentitySchema.safeParse(identity).success ||
		!head.ContentLength ||
		!Number.isSafeInteger(head.ContentLength) ||
		head.ContentLength < 0
	) {
		throw new DesktopRecordingSourceError(
			"source-missing",
			`Recording ${original.track} fragment ${original.index} is missing or incomplete`,
		);
	}
	if (
		original.track === "mp4" &&
		verification?.artifact.kind === "mp4" &&
		(verification.artifact.fileSize !== head.ContentLength ||
			verification.artifact.objectIdentity !== identity)
	) {
		throw new DesktopRecordingSourceError(
			"source-changed",
			"Uploaded recording does not match its original object identity",
		);
	}
	return { ...original, originalIdentity: identity, size: head.ContentLength };
}

function copyMetadata(original: OriginalObject) {
	return {
		"cap-source-identity": hash(original.originalIdentity),
		"cap-source-size": String(original.size),
		"cap-source-key": hash(original.originalKey),
	};
}

async function checkOriginal(context: SourceContext, original: OriginalObject) {
	const head = await context.run(
		context.bucket.headObject(original.originalKey),
	);
	const identity = getRecordingObjectIdentity(head, original.originalIdentity);
	if (!identity && "RecordingContentETag" in head) {
		throw new Error("Recording content identity is unavailable");
	}
	if (
		identity !== original.originalIdentity ||
		head.ContentLength !== original.size
	)
		throw new DesktopRecordingSourceError(
			"source-changed",
			"Recording source changed while its durable snapshot was being saved",
		);
	return head;
}

async function checkCopy(
	context: SourceContext,
	original: OriginalObject,
	key: string,
	expectedIdentity?: string,
): Promise<SourceObject> {
	assertCopyKey(context, original, key);
	const [head, originalHead] = await Promise.all([
		context.run(context.bucket.headObject(key)),
		checkOriginal(context, original),
	]);
	const identity = getRecordingObjectIdentity(head, expectedIdentity);
	if (!identity && "RecordingContentETag" in head) {
		throw new Error("Recording content identity is unavailable");
	}
	if (context.bucket.provider === "googleDrive") {
		if (
			!("RecordingContentSHA256" in head) ||
			!("RecordingContentSHA256" in originalHead) ||
			!head.RecordingContentSHA256 ||
			!originalHead.RecordingContentSHA256
		) {
			throw new Error("Recording content checksum is unavailable");
		}
		if (head.RecordingContentSHA256 !== originalHead.RecordingContentSHA256) {
			throw new DesktopRecordingSourceError(
				"source-changed",
				"Recording snapshot content does not match its original source",
			);
		}
	}
	if (
		!identity ||
		!recordingObjectIdentitySchema.safeParse(identity).success ||
		head.ContentLength !== original.size ||
		(expectedIdentity !== undefined && identity !== expectedIdentity)
	) {
		throw new DesktopRecordingSourceError(
			"source-changed",
			"Recording snapshot does not match its durable copy receipt",
		);
	}
	if (
		context.bucket.provider === "s3" &&
		Object.entries(copyMetadata(original)).some(
			([name, value]) => head.Metadata?.[name] !== value,
		)
	) {
		throw new DesktopRecordingSourceError(
			"source-changed",
			"Recording snapshot is missing its original source identity",
		);
	}
	return { ...original, key, objectIdentity: identity };
}

function objectDirectory(key: string) {
	return key.slice(0, key.lastIndexOf("/", key.lastIndexOf("/") - 1));
}

async function saveObjectReceipt(context: SourceContext, object: SourceObject) {
	const key = `${objectDirectory(object.key)}/receipt.json`;
	const content = JSON.stringify(object);
	// A receipt only lets a retry find this copy, and a retry re-checks the receipt and the copy
	// before reusing it, so a receipt skips the readback that inventory pages need.
	assertContextKey(context, key);
	await context.run(
		context.bucket.putObject(key, content, { contentType: "application/json" }),
	);
	return object;
}

async function reusableCopy(
	context: SourceContext,
	original: OriginalObject,
	position: number,
	checkFirst = true,
) {
	if (checkFirst) await checkOriginal(context, original);
	let continuationToken: string | undefined;
	for (let page = 0; page < 4; page++) {
		const listing = await context.run(
			context.bucket.listObjects({
				prefix: `${context.prefix}/copies/${position}/`,
				maxKeys: 32,
				continuationToken,
			}),
		);
		for (const candidate of listing.Contents ?? []) {
			const key = candidate.Key;
			if (!key || !/\.(mp4|m4s)$/.test(key)) continue;
			assertContextKey(context, key);
			const receiptKey = `${objectDirectory(key)}/receipt.json`;
			const content = await context.run(context.bucket.getObject(receiptKey));
			if (Option.isSome(content)) {
				const receipt = sourceObjectSchema.safeParse(JSON.parse(content.value));
				if (
					receipt.success &&
					receipt.data.key === key &&
					receipt.data.originalKey === original.originalKey &&
					receipt.data.originalIdentity === original.originalIdentity &&
					receipt.data.size === original.size &&
					receipt.data.track === original.track &&
					receipt.data.index === original.index
				) {
					return checkCopy(context, original, key, receipt.data.objectIdentity);
				}
			} else if (context.bucket.provider === "googleDrive") {
				return saveObjectReceipt(
					context,
					await checkCopy(context, original, key),
				);
			} else if (context.bucket.provider === "s3") {
				const head = await context.run(context.bucket.headObject(key));
				if (
					head.ContentLength === original.size &&
					Object.entries(copyMetadata(original)).every(
						([name, value]) => head.Metadata?.[name] === value,
					)
				) {
					return saveObjectReceipt(
						context,
						await checkCopy(context, original, key),
					);
				}
			}
		}
		if (!listing.IsTruncated || !listing.NextContinuationToken) return null;
		continuationToken = listing.NextContinuationToken;
	}
	return null;
}

function newCopyKey(
	context: SourceContext,
	original: OriginalObject,
	position: number,
) {
	return `${context.prefix}/copies/${position}/${randomUUID()}/${original.track}/${original.index}${original.index === 0 ? ".mp4" : ".m4s"}`;
}

async function copySmallObject(
	context: SourceContext,
	original: OriginalObject,
	position: number,
	prepared = false,
) {
	// Every reuse and every new copy ends in checkCopy, which re-checks the original, so the
	// original is checked up front only when a copy fails and its error needs classifying.
	if (prepared && original.index > 0) {
		const existing = await reusableCopy(
			{ ...context, prefix: preparedSourcePrefix(context.video, original) },
			original,
			original.index,
			false,
		).catch(() => null);
		if (existing) return existing;
	}
	const existing = await reusableCopy(context, original, position, false);
	if (existing) return existing;
	const key = newCopyKey(context, original, position);
	try {
		await context.run(
			context.bucket.copyObject(
				`${context.bucket.bucketName}/${original.originalKey}`,
				key,
				{
					CopySourceIfMatch: original.originalIdentity,
					IfNoneMatch: "*",
					MetadataDirective: "REPLACE",
					Metadata: copyMetadata(original),
					ContentType: original.track === "audio" ? "audio/mp4" : "video/mp4",
				},
			),
		);
	} catch (error) {
		await checkOriginal(context, original);
		throw error;
	}
	return saveObjectReceipt(context, await checkCopy(context, original, key));
}

// A listing already showed there is no reusable copy, and S3 copies the exact original version or fails,
// so a copy whose response carries the original's ETag needs no HEAD or receipt; the listed verify
// phase still lists it, and a retry on the per-object path reuses it through its copy metadata.
async function copyListedObject(
	context: SourceContext,
	original: OriginalObject,
	position: number,
): Promise<SourceObject> {
	const key = newCopyKey(context, original, position);
	let copied: unknown;
	try {
		copied = await context.run(
			context.bucket.copyObject(
				`${context.bucket.bucketName}/${original.originalKey}`,
				key,
				{
					CopySourceIfMatch: original.originalIdentity,
					IfNoneMatch: "*",
					MetadataDirective: "REPLACE",
					Metadata: copyMetadata(original),
					ContentType: original.track === "audio" ? "audio/mp4" : "video/mp4",
				},
			),
		);
	} catch (error) {
		await checkOriginal(context, original);
		throw error;
	}
	const identity =
		copied &&
		typeof copied === "object" &&
		"CopyObjectResult" in copied &&
		copied.CopyObjectResult &&
		typeof copied.CopyObjectResult === "object" &&
		"ETag" in copied.CopyObjectResult
			? copied.CopyObjectResult.ETag
			: undefined;
	if (identity === original.originalIdentity)
		return { ...original, key, objectIdentity: identity };
	return saveObjectReceipt(context, await checkCopy(context, original, key));
}

function preparedSourcePrefix(video: DbVideo, original: OriginalObject) {
	return `${sourcePrefix(video)}prepared/${hash(
		JSON.stringify([
			original.originalKey,
			original.originalIdentity,
			original.size,
		]),
	)}`;
}

function preparationMarkerKey(video: DbVideo) {
	return `${sourcePrefix(video)}preparation.json`;
}

type ListedObject = { size: number; identity: string };
type SnapshotListing = {
	originals: Map<string, ListedObject>;
	copies: Map<string, ListedObject>;
	copyDirectories: Map<string, string[]>;
};

const LISTED_ADVANCE_BUDGET_MS = 20_000;
const LISTING_MAX_PAGES = 64;
const HEX_DIGITS = [..."0123456789abcdef"];

// Returns null when the listing is incomplete or lacks a size or ETag, so callers fall back to per-object checks.
async function listObjectsUnder(
	context: SourceContext,
	prefix: string,
): Promise<Map<string, ListedObject> | null> {
	const listed = new Map<string, ListedObject>();
	let continuationToken: string | undefined;
	for (let page = 0; page < LISTING_MAX_PAGES; page++) {
		const listing = await context.run(
			context.bucket.listObjects({ prefix, maxKeys: 1000, continuationToken }),
		);
		for (const entry of listing.Contents ?? []) {
			if (!entry.Key?.startsWith(prefix)) return null;
			const identity = "ETag" in entry ? entry.ETag : undefined;
			if (
				typeof entry.Size !== "number" ||
				!Number.isSafeInteger(entry.Size) ||
				typeof identity !== "string" ||
				!recordingObjectIdentitySchema.safeParse(identity).success
			)
				return null;
			listed.set(entry.Key, { size: entry.Size, identity });
		}
		if (!listing.IsTruncated) return listed;
		if (!listing.NextContinuationToken) return null;
		continuationToken = listing.NextContinuationToken;
	}
	return null;
}

async function listSnapshot(
	context: SourceContext,
	includeCopies: boolean,
): Promise<SnapshotListing | null> {
	const segments = `${context.video.ownerId}/${context.video.id}/segments/`;
	const prepared = `${sourcePrefix(context.video)}prepared/`;
	const listings = await Promise.all([
		listObjectsUnder(context, `${segments}video/`),
		listObjectsUnder(context, `${segments}audio/`),
		...(includeCopies
			? [
					listObjectsUnder(context, `${context.prefix}/copies/`),
					...HEX_DIGITS.map((digit) =>
						listObjectsUnder(context, `${prepared}${digit}`),
					),
				]
			: []),
	]);
	if (listings.some((listing) => listing === null)) return null;
	const [video, audio, ...copyListings] = listings as Map<
		string,
		ListedObject
	>[];
	const copies = new Map(copyListings.flatMap((listing) => [...listing]));
	const copyDirectories = new Map<string, string[]>();
	for (const key of copies.keys()) {
		const directory =
			/^(.+\/copies\/\d+\/)[^/]+\/(?:video|audio)\/\d+\.(?:mp4|m4s)$/.exec(
				key,
			)?.[1];
		if (!directory) continue;
		const keys = copyDirectories.get(directory);
		if (keys) keys.push(key);
		else copyDirectories.set(directory, [key]);
	}
	return {
		originals: new Map([...(video ?? []), ...(audio ?? [])]),
		copies,
		copyDirectories,
	};
}

function listedOriginalMatches(
	listing: SnapshotListing,
	original: OriginalObject,
) {
	const listed = listing.originals.get(original.originalKey);
	return (
		listed?.identity === original.originalIdentity &&
		listed.size === original.size
	);
}

// A copy holds the original's bytes when it has the original's size and S3 content ETag. "unlisted" means no
// copy exists to reuse; any other copy is left to the per-object checks, which compare its identity metadata.
function findListedCopy(
	context: SourceContext,
	listing: SnapshotListing,
	original: OriginalObject,
	position: number,
	prepared: boolean,
): SourceObject | "unlisted" | null {
	if (!listedOriginalMatches(listing, original)) return null;
	const directories = [
		...(prepared && original.index > 0
			? [
					`${preparedSourcePrefix(context.video, original)}/copies/${original.index}/`,
				]
			: []),
		`${context.prefix}/copies/${position}/`,
	];
	let candidates = 0;
	for (const directory of directories) {
		for (const key of listing.copyDirectories.get(directory) ?? []) {
			const copy = listing.copies.get(key);
			candidates++;
			if (
				!copy ||
				!key.endsWith(
					`/${original.track}/${original.index}${original.index === 0 ? ".mp4" : ".m4s"}`,
				) ||
				copy.size !== original.size ||
				copy.identity !== original.originalIdentity
			)
				continue;
			assertCopyKey(context, original, key);
			return { ...original, key, objectIdentity: copy.identity };
		}
	}
	return candidates === 0 ? "unlisted" : null;
}

export const recordingPreparationSegmentSchema = z.object({
	track: z.enum(["video", "audio"]),
	index: z.number().int().min(1).max(50_000),
});

export type RecordingPreparationSegment = z.infer<
	typeof recordingPreparationSegmentSchema
>;

export async function prepareDesktopRecordingSegments(
	video: DbVideo,
	segments: readonly RecordingPreparationSegment[],
	canContinue: () => Promise<boolean>,
): Promise<RecordingPreparationSegment[]> {
	identifierSchema.parse(video.ownerId);
	identifierSchema.parse(video.id);
	const requested = z
		.array(recordingPreparationSegmentSchema)
		.min(1)
		.max(32)
		.parse(segments);
	if (video.source?.type !== "desktopSegments") return [];
	const deadline = Date.now() + 15_000;
	const run: SourceRun = (operation) => {
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error("Recording preparation time budget ended");
		return runWorkflowPromise(
			operation.pipe(Effect.timeout(Math.min(5_000, remaining))),
		);
	};
	const [bucket, customBucket] = await run(
		Storage.getAccessForVideo(decodeStorageVideo(video), {
			resolvePublishedOutput: false,
		}),
	);
	const context = {
		video,
		bucket,
		run,
		prefix: sourcePrefix(video).slice(0, -1),
		concurrency: SOURCE_COMMIT_CONCURRENCY,
		pageSize: SOURCE_COMMIT_PAGE_SIZE,
	};
	const videoCopies: SourceObject[] = [];
	const unique = [
		...new Map(
			requested.map((entry) => [`${entry.track}/${entry.index}`, entry]),
		).values(),
	];
	const prepared: RecordingPreparationSegment[] = [];
	let markerSaved = false;
	for (
		let offset = 0;
		offset < unique.length && Date.now() < deadline;
		offset += 4
	) {
		if (!(await run(Effect.tryPromise(canContinue)))) break;
		const results = await Promise.all(
			unique.slice(offset, offset + 4).map(async (segment) => {
				try {
					const original = await captureOriginal(context, {
						originalKey: `${video.ownerId}/${video.id}/segments/${segment.track}/segment_${String(segment.index).padStart(3, "0")}.m4s`,
						...segment,
					});
					if (original.size > 64 * 1024 * 1024) return null;
					const copy = await copySmallObject(
						{ ...context, prefix: preparedSourcePrefix(video, original) },
						original,
						original.index,
					);
					if (segment.track === "video") videoCopies.push(copy);
					return segment;
				} catch {
					return null;
				}
			}),
		);
		for (const segment of results) {
			if (segment) prepared.push(segment);
		}
		if (!markerSaved && prepared.length > 0) {
			await writeSourceText(
				context,
				preparationMarkerKey(video),
				JSON.stringify({ version: 1 }),
			);
			markerSaved = true;
		}
	}
	if (
		bucket.provider === "s3" &&
		Option.isNone(customBucket) &&
		videoCopies.length > 0
	)
		await requestSegmentPreverification(context, videoCopies).catch(
			(error: unknown) => {
				console.warn(
					"[prepareDesktopRecordingSegments] Preverification skipped",
					{
						videoId: video.id,
						error: error instanceof Error ? error.message : String(error),
					},
				);
			},
		);
	return prepared;
}

function preverifiedRunPrefix(video: DbVideo) {
	return `${sourcePrefix(video)}preverified/`;
}

// Asks the media server to decode the video fragments just secured, so the final verification only decodes
// the tail. Each contiguous run becomes one signed result; nothing depends on the request succeeding.
async function requestSegmentPreverification(
	context: SourceContext,
	copies: SourceObject[],
) {
	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL || !env.MEDIA_SERVER_WEBHOOK_SECRET) return;
	const secret = env.MEDIA_SERVER_WEBHOOK_SECRET;
	const { video, bucket } = context;
	const initKey = `${video.ownerId}/${video.id}/segments/video/init.mp4`;
	const init = await captureOriginal(context, {
		originalKey: initKey,
		track: "video",
		index: 0,
	});
	const sign = (key: string) =>
		context.run(bucket.getInternalSignedObjectUrl(key, { expiresIn: 3_600 }));
	const initUrl = await sign(initKey);
	const sorted = [...copies].sort((left, right) => left.index - right.index);
	const runs: SourceObject[][] = [];
	for (const copy of sorted) {
		const current = runs.at(-1);
		if (current && current.at(-1)?.index === copy.index - 1) current.push(copy);
		else runs.push([copy]);
	}
	const mediaServerUrl = env.MEDIA_SERVER_URL.replace(/\/$/, "");
	await Promise.all(
		runs.map(async (run) => {
			const first = run[0];
			const last = run.at(-1);
			if (!first || !last) return;
			const digest = hash(
				JSON.stringify([
					init.originalIdentity,
					...run.map((copy) => copy.objectIdentity),
				]),
			).slice(0, 16);
			const resultKey = `${preverifiedRunPrefix(video)}${String(first.index).padStart(6, "0")}-${String(last.index).padStart(6, "0")}-${digest}.json`;
			const [segments, resultUploadUrl] = await Promise.all([
				Promise.all(
					run.map(async (copy) => ({
						url: await sign(copy.key),
						objectIdentity: copy.objectIdentity,
						size: copy.size,
					})),
				),
				context.run(
					bucket.getInternalPresignedPutUrl(
						resultKey,
						{ ContentType: "application/json" },
						{ expiresIn: 3_600 },
					),
				),
			]);
			const response = await fetch(
				`${mediaServerUrl}/video/preverify-segments`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-media-server-secret": secret,
					},
					body: JSON.stringify({
						videoId: video.id,
						init: {
							url: initUrl,
							objectIdentity: init.originalIdentity,
							size: init.size,
						},
						segments,
						resultUploadUrl,
					}),
					signal: AbortSignal.timeout(3_000),
				},
			);
			await response.body?.cancel().catch(() => {});
			if (!response.ok)
				throw new Error(
					`Preverification request failed: HTTP ${response.status}`,
				);
		}),
	);
}

// Signed URLs for every run decoded during the recording; the media server checks each run's signature
// and fragment identities itself, so an unusable run only costs a decode it would have done anyway.
export async function buildPreverifiedRunUrls(
	video: DbVideo,
): Promise<string[]> {
	try {
		const access = await runWorkflowPromise(
			Storage.getAccessForVideo(decodeStorageVideo(video), {
				resolvePublishedOutput: false,
			}),
		);
		const [bucket, customBucket] = access;
		if (bucket.provider !== "s3" || Option.isSome(customBucket)) return [];
		const listed = await listObjectsUnder(
			{
				video,
				bucket,
				run: (operation) =>
					runWorkflowPromise(operation.pipe(Effect.timeout(10_000))),
				prefix: sourcePrefix(video).slice(0, -1),
				...sourceLimits(access),
			},
			preverifiedRunPrefix(video),
		);
		if (!listed) return [];
		const keys = [...listed.keys()]
			.filter((key) => key.endsWith(".json"))
			.sort()
			.slice(0, 4_096);
		return await mapBounded(
			keys,
			(key) =>
				runWorkflowPromise(
					bucket.getInternalSignedObjectUrl(key, { expiresIn: 6 * 60 * 60 }),
				),
			64,
		);
	} catch {
		return [];
	}
}

async function advanceMultipartCopy(
	context: SourceContext,
	checkpoint: DesktopRecordingSourceCheckpoint,
	original: OriginalObject,
	scope: string,
): Promise<
	| { multipart: NonNullable<DesktopRecordingSourceCheckpoint["multipart"]> }
	| { object: SourceObject }
	| { reset: true }
> {
	try {
		return await copyMultipartPartBatch(context, checkpoint, original, scope);
	} catch (error) {
		const classified = sourceStorageError(error);
		if (
			!(classified instanceof SourceCopyExpiredError) &&
			!(
				classified instanceof DesktopRecordingSourceError &&
				classified.code === "source-missing"
			)
		)
			throw error;
		const completed = await reusableCopy(context, original, checkpoint.cursor);
		return completed ? { object: completed } : { reset: true };
	}
}

async function copyMultipartPartBatch(
	context: SourceContext,
	checkpoint: DesktopRecordingSourceCheckpoint,
	original: OriginalObject,
	scope: string,
): Promise<
	| { multipart: NonNullable<DesktopRecordingSourceCheckpoint["multipart"]> }
	| { object: SourceObject }
> {
	const existing = await reusableCopy(context, original, checkpoint.cursor);
	if (existing) return { object: existing };
	const multipart = checkpoint.multipart;
	if (!multipart) {
		const key = newCopyKey(context, original, checkpoint.cursor);
		const partSize = Math.max(
			128 * 1024 ** 2,
			Math.ceil(original.size / 9_999 / 1024 ** 2) * 1024 ** 2,
		);
		if (partSize > 5 * 1024 ** 3)
			invalidSource(
				"Recording exceeds the supported multipart source copy size",
			);
		const upload = await context.run(
			context.bucket.multipart.create(key, {
				Metadata: copyMetadata(original),
				ContentType: original.track === "audio" ? "audio/mp4" : "video/mp4",
			}),
		);
		if (!upload.UploadId)
			throw new Error("Source copy did not create an upload");
		return {
			multipart: {
				position: checkpoint.cursor,
				key,
				originalIdentity: original.originalIdentity,
				size: original.size,
				uploadId: upload.UploadId,
				partSize,
				nextPartNumber: 1,
				partRoots: [],
				pendingParts: [],
			},
		};
	}
	assertContextKey(context, multipart.key);
	if (
		multipart.position !== checkpoint.cursor ||
		multipart.originalIdentity !== original.originalIdentity ||
		multipart.size !== original.size
	)
		invalidSource("Multipart source checkpoint does not match its source plan");
	const partScope = `${scope}:${multipart.uploadId}`;
	const partCount = Math.ceil(original.size / multipart.partSize);
	if (multipart.nextPartNumber <= partCount) {
		const copyPart = context.bucket.multipart.copyPart;
		if (!copyPart) throw new Error("Multipart source copy is unavailable");
		const numbers = Array.from(
			{
				length: Math.min(
					SOURCE_COMMIT_PART_BATCH_SIZE,
					partCount - multipart.nextPartNumber + 1,
				),
			},
			(_, index) => multipart.nextPartNumber + index,
		);
		const parts = await mapBounded(numbers, async (PartNumber) => {
			const offset = (PartNumber - 1) * multipart.partSize;
			const copied = await context.run(
				copyPart(multipart.key, multipart.uploadId, PartNumber, {
					CopySource: `${context.bucket.bucketName}/${original.originalKey}`,
					CopySourceIfMatch: original.originalIdentity,
					CopySourceRange: `bytes=${offset}-${Math.min(original.size - 1, offset + multipart.partSize - 1)}`,
				}),
			);
			if (!copied.CopyPartResult?.ETag)
				throw new Error("Source copy part has no object identity");
			return { ETag: copied.CopyPartResult.ETag, PartNumber };
		});
		let pendingParts = [...multipart.pendingParts, ...parts];
		let partRoots = multipart.partRoots;
		if (pendingParts.length >= SOURCE_COMMIT_PART_PAGE_SIZE) {
			partRoots = await appendTree(
				context,
				partRoots,
				"parts",
				partScope,
				pendingParts.slice(0, SOURCE_COMMIT_PART_PAGE_SIZE),
			);
			pendingParts = pendingParts.slice(SOURCE_COMMIT_PART_PAGE_SIZE);
		}
		return {
			multipart: {
				...multipart,
				partRoots,
				pendingParts,
				nextPartNumber: multipart.nextPartNumber + parts.length,
			},
		};
	}
	const parts = [
		...(await readTree(
			context,
			multipart.partRoots,
			"parts",
			partScope,
			sourceCommitPartSchema,
		)),
		...multipart.pendingParts,
	];
	if (
		parts.length !== partCount ||
		parts.some((part, index) => part.PartNumber !== index + 1)
	)
		invalidSource("Multipart recording source is missing a copied range");
	await context.run(
		context.bucket.multipart.complete(multipart.key, multipart.uploadId, {
			MultipartUpload: { Parts: parts },
			IfNoneMatch: "*",
		}),
	);
	return {
		object: await saveObjectReceipt(
			context,
			await checkCopy(context, original, multipart.key),
		),
	};
}

// Listed commits run phase after phase inside one checkpoint while their time budget lasts, saving the
// checkpoint round trips; the saved checkpoint still advances by exactly one revision.
async function advanceSourceSnapshot(
	context: SourceContext,
	checkpoint: DesktopRecordingSourceCheckpoint,
	verification?: RecordingVerification,
): Promise<
	| { checkpoint: DesktopRecordingSourceCheckpoint }
	| { source: DesktopRecordingSource }
> {
	if (!context.listed)
		return advanceSourceSnapshotOnce(context, checkpoint, verification);
	const deadline = Date.now() + LISTED_ADVANCE_BUDGET_MS;
	let current = checkpoint;
	for (;;) {
		const result = await advanceSourceSnapshotOnce(
			context,
			current,
			verification,
			deadline,
		);
		if ("source" in result) return { source: result.source };
		current = result.checkpoint;
		if (!result.listed || Date.now() >= deadline)
			return { checkpoint: { ...current, revision: checkpoint.revision + 1 } };
	}
}

function assertCopyKey(
	context: SourceContext,
	original: OriginalObject,
	key: string,
) {
	const prepared = preparedSourcePrefix(context.video, original);
	assertContextKey(
		key.startsWith(`${prepared}/`) ? { ...context, prefix: prepared } : context,
		key,
	);
}

function assertReceiptMatchesPlan(
	object: SourceObject,
	original: OriginalObject | undefined,
): asserts original is OriginalObject {
	if (
		!original ||
		object.originalKey !== original.originalKey ||
		object.originalIdentity !== original.originalIdentity ||
		object.size !== original.size ||
		object.index !== original.index ||
		object.track !== original.track
	)
		invalidSource("Recording copy receipt does not match its source plan");
}

async function advanceSourceSnapshotOnce(
	context: SourceContext,
	checkpoint: DesktopRecordingSourceCheckpoint,
	verification?: RecordingVerification,
	deadline?: number,
): Promise<
	| { checkpoint: DesktopRecordingSourceCheckpoint; listed?: boolean }
	| { source: DesktopRecordingSource }
> {
	const next = { ...checkpoint, revision: checkpoint.revision + 1 };
	if (checkpoint.phase === "plan") {
		const segmented =
			context.video.source.type === "desktopSegments" ||
			verification?.artifact.kind === "segments";
		const [plan, listing] = await Promise.all([
			createSourcePlan(context, verification),
			context.listed && segmented && deadline !== undefined
				? listSnapshot(context, false)
				: null,
		]);
		return {
			checkpoint: { ...next, phase: "enumerate" as const, plan },
			listed: listing !== null,
		};
	}
	if (!checkpoint.plan)
		invalidSource("Recording source checkpoint has no committed plan");
	const parsedPlan = sourcePlanSchema.safeParse(
		await readReference(context, checkpoint.plan),
	);
	if (!parsedPlan.success) invalidSource("Recording source plan is invalid");
	const plan = parsedPlan.data;
	const scope = checkpoint.plan.sha256;
	const listed =
		context.listed && plan.kind === "segments" && deadline !== undefined;
	const pageEnd = (cursor: number) =>
		Math.min(plan.objectCount, cursor + context.pageSize);
	const positions = (start: number, end: number) =>
		Array.from({ length: end - start }, (_, index) => start + index);
	if (checkpoint.phase === "enumerate") {
		if (treeCount(checkpoint.planRoots) !== checkpoint.cursor)
			invalidSource("Recording source plan cursor is incomplete");
		const listing = listed ? await listSnapshot(context, false) : null;
		if (listing && deadline !== undefined) {
			let cursor = checkpoint.cursor;
			let planRoots = checkpoint.planRoots;
			do {
				const end = pageEnd(cursor);
				const originals = await mapBounded(
					positions(cursor, end),
					(position) => {
						const original = originalAt(context.video, plan, position);
						const found = listing.originals.get(original.originalKey);
						return found && found.size > 0
							? Promise.resolve({
									...original,
									originalIdentity: found.identity,
									size: found.size,
								})
							: captureOriginal(context, original, verification);
					},
					context.concurrency,
				);
				planRoots = await appendTree(
					context,
					planRoots,
					"plan",
					scope,
					originals,
				);
				cursor = end;
			} while (cursor < plan.objectCount && Date.now() < deadline);
			const done = cursor === plan.objectCount;
			return {
				checkpoint: {
					...next,
					planRoots,
					cursor: done ? 0 : cursor,
					phase: done ? ("copy" as const) : ("enumerate" as const),
				},
				listed: true,
			};
		}
		const end = Math.min(
			plan.objectCount,
			checkpoint.cursor + context.pageSize,
		);
		const originals = await mapBounded(
			Array.from(
				{ length: end - checkpoint.cursor },
				(_, index) => checkpoint.cursor + index,
			),
			(position) =>
				captureOriginal(
					context,
					originalAt(context.video, plan, position),
					verification,
				),
			context.concurrency,
		);
		const planRoots = await appendTree(
			context,
			checkpoint.planRoots,
			"plan",
			scope,
			originals,
		);
		return {
			checkpoint: {
				...next,
				planRoots,
				cursor: end === plan.objectCount ? 0 : end,
				phase:
					end === plan.objectCount ? ("copy" as const) : ("enumerate" as const),
			},
		};
	}
	if (treeCount(checkpoint.planRoots) !== plan.objectCount)
		invalidSource("Recording source plan omits required fragments");
	if (checkpoint.phase === "copy") {
		if (treeCount(checkpoint.receiptRoots) !== checkpoint.cursor)
			invalidSource(
				"Recording copy receipts do not match their checkpoint cursor",
			);
		const listing =
			listed && !checkpoint.multipart
				? await listSnapshot(context, true)
				: null;
		if (listing && deadline !== undefined) {
			let cursor = checkpoint.cursor;
			let receiptRoots = checkpoint.receiptRoots;
			do {
				const end = pageEnd(cursor);
				const originals = await readTree(
					context,
					checkpoint.planRoots,
					"plan",
					scope,
					originalObjectSchema,
					cursor,
					end,
				);
				// Multipart copies keep their own per-object checkpoints, so they stay on the per-page path.
				if (originals.some((original) => original.size > 5 * 1024 ** 3)) break;
				const objects = await mapBounded(
					originals.map((original, index) => ({
						original,
						position: cursor + index,
					})),
					({ original, position }) => {
						const prepared = plan.sourcePreparation === true;
						const found = findListedCopy(
							context,
							listing,
							original,
							position,
							prepared,
						);
						if (found === "unlisted")
							return copyListedObject(context, original, position);
						return found
							? Promise.resolve(found)
							: copySmallObject(context, original, position, prepared);
					},
					context.concurrency,
				);
				receiptRoots = await appendTree(
					context,
					receiptRoots,
					"objects",
					scope,
					objects,
				);
				cursor = end;
			} while (cursor < plan.objectCount && Date.now() < deadline);
			if (cursor !== checkpoint.cursor) {
				const done = cursor === plan.objectCount;
				return {
					checkpoint: {
						...next,
						receiptRoots,
						multipart: undefined,
						cursor: done ? 0 : cursor,
						phase: done ? ("verify" as const) : ("copy" as const),
					},
					listed: true,
				};
			}
		}
		let originals = await readTree(
			context,
			checkpoint.planRoots,
			"plan",
			scope,
			originalObjectSchema,
			checkpoint.cursor,
			Math.min(plan.objectCount, checkpoint.cursor + context.pageSize),
		);
		const large =
			context.bucket.provider === "s3"
				? originals.findIndex((original) => original.size > 5 * 1024 ** 3)
				: -1;
		let objects: SourceObject[];
		if (large === 0) {
			const original = originals[0];
			if (!original) invalidSource("Multipart recording source is missing");
			const result = await advanceMultipartCopy(
				context,
				checkpoint,
				original,
				scope,
			);
			if ("multipart" in result)
				return { checkpoint: { ...next, multipart: result.multipart } };
			if ("reset" in result)
				return { checkpoint: { ...next, multipart: undefined } };
			objects = [result.object];
		} else {
			if (checkpoint.multipart)
				invalidSource("Multipart checkpoint changed source type");
			if (large > 0) originals = originals.slice(0, large);
			objects = await mapBounded(
				originals.map((original, index) => ({
					original,
					position: checkpoint.cursor + index,
				})),
				({ original, position }) =>
					copySmallObject(
						context,
						original,
						position,
						plan.sourcePreparation === true,
					),
				context.concurrency,
			);
		}
		const receiptRoots = await appendTree(
			context,
			checkpoint.receiptRoots,
			"objects",
			scope,
			objects,
		);
		const cursor = checkpoint.cursor + objects.length;
		return {
			checkpoint: {
				...next,
				receiptRoots,
				multipart: undefined,
				cursor: cursor === plan.objectCount ? 0 : cursor,
				phase:
					cursor === plan.objectCount ? ("verify" as const) : ("copy" as const),
			},
		};
	}
	if (treeCount(checkpoint.receiptRoots) !== plan.objectCount)
		invalidSource("Recording snapshot is missing required copy receipts");
	if (checkpoint.phase === "verify") {
		const listing = listed ? await listSnapshot(context, true) : null;
		if (listing && deadline !== undefined) {
			let cursor = checkpoint.cursor;
			do {
				const end = pageEnd(cursor);
				const [originals, objects] = await Promise.all([
					readTree(
						context,
						checkpoint.planRoots,
						"plan",
						scope,
						originalObjectSchema,
						cursor,
						end,
					),
					readTree(
						context,
						checkpoint.receiptRoots,
						"objects",
						scope,
						sourceObjectSchema,
						cursor,
						end,
					),
				]);
				await mapBounded(
					objects.map((object, index) => ({
						object,
						original: originals[index],
					})),
					async ({ object, original }) => {
						assertReceiptMatchesPlan(object, original);
						const copy = listing.copies.get(object.key);
						if (
							copy?.size === original.size &&
							copy.identity === object.objectIdentity &&
							object.objectIdentity === original.originalIdentity &&
							listedOriginalMatches(listing, original)
						) {
							assertCopyKey(context, original, object.key);
							return;
						}
						await checkCopy(
							context,
							original,
							object.key,
							object.objectIdentity,
						);
					},
					context.concurrency,
				);
				cursor = end;
			} while (cursor < plan.objectCount && Date.now() < deadline);
			return {
				checkpoint: {
					...next,
					cursor,
					phase:
						cursor === plan.objectCount
							? ("finalize" as const)
							: ("verify" as const),
				},
				listed: true,
			};
		}
		const end = Math.min(
			plan.objectCount,
			checkpoint.cursor + context.pageSize,
		);
		const [originals, objects] = await Promise.all([
			readTree(
				context,
				checkpoint.planRoots,
				"plan",
				scope,
				originalObjectSchema,
				checkpoint.cursor,
				end,
			),
			readTree(
				context,
				checkpoint.receiptRoots,
				"objects",
				scope,
				sourceObjectSchema,
				checkpoint.cursor,
				end,
			),
		]);
		await mapBounded(
			objects.map((object, index) => ({ object, original: originals[index] })),
			async ({ object, original }) => {
				assertReceiptMatchesPlan(object, original);
				await checkCopy(context, original, object.key, object.objectIdentity);
			},
			context.concurrency,
		);
		return {
			checkpoint: {
				...next,
				cursor: end,
				phase:
					end === plan.objectCount
						? ("finalize" as const)
						: ("verify" as const),
			},
		};
	}
	if (checkpoint.cursor !== plan.objectCount)
		invalidSource("Recording source has not completed verification");
	let inventoryKey: string;
	let inventory: unknown;
	let mp4: DesktopRecordingSource["mp4"];
	let manifestCopy: Promise<unknown> | undefined;
	if (plan.kind === "mp4") {
		const [object] = await readTree(
			context,
			checkpoint.receiptRoots,
			"objects",
			scope,
			sourceObjectSchema,
		);
		if (!object || object.track !== "mp4" || !plan.mp4)
			invalidSource("Recording MP4 inventory is incomplete");
		await checkCopy(context, object, object.key, object.objectIdentity);
		inventoryKey = `${objectDirectory(object.key)}/inventory.json`;
		inventory = { version: 1, kind: "mp4", objects: [object] };
		mp4 = {
			fileSize: object.size,
			objectIdentity: object.originalIdentity,
			...(plan.mp4.duration === undefined
				? {}
				: { duration: plan.mp4.duration }),
		};
	} else {
		if (!plan.manifestKey || !plan.originalManifestKey || !plan.manifestSha256)
			invalidSource("Recording manifest is missing from its source plan");
		assertContextKey(context, plan.manifestKey);
		const [saved, current] = await Promise.all([
			readSourceText(context, plan.manifestKey),
			readSourceText(context, plan.originalManifestKey),
		]);
		if (saved !== current || hash(saved) !== plan.manifestSha256)
			throw new DesktopRecordingSourceError(
				"source-changed",
				"Recording manifest changed while its durable snapshot was being saved",
			);
		const directory = `${context.prefix}/commits/${randomUUID()}`;
		inventoryKey = `${directory}/inventory.json`;
		inventory = {
			version: 2,
			kind: "segments",
			manifestSha256: plan.manifestSha256,
			objectCount: plan.objectCount,
			scope,
			roots: checkpoint.receiptRoots,
		};
		// The commit directory is new and only referenced once both writes are durable.
		manifestCopy = writeSourceText(
			context,
			`${directory}/manifest.json`,
			saved,
		);
	}
	const [saved] = await Promise.all([
		writeSourceText(context, inventoryKey, JSON.stringify(inventory)),
		manifestCopy,
	]);
	return {
		source: desktopRecordingSourceSchema.parse({
			version: 1,
			kind: plan.kind,
			manifestSha256: plan.manifestSha256,
			inventorySha256: saved.sha256,
			inventoryKey,
			requiredAudio: plan.requiredAudio,
			mp4,
		}),
	};
}

export async function advanceDesktopRecordingSourceCommit(
	video: DbVideo,
	checkpoint: DesktopRecordingSourceCheckpoint,
	verification?: RecordingVerification,
	onProgress?: () => Promise<void>,
): Promise<
	| { checkpoint: DesktopRecordingSourceCheckpoint }
	| { source: DesktopRecordingSource }
> {
	const parsed = desktopRecordingSourceCheckpointSchema.parse(checkpoint);
	if (verification) recordingVerificationSchema.parse(verification);
	identifierSchema.parse(video.ownerId);
	identifierSchema.parse(video.id);
	const deadline = Date.now() + SOURCE_COMMIT_STEP_TIMEOUT_MS;
	let heartbeatFailure: unknown;
	let heartbeat: Promise<void> | undefined;
	const pulse = () => {
		if (!onProgress || heartbeat || heartbeatFailure !== undefined) return;
		heartbeat = onProgress()
			.catch((error: unknown) => {
				heartbeatFailure = error;
			})
			.finally(() => {
				heartbeat = undefined;
			});
	};
	await onProgress?.();
	const timer = onProgress ? setInterval(pulse, 30_000) : undefined;
	const run: SourceRun = async (operation) => {
		if (heartbeatFailure !== undefined) throw heartbeatFailure;
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error("Recording source checkpoint step timed out");
		return runWorkflowPromise(
			operation.pipe(
				Effect.timeout(Math.min(SOURCE_COMMIT_IO_TIMEOUT_MS, remaining)),
			),
		);
	};
	try {
		const access = await run(
			Storage.getAccessForVideo(decodeStorageVideo(video), {
				resolvePublishedOutput: false,
			}),
		);
		const result = await advanceSourceSnapshot(
			{
				video,
				bucket: access[0],
				run,
				prefix: `${sourcePrefix(video)}${parsed.generation}/${parsed.snapshotId}`,
				...sourceLimits(access),
				reuseVerifiedPages: true,
			},
			parsed,
			verification,
		);
		await heartbeat;
		if (heartbeatFailure !== undefined) throw heartbeatFailure;
		await onProgress?.();
		return result;
	} catch (error) {
		throw sourceStorageError(error);
	} finally {
		if (timer !== undefined) clearInterval(timer);
		await heartbeat;
	}
}

export async function commitDesktopRecordingSource(
	video: DbVideo,
	generation: string,
	verification?: RecordingVerification,
	onProgress?: () => Promise<void>,
): Promise<DesktopRecordingSource> {
	let checkpoint: DesktopRecordingSourceCheckpoint = {
		kind: "desktop-recording-source-commit",
		version: 1,
		generation,
		snapshotId: randomUUID(),
		revision: 0,
		phase: "plan",
		cursor: 0,
		planRoots: [],
		receiptRoots: [],
	};
	for (;;) {
		const result = await advanceDesktopRecordingSourceCommit(
			video,
			checkpoint,
			verification,
			onProgress,
		);
		if ("source" in result) return result.source;
		checkpoint = result.checkpoint;
	}
}

export async function buildDesktopRecordingSourceUrls(
	video: DbVideo,
	source: DesktopRecordingSource,
) {
	assertSourceKey(video, source.inventoryKey);
	const access = await runWorkflowPromise(
		Storage.getAccessForVideo(decodeStorageVideo(video)),
	);
	const [bucket] = access;
	const content = await readRequiredObject(bucket, source.inventoryKey);
	if (hash(content) !== source.inventorySha256) {
		throw new DesktopRecordingSourceError(
			"source-changed",
			"The committed recording inventory has changed",
		);
	}
	const parsed = committedInventorySchema.safeParse(parseSourceJson(content));
	if (!parsed.success) invalidSource("Recording inventory is invalid");
	const inventory = parsed.data;
	if (
		inventory.kind !== source.kind ||
		inventory.manifestSha256 !== source.manifestSha256
	) {
		throw new DesktopRecordingSourceError(
			"source-invalid",
			"Recording inventory does not match its committed source",
		);
	}
	if (
		inventory.version === 2 &&
		treeCount(inventory.roots) !== inventory.objectCount
	) {
		invalidSource(
			"Recording inventory page ranges do not cover its complete source",
		);
	}
	const run: SourceRun = async (operation) => {
		try {
			return await runWorkflowPromise(operation);
		} catch (error) {
			throw sourceStorageError(error);
		}
	};
	const objects =
		inventory.version === 1
			? inventory.objects
			: await readTree(
					{
						video,
						bucket,
						run,
						prefix: sourcePrefix(video).slice(0, -1),
						...sourceLimits(access),
					},
					inventory.roots,
					"objects",
					inventory.scope,
					sourceObjectSchema,
				);
	if (inventory.version === 2 && objects.length !== inventory.objectCount)
		invalidSource("Recording inventory omits required fragments");
	const sourceObjects = await mapBounded(objects, async (object) => {
		assertSourceKey(video, object.key);
		const url = await runWorkflowPromise(
			bucket.getInternalSignedObjectUrl(object.key, { expiresIn: 6 * 60 * 60 }),
		);
		return { ...object, url };
	});
	const videoObjects = sourceObjects.filter(
		(object) => object.track === "video",
	);
	const audioObjects = sourceObjects.filter(
		(object) => object.track === "audio",
	);
	const mp4 = sourceObjects.find((object) => object.track === "mp4");
	return {
		manifestSha256: source.manifestSha256,
		inventorySha256: source.inventorySha256,
		sourceObjects: sourceObjects.map(({ url, objectIdentity, size }) => ({
			url,
			objectIdentity,
			size,
		})),
		videoInitUrl: videoObjects.find((object) => object.index === 0)?.url,
		videoSegmentUrls: videoObjects
			.filter((object) => object.index > 0)
			.map((object) => object.url),
		audioInitUrl: audioObjects.find((object) => object.index === 0)?.url,
		audioSegmentUrls: audioObjects
			.filter((object) => object.index > 0)
			.map((object) => object.url),
		videoUrl: mp4?.url,
		sourceObjectIdentity: mp4?.objectIdentity,
		sourceFileSize: mp4?.size,
		sourceOutputKey: mp4?.key,
		outputKey: mp4?.key,
	};
}
