import { createHash } from "node:crypto";
import { GoogleDriveRequestError } from "@cap/web-backend/src/Storage/GoogleDrive";
import { Storage as StorageDomain } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DesktopRecordingSourceCheckpoint } from "@/lib/desktop-recording-source-checkpoint";
import type { RecordingVerification } from "@/lib/desktop-recording-verification";

const mocks = vi.hoisted(() => ({
	storage: vi.fn(),
	pageSize: undefined as number | undefined,
	treePageSize: undefined as number | undefined,
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.storage },
}));
vi.mock("@/lib/desktop-recording-source-checkpoint", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@/lib/desktop-recording-source-checkpoint")
		>();
	return {
		...actual,
		get SOURCE_COMMIT_PAGE_SIZE() {
			return mocks.pageSize ?? actual.SOURCE_COMMIT_PAGE_SIZE;
		},
		get SOURCE_COMMIT_AWS_PAGE_SIZE() {
			return mocks.pageSize ?? actual.SOURCE_COMMIT_AWS_PAGE_SIZE;
		},
		get SOURCE_COMMIT_TREE_PAGE_SIZE() {
			return mocks.treePageSize ?? actual.SOURCE_COMMIT_TREE_PAGE_SIZE;
		},
	};
});
vi.mock("@/lib/workflow-runtime", async () => {
	const { Effect } = await import("effect");
	return { runWorkflowPromise: Effect.runPromise };
});
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

import {
	advanceDesktopRecordingSourceCommit,
	buildDesktopRecordingSourceUrls,
	commitDesktopRecordingSource,
	DesktopRecordingSourceError,
	getDesktopRecordingOutputKey,
	prepareDesktopRecordingSegments,
} from "@/lib/desktop-recording-source";

type VideoRow = Parameters<typeof commitDesktopRecordingSource>[0];
type StoredObject = {
	identity: string;
	size: number;
	body?: string;
	metadata?: Record<string, string>;
};
type CopyOptions = {
	CopySourceIfMatch?: string;
	IfNoneMatch?: string;
	Metadata?: Record<string, string>;
};
type CopyPartOptions = CopyOptions & {
	CopySource: string;
	CopySourceRange: string;
};
type CopiedPart = {
	number: number;
	start: number;
	end: number;
	identity: string;
	sourceKey: string;
};

const prefix = "owned-user/owned-video";
const manifestKey = `${prefix}/segments/manifest.json`;
const videoInitKey = `${prefix}/segments/video/init.mp4`;
const audioInitKey = `${prefix}/segments/audio/init.mp4`;
const generation = "a4241ba5-b520-483f-ad97-b8e5ce0950e3";
const attempt = "4d7653bb-9cdd-47e2-be3b-d1df01838f79";
const inventorySchema = z
	.object({
		objects: z.array(
			z
				.object({
					key: z.string(),
					originalKey: z.string(),
					originalIdentity: z.string(),
					objectIdentity: z.string(),
					size: z.number(),
				})
				.passthrough(),
		),
	})
	.passthrough();

function hash(content: string) {
	return createHash("sha256").update(content).digest("hex");
}

function checked<T>(operation: () => T): Effect.Effect<T, Error> {
	return Effect.try({
		try: operation,
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});
}

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function recording(source: VideoRow["source"] = { type: "desktopSegments" }) {
	return { id: "owned-video", ownerId: "owned-user", source } as VideoRow;
}

function storageFixture(provider = "s3", customBucket = false) {
	const objects = new Map<string, StoredObject>();
	const uploads = new Map<
		string,
		{ key: string; parts: CopiedPart[]; metadata?: Record<string, string> }
	>();
	let identity = 0;
	const object = (key: string) => {
		const value = objects.get(key);
		if (!value)
			throw Object.assign(new Error(`Object missing: ${key}`), {
				name: "NoSuchKey",
			});
		return value;
	};
	const copiedSource = (source: string, options: CopyOptions) => {
		if (!source.startsWith("recordings/")) throw new Error("Wrong bucket");
		const key = source.slice("recordings/".length);
		const value = object(key);
		if (
			provider === "s3" &&
			options.CopySourceIfMatch !== undefined &&
			options.CopySourceIfMatch !== value.identity
		) {
			throw new Error("Copy source precondition failed");
		}
		return { key, value };
	};
	const seed = (key: string, body: string) => {
		objects.set(key, {
			body,
			size: Buffer.byteLength(body),
			identity: `"original-${++identity}"`,
		});
	};
	const bucket = {
		bucketName: "recordings",
		provider,
		getObject: vi.fn((key: string) =>
			checked(() => Option.fromNullable(objects.get(key)?.body)),
		),
		headObject: vi.fn((key: string) =>
			checked(() => {
				const value = object(key);
				return {
					ContentLength: value.size,
					ETag: value.identity,
					Metadata: value.metadata,
					...(provider === "googleDrive"
						? { RecordingContentSHA256: hash(value.body ?? String(value.size)) }
						: {}),
				};
			}),
		),
		putObject: vi.fn((key: string, body: string) =>
			checked(() => {
				seed(key, body);
			}),
		),
		...(provider === "googleDrive"
			? {
					putObjectWithChecksum: vi.fn((key: string, body: string) =>
						checked(() => {
							seed(key, body);
							return {
								sha256Checksum: hash(objects.get(key)?.body ?? ""),
							} as { sha256Checksum: string | null };
						}),
					),
				}
			: {}),
		copyObject: vi.fn((source: string, target: string, options: CopyOptions) =>
			checked(() => {
				const { value } = copiedSource(source, options);
				if (
					provider === "s3" &&
					options.IfNoneMatch === "*" &&
					objects.has(target)
				) {
					throw new Error("Copy destination already exists");
				}
				const copied = {
					...value,
					identity: `"snapshot-${++identity}"`,
					metadata: provider === "s3" ? options.Metadata : undefined,
				};
				objects.set(target, copied);
				return { CopyObjectResult: { ETag: copied.identity } };
			}),
		),
		listObjects: vi.fn(
			({
				prefix: filter,
				maxKeys = 32,
				continuationToken,
			}: {
				prefix?: string;
				maxKeys?: number;
				continuationToken?: string;
			}) =>
				checked(() => {
					const keys = [...objects.keys()]
						.filter((key) => !filter || key.startsWith(filter))
						.sort();
					const start = continuationToken ? Number(continuationToken) : 0;
					return {
						Contents: keys
							.slice(start, start + maxKeys)
							.map((Key) => ({ Key })),
						IsTruncated: start + maxKeys < keys.length,
						NextContinuationToken:
							start + maxKeys < keys.length
								? String(start + maxKeys)
								: undefined,
					};
				}),
		),
		getInternalSignedObjectUrl: vi.fn((key: string) =>
			checked(() => `https://storage.example/${key}?signed=1`),
		),
		multipart: {
			create: vi.fn(
				(key: string, options?: { Metadata?: Record<string, string> }) =>
					checked(() => {
						const uploadId = `upload-${++identity}`;
						uploads.set(uploadId, {
							key,
							parts: [],
							metadata: options?.Metadata,
						});
						return { UploadId: uploadId };
					}),
			),
			copyPart: vi.fn(
				(
					key: string,
					uploadId: string,
					partNumber: number,
					options: CopyPartOptions,
				) =>
					checked(() => {
						const upload = uploads.get(uploadId);
						if (!upload || upload.key !== key)
							throw Object.assign(new Error("Unknown upload"), {
								name: "NoSuchUpload",
							});
						const source = copiedSource(options.CopySource, options);
						const range = /^bytes=(\d+)-(\d+)$/.exec(options.CopySourceRange);
						if (!range) throw new Error("Invalid copy range");
						const start = Number(range[1]);
						const end = Number(range[2]);
						if (start > end || end >= source.value.size) {
							throw new Error("Copy range exceeds source");
						}
						const partIdentity = `"part-${partNumber}"`;
						upload.parts = upload.parts.filter(
							(part) => part.number !== partNumber,
						);
						upload.parts.push({
							number: partNumber,
							start,
							end,
							identity: partIdentity,
							sourceKey: source.key,
						});
						return { CopyPartResult: { ETag: partIdentity } };
					}),
			),
			complete: vi.fn(
				(
					key: string,
					uploadId: string,
					options: {
						IfNoneMatch?: string;
						MultipartUpload: { Parts: { ETag: string; PartNumber: number }[] };
					},
				) =>
					checked(() => {
						const upload = uploads.get(uploadId);
						if (!upload || upload.key !== key)
							throw Object.assign(new Error("Unknown upload"), {
								name: "NoSuchUpload",
							});
						if (options.IfNoneMatch === "*" && objects.has(key)) {
							throw new Error("Copy destination already exists");
						}
						let next = 0;
						for (const [index, part] of upload.parts
							.sort((left, right) => left.number - right.number)
							.entries()) {
							const requested = options.MultipartUpload.Parts[index];
							if (
								part.start !== next ||
								requested?.ETag !== part.identity ||
								requested.PartNumber !== part.number
							) {
								throw new Error("Incomplete multipart copy");
							}
							next = part.end + 1;
						}
						const first = upload.parts[0];
						if (!first) throw new Error("Empty multipart copy");
						const source = object(first.sourceKey);
						if (next !== source.size)
							throw new Error("Source tail was omitted");
						const copied = {
							...source,
							identity: `"snapshot-${++identity}"`,
							metadata: upload.metadata,
						};
						objects.set(key, copied);
						uploads.delete(uploadId);
						return { ETag: copied.identity };
					}),
			),
			abort: vi.fn((key: string, uploadId: string) =>
				checked(() => {
					if (uploads.get(uploadId)?.key !== key)
						throw new Error("Wrong abort");
					uploads.delete(uploadId);
				}),
			),
		},
	};
	mocks.storage.mockReturnValue(
		Effect.succeed([
			bucket,
			customBucket ? Option.some({ id: "custom-bucket" }) : Option.none(),
		]),
	);
	return { bucket, objects, uploads, seed, object };
}

