import { z } from "zod";
import {
	recordingObjectIdentitySchema,
	recordingOutputKeySchema,
	recordingUploadReceiptSchema,
} from "@/lib/desktop-recording-verification";
import type {
	OwnershipMediaStore,
	OwnershipSnapshot,
	TransferObject,
} from "@/lib/recording-ownership-transfer";

export class OwnershipTransferError extends Error {
	constructor(
		readonly code:
			| "NOT_READY"
			| "UNSUPPORTED"
			| "INVALID_REFERENCE"
			| "MEDIA_CHANGED"
			| "DESTINATION_CONFLICT"
			| "SNAPSHOT_CHANGED"
			| "STORAGE_FAILED",
	) {
		super(`Recording ownership transfer held: ${code}`);
	}
}

const positive = z.number().finite().positive();
const size = positive.int().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = recordingObjectIdentitySchema;
const key = recordingOutputKeySchema;
const artifact = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("segments"), manifestSha256: digest }).strict(),
	z
		.object({
			kind: z.literal("mp4"),
			fileSize: size,
			duration: positive,
			objectIdentity: identity,
		})
		.strict(),
]);
const receiptShape = {
	version: z.literal(1),
	artifact,
	fileSize: size,
	duration: positive,
	hasAudio: z.boolean(),
	fullDecode: z.literal(true),
	requiredAudioVerified: z.boolean().optional(),
	objectIdentity: identity,
	sourceObjectIdentity: identity.optional(),
	outputKey: key.optional(),
	outputSha256: digest.optional(),
	sourceProof: z
		.object({
			version: z.literal(1),
			manifestSha256: digest,
			inventorySha256: digest,
			sourcePreserved: z.literal(true),
			videoDuration: positive,
			hasAudio: z.boolean(),
			audioVerified: z.boolean(),
		})
		.strict()
		.optional(),
};
const receiptSchema = z
	.object(receiptShape)
	.strict()
	.refine((value) => recordingUploadReceiptSchema.safeParse(value).success);
const verificationSchema = z
	.object({
		version: z.literal(1),
		artifact,
		requiredAudio: z.boolean(),
	})
	.strict();
const sourceSchema = z
	.object({
		version: z.literal(1),
		kind: z.enum(["segments", "mp4"]),
		manifestSha256: digest.optional(),
		inventorySha256: digest,
		inventoryKey: key,
		requiredAudio: z.boolean(),
		mp4: z
			.object({
				fileSize: size,
				duration: positive.optional(),
				objectIdentity: identity,
			})
			.strict()
			.optional(),
	})
	.strict();
const workerSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("recording-worker"),
		generation: z.string().min(1),
		attemptId: z.string().min(1),
		jobId: z.string().min(1),
		sequence: z.number().int().nonnegative().safe(),
		phase: z.literal("complete"),
		progress: z.literal(100),
		payloadSha256: digest,
		updatedAt: z.string().datetime(),
		stateChangedAt: z.string().datetime(),
	})
	.strict();
const archivedReceiptSchema = z
	.object({
		...receiptShape,
		verifiedAt: z.string().datetime(),
		recordingWorker: workerSchema.optional(),
	})
	.strict()
	.refine((value) => recordingUploadReceiptSchema.safeParse(value).success);
const sourceObjectSchema = z
	.object({
		key,
		originalKey: key,
		originalIdentity: identity,
		objectIdentity: identity,
		size,
		track: z.enum(["video", "audio", "mp4"]),
		index: z.number().int().nonnegative(),
	})
	.strict();
const pageReference = z
	.object({
		key,
		sha256: digest,
		start: z.number().int().nonnegative().max(10_000),
		count: z.number().int().positive().max(10_000),
		level: z.number().int().nonnegative().max(17),
	})
	.strict();
