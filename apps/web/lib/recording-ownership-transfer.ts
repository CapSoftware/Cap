import { createHash } from "node:crypto";
import type {
	comments,
	folders,
	spaces,
	videoEdits,
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import {
	openPreflight,
	type PreflightHead,
	type PreflightRequest,
	preflightHash,
	preflightHeadSchema,
	preflightReceiptSchema,
	requirePreflightReceipt,
} from "@cap/utils/recording-ownership-preflight";
import { resolveRecordingObjectKey } from "@cap/web-backend/src/Storage/recording-output";

import {
	OwnershipTransferError,
	ownershipEvidence,
	requireOwnershipKey as requireKey,
	requireLegacyOwnershipEvidence,
	verifyOwnershipArchives,
} from "@/lib/recording-ownership-evidence";

export { OwnershipTransferError } from "@/lib/recording-ownership-evidence";

export type OwnershipFolderAccess = {
	folders: Array<
		Pick<
			typeof folders.$inferSelect,
			| "id"
			| "organizationId"
			| "createdById"
			| "parentId"
			| "spaceId"
			| "public"
			| "updatedAt"
		>
	>;
	spaces: Array<
		Pick<
			typeof spaces.$inferSelect,
			"id" | "organizationId" | "public" | "privacy" | "updatedAt"
		>
	>;
};

export const OWNERSHIP_TRANSFER_MODE = "preserve_recording_sharing";
const MAX_OBJECTS = 10_000;
const SOURCE_KEYS = [
	"outputKey",
	"audioLevelOutputKey",
	"audioLevelSourceKey",
	"thumbnailKey",
	"previewKey",
] as const;

export type OwnershipSnapshot = {
	folderAccess: OwnershipFolderAccess | null;
	video: Pick<
		typeof videos.$inferSelect,
		| "id"
		| "orgId"
		| "ownerId"
		| "folderId"
		| "bucket"
		| "storageIntegrationId"
		| "source"
		| "metadata"
		| "transcriptionStatus"
		| "jobStatus"
		| "isScreenshot"
		| "duration"
	>;
	upload: typeof videoUploads.$inferSelect | null;
	edit: typeof videoEdits.$inferSelect | null;
	processing: typeof videoProcessingJobs.$inferSelect | null;
	comments: Array<
		Pick<
			typeof comments.$inferSelect,
			"id" | "mediaKey" | "mediaMeta" | "updatedAt"
		>
	>;
};

export type TransferObject = {
	versionId?: string | null;
	key: string;
	size: number;
	identity: string;
	sha256: string;
	contentType: string;
	metadataHash: string;
	copyMetadataHash: string;
};

export type OwnershipMediaStore = {
	head?: (key: string) => Promise<PreflightHead>;
	signRead?: (key: string, versionId: string | null) => Promise<string>;
	list: (prefix: string) => Promise<string[]>;
	inspect: (key: string) => Promise<TransferObject>;
	readJson: (object: TransferObject) => Promise<unknown>;
	copyIfAbsent: (
		source: TransferObject,
		destinationKey: string,
	) => Promise<void>;
};

export type OwnershipFields = Pick<
	OwnershipSnapshot["video"],
	"ownerId" | "folderId" | "source"
> & {
	desktopRecordingUpload: NonNullable<
		OwnershipSnapshot["video"]["metadata"]
	>["desktopRecordingUpload"];
	agentUpload: NonNullable<
		OwnershipSnapshot["video"]["metadata"]
	>["agentUpload"];
	rawFileKey: string | null;
	editSourceKey: string | null;
	comments: Array<
		Pick<OwnershipSnapshot["comments"][number], "id" | "mediaKey" | "mediaMeta">
	>;
};

export type OwnershipTransferPlan = {
	version: 1;
	videoId: string;
	organizationId: string;
	bucketId: string | null;
	before: OwnershipFields;
	targetUserId: string;
	destinationFolderId: string | null;
	snapshotHash: string;
	objects: TransferObject[];
	originalFolderHash: string;
	completion: "upload" | "legacy-receipt" | "preflight";
	preflight?: string;
};

function canonical(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, item]) => item !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}
	return value;
}