function snapshotCheckpoint(): DesktopRecordingSourceCheckpoint {
	return {
		kind: "desktop-recording-source-commit",
		version: 1,
		generation,
		snapshotId: "snapshot",
		revision: 0,
		phase: "plan",
		cursor: 0,
		planRoots: [],
		receiptRoots: [],
	};
}

async function advanceToPhase(
	video: VideoRow,
	checkpoint: DesktopRecordingSourceCheckpoint,
	phase: DesktopRecordingSourceCheckpoint["phase"],
) {
	while (checkpoint.phase !== phase) {
		const result = await advanceDesktopRecordingSourceCommit(video, checkpoint);
		if ("source" in result) throw new Error("Unexpected source completion");
		checkpoint = result.checkpoint;
	}
	return checkpoint;
}

async function finishSnapshot(
	video: VideoRow,
	checkpoint: DesktopRecordingSourceCheckpoint,
) {
	for (;;) {
		const result = await advanceDesktopRecordingSourceCommit(video, checkpoint);
		if ("source" in result) return result.source;
		checkpoint = result.checkpoint;
	}
}

function readInventory(
	storage: ReturnType<typeof storageFixture>,
	inventoryKey: string,
) {
	const raw = JSON.parse(storage.object(inventoryKey).body ?? "");
	if (raw.version === 1) return inventorySchema.parse(raw);
	const node = z.discriminatedUnion("type", [
		z.object({ type: z.literal("leaf"), entries: z.array(z.unknown()) }),
		z.object({
			type: z.literal("branch"),
			children: z.array(z.object({ key: z.string() })),
		}),
	]);
	const entries = (key: string): unknown[] => {
		const page = node.parse(JSON.parse(storage.object(key).body ?? ""));
		return page.type === "leaf"
			? page.entries
			: page.children.flatMap((child) => entries(child.key));
	};
	const roots = z
		.object({ roots: z.array(z.object({ key: z.string() })) })
		.parse(raw).roots;
	return inventorySchema.parse({
		...raw,
		version: 1,
		objects: roots.flatMap((root) => entries(root.key)),
	});
}

function seedSegments(
	storage: ReturnType<typeof storageFixture>,
	entries: (number | { index: number; duration: number })[] = [1, 2],
	hasAudio = true,
) {
	const manifest = {
		version: 2,
		video_init_uploaded: true,
		audio_init_uploaded: hasAudio,
		video_segments: entries,
		audio_segments: hasAudio ? [1] : [],
		is_complete: true,
	};
	const json = `${JSON.stringify(manifest, null, 2)}\n`;
	storage.seed(manifestKey, json);
	storage.seed(videoInitKey, "video-init");
	for (const entry of entries) {
		const index = typeof entry === "number" ? entry : entry.index;
		storage.seed(
			`${prefix}/segments/video/segment_${String(index).padStart(3, "0")}.m4s`,
			`video-fragment-${index}`,
		);
	}
	if (hasAudio) {
		storage.seed(audioInitKey, "audio-init");
		storage.seed(
			`${prefix}/segments/audio/segment_001.m4s`,
			"audio-fragment-1",
		);
	}
	const verification: RecordingVerification = {
		version: 1,
		artifact: { kind: "segments", manifestSha256: hash(json) },
		requiredAudio: false,
	};
	return { json, manifest, verification };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.pageSize = undefined;
	mocks.treePageSize = undefined;
});

