import { createHash, randomUUID } from "node:crypto";
import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { getPublishedRecordingOutputKey } from "@cap/web-backend/src/Storage/recording-output";
import { Video } from "@cap/web-domain";
import { Effect, Option, Runtime } from "effect";
import { z } from "zod";
import {
	type DesktopRecordingSourceCheckpoint,
	desktopRecordingSourceCheckpointSchema,
	SOURCE_COMMIT_MAX_OBJECTS,
	SOURCE_COMMIT_PAGE_SIZE,
	SOURCE_COMMIT_PART_BATCH_SIZE,
	SOURCE_COMMIT_PART_PAGE_SIZE,
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
type RecordingStorage = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>[0];

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
		entries: z.array(z.unknown()).min(1).max(SOURCE_COMMIT_PART_PAGE_SIZE),
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
) {
	const output = new Array<R>(items.length);
	const entries = items.entries();
	let failure: unknown;
	await Promise.all(
		Array.from({ length: Math.min(8, items.length) }, async () => {
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

async function readReference(
	context: SourceContext,
	reference: SourceCommitReference,
) {
	assertContextKey(context, reference.key);
	const content = await readSourceText(context, reference.key);
	if (hash(content) !== reference.sha256)
		throw new DesktopRecordingSourceError(
			"source-changed",
			"A recording source checkpoint changed after it was saved",
		);
	return parseSourceJson(content);
}

async function writeSourceText(
	context: SourceContext,
	key: string,
	content: string,
) {
	assertContextKey(context, key);
	await context.run(
		context.bucket.putObject(key, content, { contentType: "application/json" }),
	);
	if ((await readSourceText(context, key)) !== content)
		throw new Error("Durable recording source readback did not match");
	return { key, sha256: hash(content) };
}

async function writeReference(context: SourceContext, value: unknown) {
	return writeSourceText(
		context,
		`${context.prefix}/pages/${randomUUID()}.json`,
		JSON.stringify(value),
	);
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
	if (entries.length === 0 || entries.length > SOURCE_COMMIT_PART_PAGE_SIZE)
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
		const pages = await mapBounded(pending, async (reference) => {
			const parsed = treePageSchema.safeParse(
				await readReference(context, reference),
			);
			if (!parsed.success) invalidSource("Recording source page is invalid");
			const page = parsed.data;
			if (page.kind !== kind || page.scope !== scope)
				invalidSource("Recording source page belongs to a different snapshot");
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
		});
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
		await writeSourceText(context, manifestKey, content);
		plan = {
			version: 1,
			kind: "segments",
			manifestSha256: manifest.manifestSha256,
			manifestKey,
			originalManifestKey,
			requiredAudio: manifest.hasAudio,
			videoCount,
			audioCount,
			objectCount: videoCount + audioCount,
		};
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
	assertContextKey(context, key);
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
	await writeSourceText(
		context,
		`${objectDirectory(object.key)}/receipt.json`,
		JSON.stringify(object),
	);
	return object;
}

async function reusableCopy(
	context: SourceContext,
	original: OriginalObject,
	position: number,
) {
	await checkOriginal(context, original);
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
) {
	const existing = await reusableCopy(context, original, position);
	if (existing) return existing;
	const key = newCopyKey(context, original, position);
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
	return saveObjectReceipt(context, await checkCopy(context, original, key));
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

async function advanceSourceSnapshot(
	context: SourceContext,
	checkpoint: DesktopRecordingSourceCheckpoint,
	verification?: RecordingVerification,
) {
	const next = { ...checkpoint, revision: checkpoint.revision + 1 };
	if (checkpoint.phase === "plan") {
		return {
			checkpoint: {
				...next,
				phase: "enumerate" as const,
				plan: await createSourcePlan(context, verification),
			},
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
	if (checkpoint.phase === "enumerate") {
		if (treeCount(checkpoint.planRoots) !== checkpoint.cursor)
			invalidSource("Recording source plan cursor is incomplete");
		const end = Math.min(
			plan.objectCount,
			checkpoint.cursor + SOURCE_COMMIT_PAGE_SIZE,
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
		let originals = await readTree(
			context,
			checkpoint.planRoots,
			"plan",
			scope,
			originalObjectSchema,
			checkpoint.cursor,
			Math.min(plan.objectCount, checkpoint.cursor + SOURCE_COMMIT_PAGE_SIZE),
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
					copySmallObject(context, original, position),
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
		const end = Math.min(
			plan.objectCount,
			checkpoint.cursor + SOURCE_COMMIT_PAGE_SIZE,
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
				if (
					!original ||
					object.originalKey !== original.originalKey ||
					object.originalIdentity !== original.originalIdentity ||
					object.size !== original.size ||
					object.index !== original.index ||
					object.track !== original.track
				)
					invalidSource(
						"Recording copy receipt does not match its source plan",
					);
				await checkCopy(context, original, object.key, object.objectIdentity);
			},
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
		await writeSourceText(context, `${directory}/manifest.json`, saved);
		inventoryKey = `${directory}/inventory.json`;
		inventory = {
			version: 2,
			kind: "segments",
			manifestSha256: plan.manifestSha256,
			objectCount: plan.objectCount,
			scope,
			roots: checkpoint.receiptRoots,
		};
	}
	const saved = await writeSourceText(
		context,
		inventoryKey,
		JSON.stringify(inventory),
	);
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
		const [bucket] = await run(
			Storage.getAccessForVideo(decodeStorageVideo(video), {
				resolvePublishedOutput: false,
			}),
		);
		const result = await advanceSourceSnapshot(
			{
				video,
				bucket,
				run,
				prefix: `${sourcePrefix(video)}${parsed.generation}/${parsed.snapshotId}`,
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
	const [bucket] = await runWorkflowPromise(
		Storage.getAccessForVideo(decodeStorageVideo(video)),
	);
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