export function ownershipHash(value: unknown) {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

export function ownershipCopyMetadata(
	metadata: Record<string, string | undefined>,
) {
	const validators: Record<string, RegExp> = {
		duration: /^\d+(\.\d+)?$/,
		bandwidth: /^\d+$/,
		resolution: /^\d+x\d+$/,
		videocodec:
			/^(avc1(?:\.[a-fA-F0-9]+)?|h264|hevc|h265|vp8|vp9|av1|av01(?:\.[a-zA-Z0-9]+)*)$/,
		audiocodec: /^(aac|mp4a(?:\.\d+)*|opus|vorbis|mp3|pcm_s16le|flac)$/,
		"cap-source-identity": /^[a-f0-9]{64}$/,
		"cap-source-size": /^\d+$/,
		"cap-source-key": /^[a-f0-9]{64}$/,
	};
	return Object.fromEntries(
		Object.entries(metadata).flatMap(([key, value]) => {
			const normalized = key.toLowerCase();
			return value !== undefined && validators[normalized]?.test(value)
				? [[normalized, value]]
				: [];
		}),
	);
}

export function ownershipFields(snapshot: OwnershipSnapshot): OwnershipFields {
	return {
		ownerId: snapshot.video.ownerId,
		folderId: snapshot.video.folderId,
		source: snapshot.video.source,
		desktopRecordingUpload: snapshot.video.metadata?.desktopRecordingUpload,
		agentUpload: snapshot.video.metadata?.agentUpload,
		rawFileKey: snapshot.upload?.rawFileKey ?? null,
		editSourceKey: snapshot.edit?.sourceKey ?? null,
		comments: snapshot.comments.map(({ id, mediaKey, mediaMeta }) => ({
			id,
			mediaKey,
			mediaMeta,
		})),
	};
}

export function requireTransferQuiescent(snapshot: OwnershipSnapshot) {
	const { video, upload, processing } = snapshot;
	const metadata = video.metadata;
	if (
		(upload &&
			(upload.phase !== "complete" ||
				(upload.total > 0 && upload.uploaded < upload.total))) ||
		(processing && processing.leaseExpiresAt !== null) ||
		(processing &&
			processing.state !== "verified" &&
			!(
				processing.state === "source-blocked" &&
				processing.errorCode === "output-replaced" &&
				processing.attemptId === null &&
				processing.leaseExpiresAt === null &&
				processing.remoteJobId === null &&
				processing.workflowRunId === null
			)) ||
		metadata?.editProcessing ||
		(metadata?.agentUpload && metadata.agentUpload.state !== "accepted") ||
		(metadata?.liveTranscript &&
			!["complete", "stopped"].includes(metadata.liveTranscript.status)) ||
		(metadata?.enhancedAudioStatus &&
			!["COMPLETE", "ERROR", "SKIPPED"].includes(
				metadata.enhancedAudioStatus,
			)) ||
		(metadata?.aiGenerationStatus &&
			!["COMPLETE", "ERROR", "SKIPPED"].includes(
				metadata.aiGenerationStatus,
			)) ||
		!["COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO"].includes(
			video.transcriptionStatus ?? "",
		) ||
		(video.jobStatus && video.jobStatus !== "COMPLETE")
	) {
		throw new OwnershipTransferError("NOT_READY");
	}
	if (
		video.storageIntegrationId ||
		video.isScreenshot ||
		(video.source.type !== "desktopMP4" && video.source.type !== "webMP4") ||
		Object.keys(video.source).some(
			(key) =>
				key !== "type" && !SOURCE_KEYS.some((allowed) => allowed === key),
		)
	) {
		throw new OwnershipTransferError("UNSUPPORTED");
	}
	ownershipEvidence(snapshot);
}

export function requireTransferReady(snapshot: OwnershipSnapshot) {
	requireTransferQuiescent(snapshot);
	const upload = snapshot.upload;
	if (!upload) requireLegacyOwnershipEvidence(snapshot);
	return upload ? ("upload" as const) : ("legacy-receipt" as const);
}

function requireObject(object: TransferObject, prefix: string) {
	requireKey(object.key, prefix);
	if (
		!Number.isSafeInteger(object.size) ||
		object.size <= 0 ||
		!object.identity ||
		![object.sha256, object.metadataHash, object.copyMetadataHash].every(
			(hash) => /^[a-f0-9]{64}$/.test(hash),
		)
	) {
		throw new OwnershipTransferError("INVALID_REFERENCE");
	}
}

function requireSnapshotReferenceKeys(
	snapshot: OwnershipSnapshot,
	keys: Set<string>,
) {
	const { video } = snapshot;
	const prefix = `${video.ownerId}/${video.id}/`;
	const source = video.source;
	if (source.type !== "webMP4" && source.type !== "desktopMP4") {
		throw new OwnershipTransferError("UNSUPPORTED");
	}
	const references = [
		source.outputKey ?? `${prefix}result.mp4`,
		...SOURCE_KEYS.map((key) => source[key]),
		snapshot.upload?.rawFileKey,
		snapshot.edit?.sourceKey,
		video.metadata?.desktopRecordingUpload?.outputKey,
		video.metadata?.agentUpload?.rawFileKey,
		...snapshot.comments.flatMap((comment) => [
			comment.mediaKey,
			comment.mediaMeta?.thumbnailKey,
		]),
	];
	for (const reference of references) {
		if (reference === undefined || reference === null) continue;
		requireKey(reference, prefix);
		if (!keys.has(reference)) {
			throw new OwnershipTransferError("INVALID_REFERENCE");
		}
	}
}

export function requireSnapshotReferences(
	snapshot: OwnershipSnapshot,
	objects: TransferObject[],
) {
	requireSnapshotReferenceKeys(
		snapshot,
		new Set(objects.map((object) => object.key)),
	);
	const { video } = snapshot;
	const source = video.source;
	if (source.type !== "webMP4" && source.type !== "desktopMP4")
		throw new OwnershipTransferError("UNSUPPORTED");
	const prefix = `${video.ownerId}/${video.id}/`;
	const receipt = video.metadata?.desktopRecordingUpload;
	if (receipt) {
		const key = receipt.outputKey ?? source.outputKey ?? `${prefix}result.mp4`;
		const output = objects.find((object) => object.key === key);
		if (
			!output ||
			output.size !== receipt.fileSize ||
			output.identity !== receipt.objectIdentity ||
			(receipt.outputSha256 && receipt.outputSha256 !== output.sha256)
		) {
			throw new OwnershipTransferError("MEDIA_CHANGED");
		}
	}
}

export async function inspectTransferMedia(
	store: OwnershipMediaStore,
	prefix: string,
) {
	const keys = await store.list(prefix);
	if (keys.length === 0 || keys.length > MAX_OBJECTS) {
		throw new OwnershipTransferError("INVALID_REFERENCE");
	}
	if (new Set(keys).size !== keys.length) {
		throw new OwnershipTransferError("INVALID_REFERENCE");
	}
	const objects: TransferObject[] = [];
	for (const key of keys.sort()) {
		requireKey(key, prefix);
		const object = await store.inspect(key);
		requireObject(object, prefix);
		if (object.key !== key)
			throw new OwnershipTransferError("INVALID_REFERENCE");
		objects.push(object);
	}
	return objects;
}

export function ownershipDestinationFolder(
	snapshot: OwnershipSnapshot,
	destination: string | null,
) {
	const original = snapshot.folderAccess?.folders[0];
	if (original?.public && original.spaceId === null) {
		if (destination !== null && destination !== original.id)
			throw new OwnershipTransferError("UNSUPPORTED");
		return original.id;
	}
	return destination;
}

export async function inspectOwnershipHeads(
	store: OwnershipMediaStore,
	prefix: string,
) {
	if (!store.head) throw new OwnershipTransferError("UNSUPPORTED");
	const keys = (await store.list(prefix)).sort();
	if (
		!keys.length ||
		keys.length > MAX_OBJECTS ||
		new Set(keys).size !== keys.length
	)
		throw new OwnershipTransferError("INVALID_REFERENCE");
	const heads: PreflightHead[] = [];
	for (const key of keys) {
		requireKey(key, prefix);
		const head = preflightHeadSchema.parse(await store.head(key));
		if (head.key !== key) throw new OwnershipTransferError("INVALID_REFERENCE");
		heads.push(head);
	}
	return heads;
}

export function ownershipPreflightBinding(
	snapshot: OwnershipSnapshot,
	target: string,
	destination: string | null,
	manifest: PreflightHead[],
): Pick<
	PreflightRequest,
	"context" | "manifest" | "assets" | "base" | "selected"
> {
	requireTransferQuiescent(snapshot);
	requireSnapshotReferenceKeys(
		snapshot,
		new Set(manifest.map((object) => object.key)),
	);
	const source = snapshot.video.source;
	if (source.type !== "webMP4" && source.type !== "desktopMP4")
		throw new OwnershipTransferError("UNSUPPORTED");
	const prefix = `${snapshot.video.ownerId}/${snapshot.video.id}/`;
	const base = source.outputKey ?? `${prefix}result.mp4`;
	const selected = resolveRecordingObjectKey(
		snapshot.video,
		`${prefix}result.mp4`,
	);
	if (
		source.audioLevelOutputKey &&
		(selected !== source.audioLevelOutputKey ||
			source.audioLevelSourceKey !== base)
	)
		throw new OwnershipTransferError("INVALID_REFERENCE");
	const requiredAudio =
		ownershipEvidence(snapshot).verification?.requiredAudio === true ||
		snapshot.video.metadata?.desktopRecordingUpload?.hasAudio === true;
	const assets = new Map<string, number | null>([
		[base, snapshot.video.duration ?? null],
		[selected, snapshot.video.duration ?? null],
	]);
	for (const key of [
		snapshot.edit?.sourceKey,
		snapshot.upload?.rawFileKey,
		snapshot.video.metadata?.agentUpload?.rawFileKey,
	]) {
		if (key && !assets.has(key))
			assets.set(
				key,
				snapshot.edit?.sourceKey === key
					? snapshot.edit.editSpec.sourceDuration
					: null,
			);
	}
	for (const key of assets.keys()) {
		requireKey(key, prefix);
		if (!manifest.some((object) => object.key === key))
			throw new OwnershipTransferError("INVALID_REFERENCE");
	}
	return {
		context: ownershipHash({
			snapshot,
			target,
			destination: ownershipDestinationFolder(snapshot, destination),
		}),
		manifest,
		assets: [...assets]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, expectedDuration]) => ({
				ref: preflightHash(key),
				expectedDuration,
				requiredAudio,
			})),
		base: preflightHash(base),
		selected: preflightHash(selected),
	};
}