const inventorySchema = z.discriminatedUnion("version", [
	z
		.object({
			version: z.literal(1),
			kind: z.enum(["segments", "mp4"]),
			manifestSha256: digest.optional(),
			objects: z.array(sourceObjectSchema).min(1).max(10_000),
		})
		.strict(),
	z
		.object({
			version: z.literal(2),
			kind: z.literal("segments"),
			manifestSha256: digest,
			objectCount: z.number().int().positive().max(10_000),
			scope: digest,
			roots: z.array(pageReference).min(1).max(18),
		})
		.strict(),
]);
const pageSchema = z.discriminatedUnion("type", [
	z
		.object({
			version: z.literal(1),
			type: z.literal("leaf"),
			kind: z.literal("objects"),
			scope: digest,
			start: z.number().int().nonnegative(),
			entries: z.array(sourceObjectSchema).min(1).max(64),
		})
		.strict(),
	z
		.object({
			version: z.literal(1),
			type: z.literal("branch"),
			kind: z.literal("objects"),
			scope: digest,
			children: z.tuple([pageReference, pageReference]),
		})
		.strict(),
]);
const segment = z.union([
	z.number().int().positive(),
	z.object({ index: z.number().int().positive(), duration: positive }).strict(),
]);
const manifestSchema = z
	.object({
		version: z.number().int().positive(),
		video_init_uploaded: z.literal(true),
		audio_init_uploaded: z.boolean(),
		video_segments: z.array(segment).min(1).max(10_000),
		audio_segments: z.array(segment).max(10_000),
		is_complete: z.literal(true),
	})
	.strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new OwnershipTransferError("UNSUPPORTED");
	return parsed.data;
}

export function requireOwnershipKey(value: string, prefix: string) {
	if (
		!key.safeParse(value).success ||
		!value.startsWith(prefix) ||
		value === prefix
	)
		throw new OwnershipTransferError("INVALID_REFERENCE");
}

export function ownershipEvidence(snapshot: OwnershipSnapshot) {
	return {
		receipt: snapshot.video.metadata?.desktopRecordingUpload
			? parse(receiptSchema, snapshot.video.metadata.desktopRecordingUpload)
			: null,
		source:
			snapshot.processing?.source == null
				? null
				: parse(sourceSchema, snapshot.processing.source),
		output:
			snapshot.processing?.output == null
				? null
				: parse(archivedReceiptSchema, snapshot.processing.output),
		verification:
			snapshot.processing?.verification == null
				? null
				: parse(verificationSchema, snapshot.processing.verification),
	};
}

export function requireLegacyOwnershipEvidence(snapshot: OwnershipSnapshot) {
	const { receipt } = ownershipEvidence(snapshot);
	const source = snapshot.video.source;
	if (source.type !== "desktopMP4" && source.type !== "webMP4")
		throw new OwnershipTransferError("UNSUPPORTED");
	const outputKey =
		source.outputKey ??
		`${snapshot.video.ownerId}/${snapshot.video.id}/result.mp4`;
	if (
		!receipt ||
		(receipt.outputKey ?? outputKey) !== outputKey ||
		(source.audioLevelOutputKey && source.audioLevelOutputKey !== outputKey)
	)
		throw new OwnershipTransferError("NOT_READY");
	return receipt;
}