describe("recording source preparation during upload", () => {
	it.each(["missing", "corrupt", "unknown-version"])(
		"keeps normal finalization available with a %s preparation marker",
		async (mutation) => {
			const storage = storageFixture();
			seedSegments(storage, [1], false);
			await prepareDesktopRecordingSegments(
				recording(),
				[{ track: "video", index: 1 }],
				async () => true,
			);
			const marker = `${prefix}/.recording/sources/preparation.json`;
			if (mutation === "missing") storage.objects.delete(marker);
			else
				storage.seed(
					marker,
					mutation === "corrupt" ? "invalid" : JSON.stringify({ version: 2 }),
				);
			const source = await commitDesktopRecordingSource(
				recording(),
				generation,
			);
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(3);
			expect(
				readInventory(storage, source.inventoryKey).objects.every(
					(entry) => !entry.key.includes("/prepared/"),
				),
			).toBe(true);
			expect(
				storage.object(`${prefix}/segments/video/segment_001.m4s`).body,
			).toBe("video-fragment-1");
		},
	);

	it("bounds a stalled recording-state check before copying fragments", async () => {
		vi.useFakeTimers();
		try {
			const storage = storageFixture();
			seedSegments(storage, [1], false);
			const result = prepareDesktopRecordingSegments(
				recording(),
				[{ track: "video", index: 1 }],
				() => new Promise<boolean>(() => {}),
			);
			const rejected = expect(result).rejects.toThrow("timed out");
			await vi.advanceTimersByTimeAsync(5_001);
			await rejected;
			expect(storage.bucket.copyObject).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not acknowledge stalled storage or hold the request indefinitely", async () => {
		vi.useFakeTimers();
		try {
			const storage = storageFixture();
			seedSegments(storage, [1, 2, 3, 4, 5], false);
			storage.bucket.headObject.mockImplementation(() => Effect.never);
			const result = prepareDesktopRecordingSegments(
				recording(),
				Array.from({ length: 5 }, (_, index) => ({
					track: "video" as const,
					index: index + 1,
				})),
				async () => true,
			);
			await vi.advanceTimersByTimeAsync(15_001);
			expect(await result).toEqual([]);
			expect(storage.bucket.copyObject).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	for (const provider of ["s3", "googleDrive"]) {
		it(`reuses ${provider} copies after Stop without copying media twice`, async () => {
			const storage = storageFixture(provider);
			const { manifest } = seedSegments(storage);
			storage.seed(
				manifestKey,
				JSON.stringify({ ...manifest, is_complete: false }),
			);
			const requested = [
				{ track: "video" as const, index: 1 },
				{ track: "video" as const, index: 2 },
				{ track: "audio" as const, index: 1 },
			];
			expect(
				await prepareDesktopRecordingSegments(
					recording(),
					requested,
					async () => true,
				),
			).toEqual(requested);
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(3);
			await prepareDesktopRecordingSegments(
				recording(),
				[...requested, { track: "video", index: 1 }],
				async () => true,
			);
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(3);
			storage.seed(
				manifestKey,
				JSON.stringify({
					...manifest,
				}),
			);
			const source = await commitDesktopRecordingSource(
				recording(),
				generation,
			);
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(5);
			const inventory = readInventory(storage, source.inventoryKey);
			expect(
				inventory.objects.filter((entry) => entry.key.includes("/prepared/")),
			).toHaveLength(3);
			expect(storage.object(videoInitKey).body).toBe("video-init");
			const urls = await buildDesktopRecordingSourceUrls(recording(), source);
			expect(urls.videoSegmentUrls).toHaveLength(2);
		});
	}

	it("leaves late fragments for normal finalization", async () => {
		const storage = storageFixture();
		const { manifest } = seedSegments(storage, [1], false);
		const prepared = await prepareDesktopRecordingSegments(
			recording(),
			[
				{ track: "video", index: 1 },
				{ track: "video", index: 2 },
			],
			async () => true,
		);
		expect(prepared).toEqual([{ track: "video", index: 1 }]);
		storage.seed(`${prefix}/segments/video/segment_002.m4s`, "late-fragment");
		storage.seed(
			manifestKey,
			JSON.stringify({
				...manifest,
				video_segments: [1, 2],
			}),
		);
		const source = await commitDesktopRecordingSource(recording(), generation);
		expect(readInventory(storage, source.inventoryKey).objects).toHaveLength(3);
		expect(storage.bucket.copyObject).toHaveBeenCalledTimes(3);
	});

	it("does not accept missing final fragments because earlier preparation succeeded", async () => {
		const storage = storageFixture();
		const { manifest } = seedSegments(storage, [1], false);
		await prepareDesktopRecordingSegments(
			recording(),
			[{ track: "video", index: 1 }],
			async () => true,
		);
		storage.seed(
			manifestKey,
			JSON.stringify({
				...manifest,
				video_segments: [1, 2],
			}),
		);
		await expect(
			commitDesktopRecordingSource(recording(), generation),
		).rejects.toThrow("missing");
		expect(
			storage.object(`${prefix}/segments/video/segment_001.m4s`).body,
		).toBe("video-fragment-1");
	});

	it("uses the current source when a fragment was uploaded again after preparation", async () => {
		const storage = storageFixture();
		const { manifest } = seedSegments(storage, [1], false);
		await prepareDesktopRecordingSegments(
			recording(),
			[{ track: "video", index: 1 }],
			async () => true,
		);
		storage.seed(
			`${prefix}/segments/video/segment_001.m4s`,
			"replacement-fragment",
		);
		storage.seed(
			manifestKey,
			JSON.stringify({
				...manifest,
			}),
		);
		const source = await commitDesktopRecordingSource(recording(), generation);
		const output = readInventory(storage, source.inventoryKey).objects;
		const fragment = output.find((entry) => entry.index === 1);
		if (!fragment) throw new Error("Missing copied video fragment");
		expect(output.every((entry) => !entry.key.includes("/prepared/"))).toBe(
			true,
		);
		expect(storage.object(fragment.key).body).toBe("replacement-fragment");
	});

	for (const mutation of ["receipt", "object", "missing"] as const) {
		it(`falls back when the optional prepared ${mutation} is invalid`, async () => {
			const storage = storageFixture();
			const { manifest } = seedSegments(storage, [1], false);
			await prepareDesktopRecordingSegments(
				recording(),
				[{ track: "video", index: 1 }],
				async () => true,
			);
			const copy = storage.bucket.copyObject.mock.calls[0];
			if (!copy) throw new Error("Missing prepared copy");
			const key = copy[1];
			if (mutation === "receipt")
				storage.seed(
					key.replace(/\/video\/1\.m4s$/, "/receipt.json"),
					"invalid-json",
				);
			if (mutation === "object") storage.seed(key, "wrong-fragment");
			if (mutation === "missing") storage.objects.delete(key);
			storage.seed(
				manifestKey,
				JSON.stringify({
					...manifest,
				}),
			);
			const source = await commitDesktopRecordingSource(
				recording(),
				generation,
			);
			const objects = readInventory(storage, source.inventoryKey).objects;
			const fragment = objects.find((entry) => entry.index === 1);
			if (!fragment) throw new Error("Missing copied video fragment");
			expect(objects.every((entry) => !entry.key.includes("/prepared/"))).toBe(
				true,
			);
			expect(storage.object(fragment.key).body).toBe("video-fragment-1");
		});
	}

	it("stops scheduling copies when the recording is stopped or deleted", async () => {
		const storage = storageFixture();
		seedSegments(storage, [1, 2, 3, 4, 5, 6], false);
		const canContinue = vi
			.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValue(false);
		const prepared = await prepareDesktopRecordingSegments(
			recording(),
			Array.from({ length: 6 }, (_, index) => ({
				track: "video" as const,
				index: index + 1,
			})),
			canContinue,
		);
		expect(prepared).toHaveLength(4);
		expect(storage.bucket.copyObject).toHaveBeenCalledTimes(4);
		await prepareDesktopRecordingSegments(
			recording(),
			[{ track: "video", index: 5 }],
			async () => false,
		);
		expect(storage.bucket.copyObject).toHaveBeenCalledTimes(4);
	});

	it("bounds speculative copies and rejects init files and oversized batches", async () => {
		const storage = storageFixture();
		seedSegments(storage, [1], false);
		storage.object(`${prefix}/segments/video/segment_001.m4s`).size =
			65 * 1024 * 1024;
		expect(
			await prepareDesktopRecordingSegments(
				recording(),
				[{ track: "video", index: 1 }],
				async () => true,
			),
		).toEqual([]);
		await expect(
			prepareDesktopRecordingSegments(
				recording(),
				[{ track: "video", index: 0 }],
				async () => true,
			),
		).rejects.toThrow();
		await expect(
			prepareDesktopRecordingSegments(
				recording(),
				Array.from({ length: 33 }, (_, index) => ({
					track: "video" as const,
					index: index + 1,
				})),
				async () => true,
			),
		).rejects.toThrow();
		expect(storage.bucket.copyObject).not.toHaveBeenCalled();
	});
});

describe("durable desktop recording source commit", () => {
	it("reuses a checksum-verified Drive copy when checksum readiness delayed its receipt", async () => {
		const storage = storageFixture("googleDrive");
		seedSegments(storage, [1], false);
		const video = recording();
		const checkpoint = await advanceToPhase(
			video,
			snapshotCheckpoint(),
			"copy",
		);
		const head = storage.bucket.headObject.getMockImplementation();
		if (!head) throw new Error("Missing head implementation");
		let ready = false;
		storage.bucket.headObject.mockImplementation((key) =>
			head(key).pipe(
				Effect.map((value) => ({
					...value,
					RecordingContentETag:
						!ready && key.includes("/copies/")
							? null
							: `"cap-drive-content-v1:${hash(key + storage.object(key).body)}"`,
				})),
			),
		);
		await expect(
			advanceDesktopRecordingSourceCommit(video, checkpoint),
		).rejects.toThrow("Recording content identity is unavailable");
		expect(storage.bucket.copyObject).toHaveBeenCalledTimes(2);
		ready = true;
		const source = await finishSnapshot(video, checkpoint);
		expect(
			(await buildDesktopRecordingSourceUrls(video, source)).sourceObjects,
		).toHaveLength(2);
		expect(storage.bucket.copyObject).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])(
		"keeps legacy Drive checkpoint identities strict after content tags are introduced (changed=%s)",
		async (changed) => {
			const storage = storageFixture("googleDrive");
			seedSegments(storage);
			const video = recording();
			const checkpoint = await advanceToPhase(
				video,
				snapshotCheckpoint(),
				"verify",
			);
			const savedPages = [...storage.objects.entries()]
				.filter(([key]) => key.endsWith(".json"))
				.map(([key, object]) => [key, object.body]);
			const head = storage.bucket.headObject.getMockImplementation();
			if (!head) throw new Error("Missing head implementation");
			storage.bucket.headObject.mockImplementation((key) =>
				head(key).pipe(
					Effect.map((value) => ({
						...value,
						RecordingContentETag: `"cap-drive-content-v1:${hash(key + storage.object(key).body)}"`,
					})),
				),
			);
			if (changed) {
				for (const object of storage.objects.values())
					object.identity = '"changed-version"';
				await expect(finishSnapshot(video, checkpoint)).rejects.toThrow(
					"Recording source changed",
				);
				for (const [key, body] of savedPages)
					expect(storage.object(key as string).body).toBe(body);
			} else {
				const source = await finishSnapshot(video, checkpoint);
				const urls = await buildDesktopRecordingSourceUrls(video, source);
				expect(
					urls.sourceObjects.every((object) =>
						object.objectIdentity.startsWith('"snapshot-'),
					),
				).toBe(true);
			}
		},
	);

	it("preserves new Drive copy receipts across metadata-only version changes", async () => {
		const storage = storageFixture("googleDrive");
		seedSegments(storage);
		const head = storage.bucket.headObject.getMockImplementation();
		if (!head) throw new Error("Missing head implementation");
		storage.bucket.headObject.mockImplementation((key) =>
			head(key).pipe(
				Effect.map((value) => ({
					...value,
					RecordingContentETag: `"cap-drive-content-v1:${hash(key + storage.object(key).body)}"`,
				})),
			),
		);
		const video = recording();
		const checkpoint = await advanceToPhase(
			video,
			snapshotCheckpoint(),
			"verify",
		);
		for (const object of storage.objects.values())
			object.identity = '"metadata-version-6"';
		const source = await finishSnapshot(video, checkpoint);
		const urls = await buildDesktopRecordingSourceUrls(video, source);
		expect(urls.sourceObjects).toHaveLength(5);
		expect(
			urls.sourceObjects.every((object) =>
				object.objectIdentity.startsWith('"cap-drive-content-v1:'),
			),
		).toBe(true);
	});

	it("rejects a same-size wrong Drive copy through the actual source commit path", async () => {
		const storage = storageFixture("googleDrive");
		seedSegments(storage);
		const copy = storage.bucket.copyObject.getMockImplementation();
		if (!copy) throw new Error("Missing copy implementation");
		storage.bucket.copyObject.mockImplementation((source, key, options) =>
			copy(source, key, options).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						const object = storage.object(key);
						object.body = "x".repeat(object.size);
					}),
				),
			),
		);
		await expect(
			commitDesktopRecordingSource(recording(), generation),
		).rejects.toThrow(
			"Recording snapshot content does not match its original source",
		);
		expect(
			[...storage.objects.keys()].some((key) => key.endsWith("receipt.json")),
		).toBe(false);
	});

	it("keeps missing Drive checksum retryable without minting a copy receipt", async () => {
		const storage = storageFixture("googleDrive");
		seedSegments(storage);
		const head = storage.bucket.headObject.getMockImplementation();
		if (!head) throw new Error("Missing head implementation");
		storage.bucket.headObject.mockImplementation((key) =>
			head(key).pipe(
				Effect.map((value) => ({ ...value, RecordingContentETag: null })),
			),
		);
		await expect(
			commitDesktopRecordingSource(recording(), generation),
		).rejects.toThrow("Recording content identity is unavailable");
		expect(storage.bucket.copyObject).not.toHaveBeenCalled();
	});

	it.each([
		{ status: 404, code: "source-missing" },
		{ status: 412, code: "source-changed" },
	])(
		"classifies a real wrapped Drive $status during source commitment",
		async ({ status, code }) => {
			const storage = storageFixture("googleDrive");
			seedSegments(storage);
			const checkpoint = await advanceToPhase(
				recording(),
				snapshotCheckpoint(),
				"enumerate",
			);
			storage.bucket.headObject.mockImplementationOnce(() =>
				Effect.fail(
					new StorageDomain.StorageError({
						cause: new GoogleDriveRequestError(
							status,
							"Source metadata unavailable",
						),
					}),
				),
			);
			await expect(
				advanceDesktopRecordingSourceCommit(recording(), checkpoint),
			).rejects.toMatchObject({ code });
			expect(storage.bucket.copyObject).not.toHaveBeenCalled();
			expect(
				storage.bucket.putObject.mock.calls.some(([key]) =>
					key.endsWith("/inventory.json"),
				),
			).toBe(false);
		},
	);

	it.each([403, 429, 500, 503, null])(
		"keeps wrapped Drive status %s retryable without replacing its checkpoint",
		async (status) => {
			const storage = storageFixture("googleDrive");
			seedSegments(storage);
			const video = recording();
			const checkpoint = await advanceToPhase(
				video,
				snapshotCheckpoint(),
				"copy",
			);
			const savedCheckpoint = structuredClone(checkpoint);
			const cause =
				status === null
					? new TypeError("Network connection closed")
					: new GoogleDriveRequestError(status, "Temporarily unavailable");
			storage.bucket.headObject.mockImplementationOnce(() =>
				Effect.fail(new StorageDomain.StorageError({ cause })),
			);
			await expect(
				advanceDesktopRecordingSourceCommit(video, checkpoint),
			).rejects.not.toBeInstanceOf(DesktopRecordingSourceError);
			expect(checkpoint).toEqual(savedCheckpoint);
			const source = await finishSnapshot(video, checkpoint);
			expect(
				(await buildDesktopRecordingSourceUrls(video, source)).sourceObjects,
			).toHaveLength(5);
		},
	);

	it.each([
		{ status: 404, code: "source-missing" },
		{ status: 412, code: "source-changed" },
	])(
		"classifies wrapped provider status $status without acknowledging a source",
		async ({ status, code }) => {
			const storage = storageFixture();
			const fixture = seedSegments(storage);
			storage.bucket.headObject.mockImplementationOnce(() =>
				Effect.fail(
					new Error("Storage request failed", {
						cause: { $metadata: { httpStatusCode: status } },
					}),
				),
			);
			await expect(
				commitDesktopRecordingSource(
					recording(),
					generation,
					fixture.verification,
				),
			).rejects.toMatchObject({ code });
			expect(
				storage.bucket.putObject.mock.calls.some(([key]) =>
					key.endsWith("/inventory.json"),
				),
			).toBe(false);
		},
	);

	it.each([
		{ name: "numeric legacy", entries: [1, 2] },
		{
			name: "estimated durations",
			entries: [
				{ index: 1, duration: 40 },
				{ index: 2, duration: 44.849652863 },
			],
		},
		{ name: "mixed legacy", entries: [1, { index: 2, duration: 3 }] },
	])(
		"commits every intended fragment from $name manifests",
		async ({ entries }) => {
			const storage = storageFixture();
			const fixture = seedSegments(storage, entries);
			const source = await commitDesktopRecordingSource(
				recording(),
				generation,
				fixture.verification,
			);
			expect(source.requiredAudio).toBe(true);
			expect(source.manifestSha256).toBe(hash(fixture.json));
			const inventoryJson = storage.object(source.inventoryKey).body;
			expect(inventoryJson).toBeDefined();
			const inventory = readInventory(storage, source.inventoryKey);
			expect(source.inventorySha256).toBe(hash(inventoryJson ?? ""));
			expect(inventory.objects).toHaveLength(5);
			for (const copied of inventory.objects) {
				const original = storage.object(copied.originalKey);
				const snapshot = storage.object(copied.key);
				expect(snapshot.body).toBe(original.body);
				expect(copied.size).toBe(original.size);
				expect(copied.originalIdentity).toBe(original.identity);
				expect(copied.objectIdentity).toBe(snapshot.identity);
				expect(copied.objectIdentity).not.toBe(copied.originalIdentity);
			}
			const snapshotManifest = source.inventoryKey.replace(
				"inventory.json",
				"manifest.json",
			);
			expect(storage.object(snapshotManifest).body).toBe(fixture.json);
		},
	);

	it("does not acknowledge before both copies and inventory readback finish", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		const copyGate = deferred();
		const readbackGate = deferred();
		const copy = storage.bucket.copyObject.getMockImplementation();
		const get = storage.bucket.getObject.getMockImplementation();
		if (!copy || !get) throw new Error("Missing fixture operation");
		storage.bucket.copyObject.mockImplementation((...args) =>
			Effect.promise(async () => {
				await copyGate.promise;
				return Effect.runPromise(copy(...args));
			}),
		);
		storage.bucket.getObject.mockImplementation((key) =>
			Effect.promise(async () => {
				if (key.endsWith("/inventory.json")) await readbackGate.promise;
				return Effect.runPromise(get(key));
			}),
		);
		let acknowledged = false;
		const pending = commitDesktopRecordingSource(recording(), generation).then(
			(source) => {
				acknowledged = true;
				return source;
			},
		);
		try {
			await vi.waitFor(() =>
				expect(storage.bucket.copyObject).toHaveBeenCalled(),
			);
			expect(acknowledged).toBe(false);
			expect(
				storage.bucket.putObject.mock.calls.some(([key]) =>
					key.endsWith("/inventory.json"),
				),
			).toBe(false);
			copyGate.resolve();
			await vi.waitFor(() =>
				expect(
					storage.bucket.getObject.mock.calls.some(([key]) =>
						key.endsWith("/inventory.json"),
					),
				).toBe(true),
			);
			expect(acknowledged).toBe(false);
			readbackGate.resolve();
			await pending;
			expect(acknowledged).toBe(true);
		} finally {
			copyGate.resolve();
			readbackGate.resolve();
		}
	});

	it("keeps video-only recordings independent of absent audio", async () => {
		const storage = storageFixture();
		const fixture = seedSegments(storage, [1, 2], false);
		const source = await commitDesktopRecordingSource(recording(), generation);
		expect(source.requiredAudio).toBe(false);
		const urls = await buildDesktopRecordingSourceUrls(recording(), source);
		expect(urls.videoSegmentUrls).toHaveLength(2);
		expect(urls.audioInitUrl).toBeUndefined();
		expect(urls.audioSegmentUrls).toEqual([]);
		await expect(
			commitDesktopRecordingSource(recording(), generation, {
				...fixture.verification,
				requiredAudio: true,
			}),
		).rejects.toThrow("does not match");
	});

	it.each([
		"missing",
		"empty",
		"negative-size",
		"weak-identity",
		"unquoted-identity",
	])("never commits a %s source object", async (failure) => {
		const storage = storageFixture();
		seedSegments(storage);
		const source = storage.object(videoInitKey);
		if (failure === "missing") storage.objects.delete(videoInitKey);
		else if (failure === "empty") source.size = 0;
		else if (failure === "negative-size") source.size = -1;
		else if (failure === "weak-identity") source.identity = 'W/"weak"';
		else source.identity = "unquoted";
		await expect(
			commitDesktopRecordingSource(recording(), generation),
		).rejects.toThrow();
		expect(
			storage.bucket.putObject.mock.calls.some(([key]) =>
				key.endsWith("/inventory.json"),
			),
		).toBe(false);
	});

	it("rejects a changed source identity while saving the snapshot", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		const copy = storage.bucket.copyObject.getMockImplementation();
		if (!copy) throw new Error("Missing fixture operation");
		storage.bucket.copyObject.mockImplementation((...args) =>
			Effect.flatMap(copy(...args), (result) => {
				storage.object(videoInitKey).identity = '"new-original"';
				return Effect.succeed(result);
			}),
		);
		await expect(
			commitDesktopRecordingSource(recording(), generation),
		).rejects.toThrow();
		expect(
			storage.bucket.putObject.mock.calls.some(([key]) =>
				key.endsWith("/inventory.json"),
			),
		).toBe(false);
	});

	it("requires the exact completion manifest, including its original bytes", async () => {
		const storage = storageFixture();
		const fixture = seedSegments(storage);
		storage.seed(manifestKey, JSON.stringify(fixture.manifest));
		await expect(
			commitDesktopRecordingSource(
				recording(),
				generation,
				fixture.verification,
			),
		).rejects.toThrow("does not match");
		expect(storage.bucket.copyObject).not.toHaveBeenCalled();
	});

	it("never treats an uncommitted manifest as a complete source", async () => {
		const storage = storageFixture();
		const fixture = seedSegments(storage);
		storage.seed(
			manifestKey,
			JSON.stringify({ ...fixture.manifest, is_complete: false }),
		);
		await expect(
			commitDesktopRecordingSource(recording(), generation),
		).rejects.toThrow("incomplete");
		expect(storage.bucket.copyObject).not.toHaveBeenCalled();
		expect(
			storage.bucket.putObject.mock.calls.some(([key]) =>
				key.endsWith("/inventory.json"),
			),
		).toBe(false);
	});

	it("does not commit if the manifest changes while fragments are copied", async () => {
		const storage = storageFixture();
		const fixture = seedSegments(storage);
		const copy = storage.bucket.copyObject.getMockImplementation();
		if (!copy) throw new Error("Missing fixture operation");
		storage.bucket.copyObject.mockImplementation((...args) =>
			Effect.flatMap(copy(...args), (result) => {
				storage.seed(manifestKey, `${fixture.json} `);
				return Effect.succeed(result);
			}),
		);
		await expect(
			commitDesktopRecordingSource(recording(), generation),
		).rejects.toThrow("manifest changed");
		expect(
			storage.bucket.putObject.mock.calls.some(([key]) =>
				key.endsWith("/inventory.json"),
			),
		).toBe(false);
	});

	it("renews a slow copy lease and refuses completion after the lease is lost", async () => {
		vi.useFakeTimers();
		const gate = deferred();
		try {
			const storage = storageFixture();
			seedSegments(storage);
			const copy = storage.bucket.copyObject.getMockImplementation();
			if (!copy) throw new Error("Missing fixture operation");
			storage.bucket.copyObject.mockImplementation((...args) =>
				Effect.promise(async () => {
					await gate.promise;
					return Effect.runPromise(copy(...args));
				}),
			);
			const progress = vi
				.fn<() => Promise<void>>()
				.mockResolvedValue(undefined);
			const pending = expect(
				commitDesktopRecordingSource(
					recording(),
					generation,
					undefined,
					progress,
				),
			).rejects.toThrow("lease lost");
			await vi.advanceTimersByTimeAsync(0);
			expect(storage.bucket.copyObject).toHaveBeenCalled();
			const previousCalls = progress.mock.calls.length;
			progress.mockRejectedValue(new Error("Recording lease lost"));
			await vi.advanceTimersByTimeAsync(30_001);
			expect(progress.mock.calls.length).toBeGreaterThan(previousCalls);
			gate.resolve();
			await pending;
			expect(
				storage.bucket.putObject.mock.calls.some(([key]) =>
					key.endsWith("/inventory.json"),
				),
			).toBe(false);
		} finally {
			gate.resolve();
			vi.useRealTimers();
		}
	});

	it.each(["manifest.json", "inventory.json"])(
		"does not commit corrupt durable %s readback",
		async (name) => {
			const storage = storageFixture();
			seedSegments(storage);
			const put = storage.bucket.putObject.getMockImplementation();
			if (!put) throw new Error("Missing fixture operation");
			storage.bucket.putObject.mockImplementation((key, body) =>
				put(key, key.endsWith(`/${name}`) ? `${body}\ncorrupt` : body),
			);
			await expect(
				commitDesktopRecordingSource(recording(), generation),
			).rejects.toThrow();
		},
	);
	it("checks each S3 original once per phase and does not read receipts back", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		await commitDesktopRecordingSource(recording(), generation);
		const segmentKey = `${prefix}/segments/video/segment_001.m4s`;
		expect(
			storage.bucket.headObject.mock.calls.filter(
				([key]) => key === segmentKey,
			),
		).toHaveLength(3);
		expect(
			storage.bucket.getObject.mock.calls.some(([key]) =>
				key.endsWith("/receipt.json"),
			),
		).toBe(false);
	});

	it("writes Drive receipts without reading them back", async () => {
		const storage = storageFixture("googleDrive");
		seedSegments(storage);
		await commitDesktopRecordingSource(recording(), generation);
		expect(
			storage.bucket.putObject.mock.calls.some(([key]) =>
				key.endsWith("/receipt.json"),
			),
		).toBe(true);
		expect(
			storage.bucket.getObject.mock.calls.some(([key]) =>
				key.endsWith("/receipt.json"),
			),
		).toBe(false);
	});
	it.each(["s3", "googleDrive"] as const)(
		"reads each %s checkpoint page back once and reuses it for the rest of the commit",
		async (provider) => {
			const storage = storageFixture(provider);
			seedSegments(
				storage,
				Array.from({ length: 150 }, (_, index) => index + 1),
			);
			await commitDesktopRecordingSource(recording(), generation);
			const pageReads = new Map<string, number>();
			for (const [key] of storage.bucket.getObject.mock.calls)
				if (key.includes("/pages/"))
					pageReads.set(key, (pageReads.get(key) ?? 0) + 1);
			const pagesWritten = [
				...storage.bucket.putObject.mock.calls,
				...(storage.bucket.putObjectWithChecksum?.mock.calls ?? []),
			].filter(([key]) => key.includes("/pages/")).length;
			expect(pagesWritten).toBeGreaterThan(1);
			expect(Math.max(0, ...pageReads.values())).toBeLessThanOrEqual(1);
		},
	);

	it("still reads committed pages from storage when building source URLs", async () => {
		const storage = storageFixture("googleDrive");
		seedSegments(storage);
		const source = await commitDesktopRecordingSource(recording(), generation);
		const before = storage.bucket.getObject.mock.calls.length;
		await buildDesktopRecordingSourceUrls(recording(), source);
		expect(
			storage.bucket.getObject.mock.calls
				.slice(before)
				.some(([key]) => key.includes("/pages/")),
		).toBe(true);
	});
	it("trusts Drive's stored SHA-256 for checkpoint pages instead of reading them back", async () => {
		const pageReads = async (checksum: boolean) => {
			const storage = storageFixture("googleDrive");
			seedSegments(
				storage,
				Array.from({ length: 150 }, (_, index) => index + 1),
			);
			const put = storage.bucket.putObjectWithChecksum;
			const store = put?.getMockImplementation();
			if (!put || !store) throw new Error("Missing fixture operation");
			if (!checksum)
				put.mockImplementation((key, body) =>
					store(key, body).pipe(Effect.as({ sha256Checksum: null })),
				);
			await commitDesktopRecordingSource(recording(), generation);
			return {
				written: put.mock.calls.length,
				reads: storage.bucket.getObject.mock.calls.filter(([key]) =>
					key.includes("/pages/"),
				).length,
			};
		};
		const trusted = await pageReads(true);
		const fallback = await pageReads(false);
		expect(trusted.written).toBeGreaterThan(3);
		expect(trusted.written).toBe(fallback.written);
		expect(trusted.reads).toBe(fallback.reads - fallback.written);
	});

	it("reads a Drive checkpoint page back when Drive returns no checksum", async () => {
		const storage = storageFixture("googleDrive");
		seedSegments(storage);
		const put = storage.bucket.putObjectWithChecksum;
		const store = put?.getMockImplementation();
		if (!put || !store) throw new Error("Missing fixture operation");
		put.mockImplementation((key, body) =>
			store(key, body).pipe(Effect.as({ sha256Checksum: null })),
		);
		await commitDesktopRecordingSource(recording(), generation);
		const reads = new Set(
			storage.bucket.getObject.mock.calls.map(([key]) => key),
		);
		expect(put.mock.calls.every(([key]) => reads.has(key))).toBe(true);
	});

	it("does not commit a Drive checkpoint page stored with different bytes", async () => {
		const storage = storageFixture("googleDrive");
		seedSegments(storage);
		const put = storage.bucket.putObjectWithChecksum;
		const store = put?.getMockImplementation();
		if (!put || !store) throw new Error("Missing fixture operation");
		put.mockImplementation((key, body) => store(key, `${body}\ncorrupt`));
		await expect(
			commitDesktopRecordingSource(recording(), generation),
		).rejects.toThrow("Durable recording source readback did not match");
		expect(
			storage.bucket.putObject.mock.calls.some(([key]) =>
				key.endsWith("/inventory.json"),
			),
		).toBe(false);
	});
	it.each([
		["plan", "/plans/", "/plan.json"],
		["finalize", "/commits/", "/inventory.json"],
	])(
		"writes the %s manifest copy alongside its sibling file",
		async (_phase, directory, sibling) => {
			const storage = storageFixture("googleDrive");
			seedSegments(storage);
			const put = storage.bucket.putObject.getMockImplementation();
			if (!put) throw new Error("Missing fixture operation");
			let manifestPending = false;
			let overlapped = false;
			let siblingStarted: () => void = () => {};
			const siblingWrite = new Promise<void>((resolve) => {
				siblingStarted = resolve;
			});
			storage.bucket.putObject.mockImplementation((key, body) => {
				if (key.includes(directory) && key.endsWith(sibling)) {
					if (manifestPending) overlapped = true;
					siblingStarted();
				}
				if (key.includes(directory) && key.endsWith("/manifest.json")) {
					manifestPending = true;
					return Effect.promise(() =>
						Promise.race([
							siblingWrite,
							new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
						]),
					).pipe(
						Effect.zipRight(put(key, body)),
						Effect.ensuring(
							Effect.sync(() => {
								manifestPending = false;
							}),
						),
					);
				}
				return put(key, body);
			});
			await commitDesktopRecordingSource(recording(), generation);
			expect(overlapped).toBe(true);
		},
	);

	it.each(["/plans/", "/commits/"])(
		"does not commit when the manifest copy under %s fails",
		async (directory) => {
			const storage = storageFixture("googleDrive");
			seedSegments(storage);
			const put = storage.bucket.putObject.getMockImplementation();
			if (!put) throw new Error("Missing fixture operation");
			storage.bucket.putObject.mockImplementation((key, body) =>
				key.includes(directory) && key.endsWith("/manifest.json")
					? Effect.fail(new Error("Manifest copy unavailable"))
					: put(key, body),
			);
			await expect(
				commitDesktopRecordingSource(recording(), generation),
			).rejects.toThrow();
		},
	);
});