export function requireOwnershipPlanReady(
	snapshot: OwnershipSnapshot,
	plan: OwnershipTransferPlan,
	secret?: string,
) {
	if (!plan.preflight) return requireTransferReady(snapshot);
	if (!secret) throw new OwnershipTransferError("NOT_READY");
	const receipt = openPreflight(
		"receipt",
		plan.preflight,
		secret,
		preflightReceiptSchema,
	);
	const binding = ownershipPreflightBinding(
		snapshot,
		plan.targetUserId,
		plan.destinationFolderId,
		plan.objects.map(({ sha256: _sha256, ...head }) =>
			preflightHeadSchema.parse(head),
		),
	);
	requirePreflightReceipt(receipt, binding);
	if (
		plan.objects.some(
			(object) =>
				receipt.objects.find(
					(verified) => verified.ref === preflightHash(object.key),
				)?.sha256 !== object.sha256,
		)
	)
		throw new OwnershipTransferError("MEDIA_CHANGED");
	return "preflight" as const;
}

export async function planOwnershipTransfer(
	snapshot: OwnershipSnapshot,
	targetUserId: string,
	destinationFolderId: string | null,
	store: OwnershipMediaStore,
	preflight?: { token: string; secret: string },
): Promise<OwnershipTransferPlan> {
	requireTransferQuiescent(snapshot);
	const completion = preflight ? "preflight" : requireTransferReady(snapshot);
	destinationFolderId = ownershipDestinationFolder(
		snapshot,
		destinationFolderId,
	);
	if (targetUserId === snapshot.video.ownerId) {
		throw new OwnershipTransferError("UNSUPPORTED");
	}
	const prefix = `${snapshot.video.ownerId}/${snapshot.video.id}/`;
	let objects: TransferObject[];
	if (preflight) {
		const manifest = await inspectOwnershipHeads(store, prefix);
		const receipt = openPreflight(
			"receipt",
			preflight.token,
			preflight.secret,
			preflightReceiptSchema,
		);
		requirePreflightReceipt(
			receipt,
			ownershipPreflightBinding(
				snapshot,
				targetUserId,
				destinationFolderId,
				manifest,
			),
		);
		objects = manifest.map((head) => {
			const verified = receipt.objects.find(
				(object) => object.ref === preflightHash(head.key),
			);
			if (!verified) throw new OwnershipTransferError("INVALID_REFERENCE");
			return { ...head, sha256: verified.sha256 };
		});
	} else objects = await inspectTransferMedia(store, prefix);
	requireSnapshotReferences(snapshot, objects);
	await verifyOwnershipArchives(snapshot, objects, store);
	const plan: OwnershipTransferPlan = {
		version: 1,
		videoId: snapshot.video.id,
		organizationId: snapshot.video.orgId,
		bucketId: snapshot.video.bucket,
		before: ownershipFields(snapshot),
		targetUserId,
		destinationFolderId,
		snapshotHash: ownershipHash(snapshot),
		objects,
		completion,
		...(preflight ? { preflight: preflight.token } : {}),
		originalFolderHash: ownershipHash(snapshot.folderAccess),
	};
	const stable = preflight
		? await inspectOwnershipHeads(store, prefix)
		: await inspectTransferMedia(store, prefix);
	const expected = preflight
		? objects.map(({ sha256: _sha256, ...head }) => head)
		: objects;
	if (ownershipHash(stable) !== ownershipHash(expected))
		throw new OwnershipTransferError("MEDIA_CHANGED");
	await verifyExistingDestinations(plan, store);
	return plan;
}