export async function verifyOwnershipArchives(
	snapshot: OwnershipSnapshot,
	objects: TransferObject[],
	store: OwnershipMediaStore,
) {
	const evidence = ownershipEvidence(snapshot);
	const prefix = `${snapshot.video.ownerId}/${snapshot.video.id}/`;
	const byKey = new Map(objects.map((object) => [object.key, object]));
	const objectAt = (reference: string) => {
		requireOwnershipKey(reference, prefix);
		const object = byKey.get(reference);
		if (!object) throw new OwnershipTransferError("INVALID_REFERENCE");
		return object;
	};
	const jsonAt = async (reference: string, expectedHash: string) => {
		const object = objectAt(reference);
		if (object.sha256 !== expectedHash)
			throw new OwnershipTransferError("MEDIA_CHANGED");
		return store.readJson(object);
	};
	if (evidence.output) {
		const output = objectAt(evidence.output.outputKey ?? `${prefix}result.mp4`);
		if (
			output.size !== evidence.output.fileSize ||
			output.identity !== evidence.output.objectIdentity ||
			(evidence.output.outputSha256 &&
				output.sha256 !== evidence.output.outputSha256)
		)
			throw new OwnershipTransferError("MEDIA_CHANGED");
	}
	const source = evidence.source;
	if (!source) return;
	const inventory = parse(
		inventorySchema,
		await jsonAt(source.inventoryKey, source.inventorySha256),
	);
	if (
		inventory.kind !== source.kind ||
		inventory.manifestSha256 !== source.manifestSha256
	)
		throw new OwnershipTransferError("INVALID_REFERENCE");
	const entries: z.infer<typeof sourceObjectSchema>[] = [];
	if (inventory.version === 1) entries.push(...inventory.objects);
	else {
		const pending = [...inventory.roots];
		const visited = new Set<string>();
		const contiguous = (
			refs: z.infer<typeof pageReference>[],
			start: number,
			count: number,
		) => {
			let end = start;
			for (const ref of refs) {
				if (ref.start !== end)
					throw new OwnershipTransferError("INVALID_REFERENCE");
				end += ref.count;
			}
			if (end !== start + count)
				throw new OwnershipTransferError("INVALID_REFERENCE");
		};
		contiguous(pending, 0, inventory.objectCount);
		for (let index = 0; index < pending.length; index++) {
			const ref = pending[index];
			if (!ref || visited.has(ref.key) || pending.length > 20_000)
				throw new OwnershipTransferError("INVALID_REFERENCE");
			visited.add(ref.key);
			const page = parse(pageSchema, await jsonAt(ref.key, ref.sha256));
			if (page.scope !== inventory.scope)
				throw new OwnershipTransferError("INVALID_REFERENCE");
			if (page.type === "leaf") {
				if (
					ref.level !== 0 ||
					page.start !== ref.start ||
					page.entries.length !== ref.count
				)
					throw new OwnershipTransferError("INVALID_REFERENCE");
				entries.push(...page.entries);
			} else {
				contiguous(page.children, ref.start, ref.count);
				if (page.children.some((child) => child.level !== ref.level - 1))
					throw new OwnershipTransferError("INVALID_REFERENCE");
				pending.push(...page.children);
			}
		}
		if (entries.length !== inventory.objectCount)
			throw new OwnershipTransferError("INVALID_REFERENCE");
	}
	if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
		throw new OwnershipTransferError("INVALID_REFERENCE");
	for (const entry of entries) {
		const copied = objectAt(entry.key);
		const original = objectAt(entry.originalKey);
		if (
			copied.identity !== entry.objectIdentity ||
			original.identity !== entry.originalIdentity ||
			copied.size !== entry.size ||
			original.size !== entry.size ||
			copied.sha256 !== original.sha256
		)
			throw new OwnershipTransferError("MEDIA_CHANGED");
	}
	if (source.kind === "mp4") {
		const [entry] = entries;
		if (
			!source.mp4 ||
			entries.length !== 1 ||
			entry?.track !== "mp4" ||
			entry.size !== source.mp4.fileSize ||
			entry.originalIdentity !== source.mp4.objectIdentity
		)
			throw new OwnershipTransferError("INVALID_REFERENCE");
	} else {
		if (
			!source.manifestSha256 ||
			!source.inventoryKey.endsWith("/inventory.json")
		)
			throw new OwnershipTransferError("UNSUPPORTED");
		const manifest = parse(
			manifestSchema,
			await jsonAt(
				source.inventoryKey.replace(/inventory\.json$/, "manifest.json"),
				source.manifestSha256,
			),
		);
		for (const track of ["video", "audio"] as const) {
			const indexes = manifest[`${track}_segments`].map((item) =>
				typeof item === "number" ? item : item.index,
			);
			const expected =
				track === "video" || manifest.audio_init_uploaded
					? [0, ...indexes]
					: [];
			const actual = entries
				.filter((entry) => entry.track === track)
				.map((entry) => entry.index)
				.sort((a, b) => a - b);
			if (
				indexes.some((value, index) => value !== index + 1) ||
				actual.join() !== expected.join()
			)
				throw new OwnershipTransferError("INVALID_REFERENCE");
		}
		if (
			entries.some((entry) => entry.track === "mp4") ||
			manifest.audio_init_uploaded !== manifest.audio_segments.length > 0 ||
			(source.requiredAudio && !manifest.audio_init_uploaded)
		)
			throw new OwnershipTransferError("INVALID_REFERENCE");
	}
}