describe("large desktop recording snapshots", () => {
	it("bounds an individual stalled storage copy without advancing the checkpoint", async () => {
		const storage = storageFixture();
		storage.seed(`${prefix}/result.mp4`, "uploaded-mp4");
		const video = recording({ type: "desktopMP4" });
		const checkpoint = await advanceToPhase(
			video,
			snapshotCheckpoint(),
			"copy",
		);
		vi.useFakeTimers();
		try {
			storage.bucket.copyObject.mockImplementationOnce(() => Effect.never);
			const pending = expect(
				advanceDesktopRecordingSourceCommit(video, checkpoint),
			).rejects.toThrow(/timed out|Timeout/i);
			await vi.advanceTimersByTimeAsync(60_001);
			await pending;
			expect(checkpoint.cursor).toBe(0);
			expect(
				storage.bucket.putObject.mock.calls.some(([key]) =>
					key.endsWith("/inventory.json"),
				),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
		const source = await finishSnapshot(video, checkpoint);
		expect(source.kind).toBe("mp4");
	});

	it.each(["NoSuchUpload", "bare 404"])(
		"restarts an expired multipart upload reported as %s while retaining its immutable source plan",
		async (failure) => {
			const storage = storageFixture();
			storage.objects.set(`${prefix}/result.mp4`, {
				size: 8 * 1024 ** 3,
				identity: '"large-original"',
			});
			const video = recording({ type: "desktopMP4" });
			const checkpoint = await advanceToPhase(
				video,
				snapshotCheckpoint(),
				"copy",
			);
			const created = await advanceDesktopRecordingSourceCommit(
				video,
				checkpoint,
			);
			if (!("checkpoint" in created) || !created.checkpoint.multipart)
				throw new Error("Missing multipart checkpoint");
			storage.uploads.delete(created.checkpoint.multipart.uploadId);
			if (failure === "bare 404") {
				storage.bucket.multipart.copyPart.mockImplementationOnce(() =>
					Effect.fail(
						Object.assign(new Error("Not found"), {
							$metadata: { httpStatusCode: 404 },
						}),
					),
				);
			}
			const expired = await advanceDesktopRecordingSourceCommit(
				video,
				created.checkpoint,
			);
			if (!("checkpoint" in expired)) throw new Error("Unexpected completion");
			expect(expired.checkpoint).toMatchObject({
				phase: "copy",
				cursor: 0,
				plan: checkpoint.plan,
				planRoots: checkpoint.planRoots,
			});
			expect(expired.checkpoint.multipart).toBeUndefined();
			const source = await finishSnapshot(video, expired.checkpoint);
			expect(storage.bucket.multipart.create).toHaveBeenCalledTimes(2);
			expect(source.mp4?.fileSize).toBe(8 * 1024 ** 3);
		},
	);

	it("does not treat a missing original as an expired multipart session", async () => {
		const storage = storageFixture();
		const key = `${prefix}/result.mp4`;
		storage.objects.set(key, {
			size: 8 * 1024 ** 3,
			identity: '"large-original"',
		});
		const video = recording({ type: "desktopMP4" });
		const checkpoint = await advanceToPhase(
			video,
			snapshotCheckpoint(),
			"copy",
		);
		const result = await advanceDesktopRecordingSourceCommit(video, checkpoint);
		if (!("checkpoint" in result))
			throw new Error("Missing multipart checkpoint");
		storage.objects.delete(key);
		await expect(
			advanceDesktopRecordingSourceCommit(video, result.checkpoint),
		).rejects.toMatchObject({ code: "source-missing" });
		expect(storage.bucket.multipart.create).toHaveBeenCalledOnce();
	});

	it("reuses a completed multipart object when completion response checkpointing was interrupted", async () => {
		const storage = storageFixture();
		storage.objects.set(`${prefix}/result.mp4`, {
			size: 8 * 1024 ** 3,
			identity: '"large-original"',
		});
		const video = recording({ type: "desktopMP4" });
		let checkpoint = await advanceToPhase(video, snapshotCheckpoint(), "copy");
		while ((checkpoint.multipart?.nextPartNumber ?? 0) <= 64) {
			const result = await advanceDesktopRecordingSourceCommit(
				video,
				checkpoint,
			);
			if (!("checkpoint" in result)) throw new Error("Unexpected completion");
			checkpoint = result.checkpoint;
		}
		await advanceDesktopRecordingSourceCommit(video, checkpoint);
		const source = await finishSnapshot(video, checkpoint);
		expect(storage.bucket.multipart.complete).toHaveBeenCalledOnce();
		expect(
			(await buildDesktopRecordingSourceUrls(video, source)).sourceFileSize,
		).toBe(8 * 1024 ** 3);
	});

	it.each([
		["s3", 256],
		["googleDrive", 64],
	] as const)(
		"resumes a completed %s copy when the database checkpoint write was lost",
		async (provider, page) => {
			const storage = storageFixture(provider);
			seedSegments(
				storage,
				Array.from({ length: 299 }, (_, index) => index + 1),
				false,
			);
			const video = recording();
			const checkpoint = await advanceToPhase(
				video,
				snapshotCheckpoint(),
				"copy",
			);
			const copied = await advanceDesktopRecordingSourceCommit(
				video,
				checkpoint,
			);
			if (!("checkpoint" in copied)) throw new Error("Unexpected completion");
			expect(copied.checkpoint.cursor).toBe(page);
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(page);
			const replay = await advanceDesktopRecordingSourceCommit(
				video,
				checkpoint,
			);
			if (!("checkpoint" in replay)) throw new Error("Unexpected completion");
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(page);
			expect(replay.checkpoint.snapshotId).toBe(checkpoint.snapshotId);
			const source = await finishSnapshot(video, replay.checkpoint);
			const urls = await buildDesktopRecordingSourceUrls(video, source);
			expect(urls.sourceObjects).toHaveLength(300);
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(300);
			expect(JSON.stringify(replay.checkpoint).length).toBeLessThan(5_000);
		},
	);

	it("reuses a metadata-verified S3 copy even when its receipt write was interrupted", async () => {
		const storage = storageFixture();
		storage.seed(`${prefix}/result.mp4`, "uploaded-mp4");
		const video = recording({ type: "desktopMP4" });
		const checkpoint = await advanceToPhase(
			video,
			snapshotCheckpoint(),
			"copy",
		);
		const put = storage.bucket.putObject.getMockImplementation();
		if (!put) throw new Error("Missing fixture operation");
		storage.bucket.putObject.mockImplementationOnce(() =>
			Effect.fail(new Error("Receipt storage unavailable")),
		);
		await expect(
			advanceDesktopRecordingSourceCommit(video, checkpoint),
		).rejects.toThrow("Receipt storage unavailable");
		const source = await finishSnapshot(video, checkpoint);
		expect(storage.bucket.copyObject).toHaveBeenCalledOnce();
		expect(source.inventoryKey.replace(/inventory\.json$/, "mp4/0.mp4")).toBe(
			(await buildDesktopRecordingSourceUrls(video, source)).outputKey,
		);
	});

	it("keeps a late Drive copy isolated from the receipt selected by a retry", async () => {
		const storage = storageFixture("googleDrive");
		storage.seed(`${prefix}/result.mp4`, "uploaded-mp4");
		const video = recording({ type: "desktopMP4" });
		const checkpoint = await advanceToPhase(
			video,
			snapshotCheckpoint(),
			"copy",
		);
		const copy = storage.bucket.copyObject.getMockImplementation();
		if (!copy) throw new Error("Missing fixture operation");
		const gate = deferred();
		storage.bucket.copyObject.mockImplementationOnce((...args) =>
			Effect.promise(async () => {
				await gate.promise;
				return Effect.runPromise(copy(...args));
			}),
		);
		const stale = advanceDesktopRecordingSourceCommit(video, checkpoint);
		try {
			await vi.waitFor(() =>
				expect(storage.bucket.copyObject).toHaveBeenCalledOnce(),
			);
			const source = await finishSnapshot(video, checkpoint);
			const before = await buildDesktopRecordingSourceUrls(video, source);
			gate.resolve();
			await stale;
			const after = await buildDesktopRecordingSourceUrls(video, source);
			expect(after.sourceObjects).toEqual(before.sourceObjects);
			expect(storage.bucket.copyObject.mock.calls[0]?.[1]).not.toBe(
				storage.bucket.copyObject.mock.calls[1]?.[1],
			);
		} finally {
			gate.resolve();
		}
	});

	it("resumes checkpointed multipart ranges after interruption without copying previous ranges again", async () => {
		const storage = storageFixture();
		storage.objects.set(`${prefix}/result.mp4`, {
			size: 8 * 1024 ** 3,
			identity: '"large-original"',
		});
		const video = recording({ type: "desktopMP4" });
		let checkpoint = await advanceToPhase(video, snapshotCheckpoint(), "copy");
		for (let step = 0; step < 3; step++) {
			const result = await advanceDesktopRecordingSourceCommit(
				video,
				checkpoint,
			);
			if (!("checkpoint" in result)) throw new Error("Unexpected completion");
			checkpoint = result.checkpoint;
		}
		expect(checkpoint.multipart?.nextPartNumber).toBe(9);
		storage.bucket.multipart.copyPart.mockImplementationOnce(() =>
			Effect.fail(new Error("Worker stopped")),
		);
		await expect(
			advanceDesktopRecordingSourceCommit(video, checkpoint),
		).rejects.toThrow("Worker stopped");
		const source = await finishSnapshot(video, checkpoint);
		expect(storage.bucket.multipart.create).toHaveBeenCalledOnce();
		expect(storage.bucket.multipart.abort).not.toHaveBeenCalled();
		for (let part = 1; part <= 8; part++) {
			expect(
				storage.bucket.multipart.copyPart.mock.calls.filter(
					([, , number]) => number === part,
				),
			).toHaveLength(1);
		}
		expect(
			(await buildDesktopRecordingSourceUrls(video, source)).sourceFileSize,
		).toBe(8 * 1024 ** 3);
		expect(JSON.stringify(checkpoint).length).toBeLessThan(10_000);
	});

	it("rejects a fragment replaced after the identity plan was checkpointed", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		const checkpoint = await advanceToPhase(
			recording(),
			snapshotCheckpoint(),
			"copy",
		);
		storage.seed(videoInitKey, "new-original");
		await expect(
			advanceDesktopRecordingSourceCommit(recording(), checkpoint),
		).rejects.toMatchObject({ code: "source-changed" });
		expect(
			storage.bucket.putObject.mock.calls.some(([key]) =>
				key.endsWith("/inventory.json"),
			),
		).toBe(false);
	});

	it("snapshots a new explicit MP4 upload instead of the previously published output", async () => {
		const storage = storageFixture();
		const rawKey = `${prefix}/result.mp4`;
		const publishedKey = `${prefix}/.recording/outputs/${generation}/previous.mp4`;
		storage.seed(rawKey, "newly-uploaded-recording");
		storage.seed(publishedKey, "previously-published-recording");
		const uploaded = storage.object(rawKey);
		const video = recording({ type: "desktopMP4", outputKey: publishedKey });
		const verification: RecordingVerification = {
			version: 1,
			artifact: {
				kind: "mp4",
				fileSize: uploaded.size,
				duration: 5,
				objectIdentity: uploaded.identity,
			},
			requiredAudio: false,
		};
		const source = await commitDesktopRecordingSource(
			video,
			generation,
			verification,
		);
		expect(source.mp4).toMatchObject({
			fileSize: uploaded.size,
			objectIdentity: uploaded.identity,
		});
		const urls = await buildDesktopRecordingSourceUrls(video, source);
		if (!urls.sourceOutputKey)
			throw new Error("Missing committed MP4 snapshot");
		expect(storage.object(urls.sourceOutputKey).body).toBe(uploaded.body);
		expect(storage.object(publishedKey).body).toBe(
			"previously-published-recording",
		);
		expect(mocks.storage).toHaveBeenNthCalledWith(1, video, {
			resolvePublishedOutput: false,
		});
	});

	it("copies an 8 GiB source in complete, conditional multipart ranges", async () => {
		const storage = storageFixture();
		const size = 8 * 1024 ** 3;
		const key = `${prefix}/result.mp4`;
		storage.objects.set(key, { size, identity: '"large-original"' });
		const source = await commitDesktopRecordingSource(
			recording({ type: "desktopMP4" }),
			generation,
		);
		expect(source.mp4).toMatchObject({
			fileSize: size,
			objectIdentity: '"large-original"',
		});
		expect(storage.bucket.copyObject).not.toHaveBeenCalled();
		expect(storage.bucket.multipart.copyPart.mock.calls.length).toBeGreaterThan(
			1,
		);
		let next = 0;
		for (const [, , , options] of storage.bucket.multipart.copyPart.mock
			.calls) {
			const range = /^bytes=(\d+)-(\d+)$/.exec(options.CopySourceRange);
			if (!range) throw new Error("Missing multipart source range");
			expect(Number(range[1])).toBe(next);
			expect(Number(range[2])).toBeLessThan(size);
			expect(options.CopySourceIfMatch).toBe('"large-original"');
			next = Number(range[2]) + 1;
		}
		expect(next).toBe(size);
		expect(storage.uploads.size).toBe(0);
		for (const [, body] of storage.bucket.putObject.mock.calls) {
			expect(Buffer.byteLength(body)).toBeLessThan(1024 ** 2);
		}
		const urls = await buildDesktopRecordingSourceUrls(recording(), source);
		expect(urls.sourceFileSize).toBe(size);
		expect(urls.sourceObjectIdentity).not.toBe('"large-original"');
	});

	it("retains an interrupted multipart copy without publishing an inventory", async () => {
		const storage = storageFixture();
		storage.objects.set(`${prefix}/result.mp4`, {
			size: 8 * 1024 ** 3,
			identity: '"large-original"',
		});
		storage.bucket.multipart.copyPart.mockImplementation(() =>
			Effect.fail(new Error("Part copy failed")),
		);
		await expect(
			commitDesktopRecordingSource(
				recording({ type: "desktopMP4" }),
				generation,
			),
		).rejects.toThrow("Part copy failed");
		expect(storage.bucket.multipart.abort).not.toHaveBeenCalled();
		expect(storage.bucket.multipart.complete).not.toHaveBeenCalled();
		expect(
			storage.bucket.putObject.mock.calls.some(([key]) =>
				key.endsWith("/inventory.json"),
			),
		).toBe(false);
		expect(storage.uploads.size).toBe(1);
	});
});

describe("source commit page size", () => {
	const segmentCount = 130;

	function pagedFixture(
		provider = "s3",
		customBucket = false,
		segments = segmentCount,
	) {
		const storage = storageFixture(provider, customBucket);
		seedSegments(
			storage,
			Array.from({ length: segments }, (_, index) => index + 1),
		);
		return storage;
	}

	async function advanceWithPageSize(
		pageSize: number,
		checkpoint: DesktopRecordingSourceCheckpoint,
		done: (checkpoint: DesktopRecordingSourceCheckpoint) => boolean = () =>
			false,
	) {
		mocks.pageSize = pageSize;
		let checkpoints = 0;
		while (!done(checkpoint)) {
			const result = await advanceDesktopRecordingSourceCommit(
				recording(),
				checkpoint,
			);
			checkpoints++;
			if ("source" in result)
				return { source: result.source, checkpoint, checkpoints };
			checkpoint = result.checkpoint;
		}
		return { source: undefined, checkpoint, checkpoints };
	}

	function leafSizes(
		storage: ReturnType<typeof storageFixture>,
		inventoryKey: string,
	) {
		const page = z.discriminatedUnion("type", [
			z.object({ type: z.literal("leaf"), entries: z.array(z.unknown()) }),
			z.object({
				type: z.literal("branch"),
				children: z.array(z.object({ key: z.string() })),
			}),
		]);
		const sizes = (key: string): number[] => {
			const node = page.parse(JSON.parse(storage.object(key).body ?? ""));
			return node.type === "leaf"
				? [node.entries.length]
				: node.children.flatMap((child) => sizes(child.key));
		};
		return z
			.object({ roots: z.array(z.object({ key: z.string() })) })
			.parse(JSON.parse(storage.object(inventoryKey).body ?? ""))
			.roots.flatMap((root) => sizes(root.key));
	}

	async function snapshotOutput(
		storage: ReturnType<typeof storageFixture>,
		source: Awaited<ReturnType<typeof commitDesktopRecordingSource>>,
	) {
		const objects = readInventory(storage, source.inventoryKey).objects.map(
			(object) => {
				const copy = storage.object(object.key);
				expect(copy.identity).toBe(object.objectIdentity);
				const receiptKey = object.key.replace(
					/\/(video|audio)\/\d+\.(mp4|m4s)$/,
					"/receipt.json",
				);
				expect(JSON.parse(storage.object(receiptKey).body ?? "")).toEqual(
					object,
				);
				return {
					key: object.key.replace(/\/copies\/(\d+)\/[0-9a-f-]{36}\//, "/$1/"),
					originalKey: object.originalKey,
					originalIdentity: object.originalIdentity,
					size: object.size,
					track: object.track,
					index: object.index,
					body: copy.body,
				};
			},
		);
		const urls = await buildDesktopRecordingSourceUrls(recording(), source);
		return {
			source: {
				kind: source.kind,
				manifestSha256: source.manifestSha256,
				requiredAudio: source.requiredAudio,
			},
			objects,
			urls: {
				sourceObjects: urls.sourceObjects.map(({ size }) => size),
				videoSegments: urls.videoSegmentUrls.length,
				audioSegments: urls.audioSegmentUrls.length,
				videoInit: urls.videoInitUrl !== undefined,
				audioInit: urls.audioInitUrl !== undefined,
			},
			copies: storage.bucket.copyObject.mock.calls.length,
		};
	}

	async function referenceOutput(pageSize: number, segments = segmentCount) {
		const storage = pagedFixture("s3", false, segments);
		const result = await advanceWithPageSize(pageSize, snapshotCheckpoint());
		if (!result.source) throw new Error("Snapshot did not complete");
		return {
			output: await snapshotOutput(storage, result.source),
			checkpoints: result.checkpoints,
			leaves: leafSizes(storage, result.source.inventoryKey),
		};
	}

	it("uses 256-entry pages for Cap's bucket and keeps 16 elsewhere, both within the leaf schema", async () => {
		const actual = await vi.importActual<
			typeof import("@/lib/desktop-recording-source-checkpoint")
		>("@/lib/desktop-recording-source-checkpoint");
		expect(actual.SOURCE_COMMIT_AWS_PAGE_SIZE).toBe(256);
		expect(actual.SOURCE_COMMIT_PAGE_SIZE).toBe(16);
		expect(actual.SOURCE_COMMIT_AWS_PAGE_SIZE).toBeLessThanOrEqual(
			actual.SOURCE_COMMIT_TREE_PAGE_SIZE,
		);
		expect(actual.SOURCE_COMMIT_TREE_PAGE_SIZE).toBeLessThanOrEqual(
			actual.SOURCE_COMMIT_MAX_TREE_PAGE_ENTRIES,
		);
	});

	it("resumes a commit saved with 256-entry pages using the previous 128-entry writer, as after a rollback", async () => {
		mocks.treePageSize = 128;
		const reference = await referenceOutput(128, 300);
		mocks.treePageSize = undefined;
		const storage = pagedFixture("s3", false, 300);
		const partial = await advanceWithPageSize(
			256,
			snapshotCheckpoint(),
			(checkpoint) => checkpoint.phase === "verify",
		);
		expect(partial.source).toBeUndefined();
		expect(partial.checkpoint.phase).toBe("verify");
		const savedLeaves = [...storage.objects.values()].flatMap((object) => {
			try {
				const page = JSON.parse(object.body ?? "");
				return page?.type === "leaf" ? [page.entries.length] : [];
			} catch {
				return [];
			}
		});
		expect(savedLeaves).toContain(256);
		mocks.treePageSize = 128;
		const resumed = await advanceWithPageSize(128, partial.checkpoint);
		mocks.treePageSize = undefined;
		if (!resumed.source) throw new Error("Resumed commit did not complete");
		expect(await snapshotOutput(storage, resumed.source)).toEqual(
			reference.output,
		);
	});

	it.each([
		[256, true],
		[257, false],
	] as const)(
		"reads a commit with %i-entry tree pages only within the read limit",
		async (size, readable) => {
			const storage = storageFixture("s3");
			seedSegments(
				storage,
				Array.from({ length: 300 }, (_, index) => index + 1),
			);
			mocks.treePageSize = size;
			const commit = advanceWithPageSize(size, snapshotCheckpoint());
			if (readable) {
				const result = await commit;
				if (!result.source) throw new Error("Commit did not complete");
				expect(
					Math.max(...leafSizes(storage, result.source.inventoryKey)),
				).toBe(size);
			} else {
				await expect(commit).rejects.toMatchObject({ code: "source-invalid" });
			}
		},
	);

	it.each([
		["a custom S3-compatible bucket", "s3", true, 16],
		["Google Drive", "googleDrive", false, 64],
	] as const)(
		"uses %s's checkpoint page size",
		async (_, provider, customBucket, pageSize) => {
			pagedFixture(provider, customBucket);
			mocks.pageSize = undefined;
			let checkpoint = snapshotCheckpoint();
			let checkpoints = 0;
			while (true) {
				const result = await advanceDesktopRecordingSourceCommit(
					recording(),
					checkpoint,
				);
				checkpoints++;
				if ("source" in result) break;
				checkpoint = result.checkpoint;
			}
			expect(checkpoints).toBe(
				2 + 3 * Math.ceil((segmentCount + 3) / pageSize),
			);
		},
	);

	it("commits more than 64 objects with the same inventory and receipts as 16-entry pages", async () => {
		const legacy = await referenceOutput(16);
		vi.clearAllMocks();
		const current = await referenceOutput(64);
		const objectCount = segmentCount + 3;
		expect(current.output.objects).toHaveLength(objectCount);
		expect(current.output).toEqual(legacy.output);
		expect(current.output.copies).toBe(objectCount);
		expect(legacy.checkpoints).toBe(2 + 3 * Math.ceil(objectCount / 16));
		expect(current.checkpoints).toBe(2 + 3 * Math.ceil(objectCount / 64));
		expect(legacy.leaves.every((size) => size <= 16)).toBe(true);
		expect(current.leaves).toEqual([64, 64, objectCount - 128]);
	});

	for (const [from, to] of [
		[16, 64],
		[64, 16],
	] as const) {
		it.each(["enumerate", "copy", "verify"] as const)(
			`resumes a %s checkpoint saved with ${from}-entry pages after switching to ${to}`,
			async (phase) => {
				const reference = await referenceOutput(64);
				vi.clearAllMocks();
				const storage = pagedFixture();
				const saved = await advanceWithPageSize(
					from,
					snapshotCheckpoint(),
					(checkpoint) =>
						checkpoint.phase === phase && checkpoint.cursor === 64,
				);
				expect(saved.source).toBeUndefined();
				const next = await advanceDesktopRecordingSourceCommit(
					recording(),
					saved.checkpoint,
				);
				if (!("checkpoint" in next)) throw new Error("Unexpected completion");
				expect(next.checkpoint).toMatchObject({
					phase,
					cursor: 64 + from,
					plan: saved.checkpoint.plan,
					snapshotId: saved.checkpoint.snapshotId,
				});
				const resumed = await advanceWithPageSize(to, next.checkpoint);
				if (!resumed.source) throw new Error("Snapshot did not complete");
				expect(await snapshotOutput(storage, resumed.source)).toEqual(
					reference.output,
				);
				const leaves = leafSizes(storage, resumed.source.inventoryKey);
				expect(leaves.reduce((total, size) => total + size, 0)).toBe(
					segmentCount + 3,
				);
				if (phase !== "verify") expect(new Set(leaves).size).toBeGreaterThan(1);
			},
		);
	}

	it.each([
		["Cap's AWS bucket", "s3", false, 256],
		["a custom S3-compatible bucket", "s3", true, 8],
		["Google Drive", "googleDrive", false, 32],
	] as const)(
		"bounds parallel storage requests for %s",
		async (_, provider, customBucket, expected) => {
			const storage = pagedFixture(provider, customBucket, 300);
			const active = { head: 0, copy: 0 };
			const peak = { head: 0, copy: 0 };
			const track = <A, E>(
				name: "head" | "copy",
				effect: Effect.Effect<A, E>,
			) =>
				Effect.suspend(() => {
					active[name]++;
					peak[name] = Math.max(peak[name], active[name]);
					return Effect.sleep("1 millis").pipe(
						Effect.zipRight(effect),
						Effect.ensuring(
							Effect.sync(() => {
								active[name]--;
							}),
						),
					);
				});
			const head = storage.bucket.headObject.getMockImplementation();
			const copy = storage.bucket.copyObject.getMockImplementation();
			if (!head || !copy) throw new Error("Missing storage fixture");
			const enumerate = await advanceToPhase(
				recording(),
				snapshotCheckpoint(),
				"enumerate",
			);
			storage.bucket.headObject.mockImplementation((key) =>
				track("head", head(key)),
			);
			storage.bucket.copyObject.mockImplementation((source, target, options) =>
				track("copy", copy(source, target, options)),
			);
			const planned = await advanceDesktopRecordingSourceCommit(
				recording(),
				enumerate,
			);
			if (!("checkpoint" in planned)) throw new Error("Unexpected completion");
			expect(peak.head).toBe(expected);
			const source = await finishSnapshot(recording(), planned.checkpoint);
			expect(peak.copy).toBe(expected);
			// Each copy/verify worker checks the copy and its original together, so the
			// bound is on objects in flight; requests peak at two per object.
			expect(peak.head).toBeLessThanOrEqual(expected * 2);
			expect(readInventory(storage, source.inventoryKey).objects).toHaveLength(
				300 + 3,
			);
		},
	);
});

describe("committed source access", () => {
	it("classifies malformed committed inventory JSON as a permanent source error", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		const source = await commitDesktopRecordingSource(recording(), generation);
		const content = "{not-json";
		storage.seed(source.inventoryKey, content);
		await expect(
			buildDesktopRecordingSourceUrls(recording(), {
				...source,
				inventorySha256: hash(content),
			}),
		).rejects.toMatchObject({ code: "source-invalid" });
	});

	it("classifies a missing committed inventory page without retrying it as a worker failure", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		const source = await commitDesktopRecordingSource(recording(), generation);
		const inventory = z
			.object({ roots: z.array(z.object({ key: z.string() })) })
			.parse(JSON.parse(storage.object(source.inventoryKey).body ?? ""));
		const first = inventory.roots[0];
		if (!first) throw new Error("Missing inventory page");
		storage.objects.delete(first.key);
		await expect(
			buildDesktopRecordingSourceUrls(recording(), source),
		).rejects.toMatchObject({ code: "source-missing" });
	});

	it("rejects malformed source entries even when their page and index digests match", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		const source = await commitDesktopRecordingSource(recording(), generation);
		const inventory = z
			.object({
				roots: z.array(
					z.object({ key: z.string(), sha256: z.string() }).passthrough(),
				),
			})
			.passthrough()
			.parse(JSON.parse(storage.object(source.inventoryKey).body ?? ""));
		const first = inventory.roots[0];
		if (!first) throw new Error("Missing inventory page");
		const page = z
			.object({ entries: z.array(z.record(z.unknown())) })
			.passthrough()
			.parse(JSON.parse(storage.object(first.key).body ?? ""));
		page.entries[0] = { ...page.entries[0], size: -1 };
		const pageContent = JSON.stringify(page);
		storage.seed(first.key, pageContent);
		first.sha256 = hash(pageContent);
		const content = JSON.stringify(inventory);
		storage.seed(source.inventoryKey, content);
		await expect(
			buildDesktopRecordingSourceUrls(recording(), {
				...source,
				inventorySha256: hash(content),
			}),
		).rejects.toMatchObject({ code: "source-invalid" });
	});

	it.each([
		"other-user/owned-video/result.mp4",
		"owned-user/other-video/result.mp4",
		`${prefix}/../other-video/result.mp4`,
		`${prefix}/%2e%2e/other-video/result.mp4`,
	])(
		"does not snapshot a foreign or traversing MP4 source %s",
		async (outputKey) => {
			const storage = storageFixture();
			storage.seed(outputKey, "unrelated-recording");
			await expect(
				commitDesktopRecordingSource(
					recording({ type: "desktopMP4", outputKey }),
					generation,
				),
			).rejects.toThrow();
			expect(storage.bucket.copyObject).not.toHaveBeenCalled();
		},
	);

	it("returns immutable URLs paired with their exact copied identities and sizes", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		const source = await commitDesktopRecordingSource(recording(), generation);
		const urls = await buildDesktopRecordingSourceUrls(recording(), source);
		expect(urls.sourceObjects).toHaveLength(5);
		for (const entry of urls.sourceObjects) {
			const key = new URL(entry.url).pathname.slice(1);
			const copied = storage.object(key);
			expect(entry.objectIdentity).toBe(copied.identity);
			expect(entry.size).toBe(copied.size);
			expect(
				key.startsWith(`${prefix}/.recording/sources/${generation}/`),
			).toBe(true);
		}
		storage.object(source.inventoryKey).body += " ";
		await expect(
			buildDesktopRecordingSourceUrls(recording(), source),
		).rejects.toThrow("changed");
	});

	it.each([
		"other-user/owned-video/.recording/sources/generation/inventory.json",
		`${prefix}/.recording/sources/../outside/inventory.json`,
		`${prefix}/.recording/sources/%2e%2e/outside/inventory.json`,
	])(
		"refuses foreign or traversing committed inventory keys %s",
		async (inventoryKey) => {
			const storage = storageFixture();
			seedSegments(storage);
			const source = await commitDesktopRecordingSource(
				recording(),
				generation,
			);
			await expect(
				buildDesktopRecordingSourceUrls(recording(), {
					...source,
					inventoryKey,
				}),
			).rejects.toThrow();
			expect(storage.bucket.getInternalSignedObjectUrl).not.toHaveBeenCalled();
		},
	);

	it("does not sign a foreign object hidden in an otherwise matching inventory", async () => {
		const storage = storageFixture();
		seedSegments(storage);
		const source = await commitDesktopRecordingSource(recording(), generation);
		const inventory = readInventory(storage, source.inventoryKey);
		const firstObject = inventory.objects[0];
		if (!firstObject) throw new Error("Missing source inventory object");
		firstObject.key = "other-user/other-video/.recording/sources/video.mp4";
		const content = JSON.stringify(inventory);
		storage.seed(source.inventoryKey, content);
		await expect(
			buildDesktopRecordingSourceUrls(recording(), {
				...source,
				inventorySha256: hash(content),
			}),
		).rejects.toThrow();
		expect(
			storage.bucket.getInternalSignedObjectUrl.mock.calls.some(([key]) =>
				key.startsWith("other-user/"),
			),
		).toBe(false);
	});

	it("keeps output generations separate and rejects path fragments as identifiers", () => {
		expect(
			getDesktopRecordingOutputKey(
				"owned-user",
				"owned-video",
				generation,
				attempt,
			),
		).toBe(`${prefix}/.recording/outputs/${generation}/${attempt}.mp4`);
		for (const invalid of ["../other", "a/b", "a\\b", "%2e%2e", ""]) {
			expect(() =>
				getDesktopRecordingOutputKey(
					invalid,
					"owned-video",
					generation,
					attempt,
				),
			).toThrow();
			expect(() =>
				getDesktopRecordingOutputKey(
					"owned-user",
					invalid,
					generation,
					attempt,
				),
			).toThrow();
			expect(() =>
				getDesktopRecordingOutputKey(
					"owned-user",
					"owned-video",
					invalid,
					attempt,
				),
			).toThrow();
			expect(() =>
				getDesktopRecordingOutputKey(
					"owned-user",
					"owned-video",
					generation,
					invalid,
				),
			).toThrow();
		}
	});
});