function destinationKey(plan: OwnershipTransferPlan, key: string) {
	const prefix = `${plan.before.ownerId}/${plan.videoId}/`;
	requireKey(key, prefix);
	return `${plan.targetUserId}/${plan.videoId}/${key.slice(prefix.length)}`;
}

function sameContent(a: TransferObject, b: TransferObject) {
	return (
		a.size === b.size &&
		a.sha256 === b.sha256 &&
		a.contentType === b.contentType &&
		a.copyMetadataHash === b.metadataHash
	);
}

async function verifyExistingDestinations(
	plan: OwnershipTransferPlan,
	store: OwnershipMediaStore,
) {
	const expected = new Map(
		plan.objects.map((object) => [destinationKey(plan, object.key), object]),
	);
	const existing = await store.list(`${plan.targetUserId}/${plan.videoId}/`);
	for (const key of existing) {
		const source = expected.get(key);
		if (!source || !sameContent(source, await store.inspect(key))) {
			throw new OwnershipTransferError("DESTINATION_CONFLICT");
		}
	}
	return new Set(existing);
}

export async function verifyTransferMedia(
	plan: OwnershipTransferPlan,
	store: OwnershipMediaStore,
	destinations?: TransferObject[],
) {
	const source = await inspectTransferMedia(
		store,
		`${plan.before.ownerId}/${plan.videoId}/`,
	);
	if (ownershipHash(source) !== ownershipHash(plan.objects)) {
		throw new OwnershipTransferError("MEDIA_CHANGED");
	}
	if (destinations) {
		const current = await inspectTransferMedia(
			store,
			`${plan.targetUserId}/${plan.videoId}/`,
		);
		if (ownershipHash(current) !== ownershipHash(destinations)) {
			throw new OwnershipTransferError("MEDIA_CHANGED");
		}
	}
}

export async function copyOwnershipMedia(
	plan: OwnershipTransferPlan,
	store: OwnershipMediaStore,
) {
	await verifyTransferMedia(plan, store);
	const existing = await verifyExistingDestinations(plan, store);
	const destinations: TransferObject[] = [];
	for (const object of plan.objects) {
		const key = destinationKey(plan, object.key);
		if (!existing.has(key)) {
			try {
				await store.copyIfAbsent(object, key);
			} catch {
				// A lost copy response is resolved by readback, including content,
				// before any database publication. Never overwrite on retry.
				if (!sameContent(object, await store.inspect(key))) {
					throw new OwnershipTransferError("DESTINATION_CONFLICT");
				}
			}
		}
		const copied = await store.inspect(key);
		if (!sameContent(object, copied)) {
			throw new OwnershipTransferError("DESTINATION_CONFLICT");
		}
		destinations.push(copied);
	}
	await verifyTransferMedia(plan, store, destinations);
	return destinations;
}

export function transferredOwnershipFields(
	plan: OwnershipTransferPlan,
	destinations: TransferObject[],
): OwnershipFields {
	const rewrite = (key: string | undefined | null) =>
		key == null ? key : destinationKey(plan, key);
	const source = { ...plan.before.source };
	if (source.type !== "webMP4" && source.type !== "desktopMP4") {
		throw new OwnershipTransferError("UNSUPPORTED");
	}
	for (const key of SOURCE_KEYS) {
		if (source[key] !== undefined)
			source[key] = rewrite(source[key]) ?? undefined;
	}
	const recording = plan.before.desktopRecordingUpload;
	const outputKey =
		rewrite(recording?.outputKey) ??
		source.outputKey ??
		`${plan.targetUserId}/${plan.videoId}/result.mp4`;
	const output = destinations.find((object) => object.key === outputKey);
	if (!output) throw new OwnershipTransferError("INVALID_REFERENCE");
	return {
		ownerId: plan.targetUserId as OwnershipFields["ownerId"],
		folderId: plan.destinationFolderId as OwnershipFields["folderId"],
		source,
		rawFileKey: rewrite(plan.before.rawFileKey) ?? null,
		editSourceKey: rewrite(plan.before.editSourceKey) ?? null,
		comments: plan.before.comments.map((comment) => ({
			...comment,
			mediaKey: rewrite(comment.mediaKey) ?? null,
			mediaMeta: comment.mediaMeta
				? {
						...comment.mediaMeta,
						thumbnailKey: rewrite(comment.mediaMeta.thumbnailKey) ?? undefined,
					}
				: null,
		})),
		desktopRecordingUpload: recording
			? {
					...recording,
					outputKey,
					outputSha256: output.sha256,
					objectIdentity: output.identity,
					...(recording.artifact.kind === "mp4"
						? {
								sourceObjectIdentity:
									recording.sourceObjectIdentity ??
									recording.artifact.objectIdentity,
							}
						: {}),
				}
			: undefined,
		agentUpload: plan.before.agentUpload
			? {
					...plan.before.agentUpload,
					rawFileKey: rewrite(plan.before.agentUpload.rawFileKey) ?? undefined,
				}
			: undefined,
	};
}
