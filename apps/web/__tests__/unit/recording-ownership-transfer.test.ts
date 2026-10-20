import { createHash } from "node:crypto";
import { resolveRecordingObjectKey } from "@cap/web-backend/src/Storage/recording-output";
import { User } from "@cap/web-domain";
import { describe, expect, it, vi } from "vitest";
import { recordingUploadReceiptSchema } from "@/lib/desktop-recording-verification";
import {
	copyOwnershipMedia,
	inspectTransferMedia,
	ownershipCopyMetadata,
	ownershipHash,
	planOwnershipTransfer,
	requireTransferReady,
	transferredOwnershipFields,
	verifyTransferMedia,
} from "@/lib/recording-ownership-transfer";
import {
	legacyOwnershipFixture,
	mediaFixture,
	ownershipFixture,
	sourcePrefix,
	targetPrefix,
} from "../helpers/ownership-transfer";

describe("recording ownership transfer", () => {
	it("copies technical metadata without former ownership, arbitrary labels or filenames", () => {
		expect(
			ownershipCopyMetadata({
				userid: "test-owner",
				email: "synthetic@example.test",
				source: "synthetic-upload",
				filename: "synthetic.mp4",
				duration: "1.5",
				resolution: "640x480",
				videocodec: "h264",
				audiocodec: "aac",
				"cap-source-key": "a".repeat(64),
				unknown: "synthetic",
			}),
		).toEqual({
			duration: "1.5",
			resolution: "640x480",
			videocodec: "h264",
			audiocodec: "aac",
			"cap-source-key": "a".repeat(64),
		});
	});

	it("holds identical destination bytes with stale owner metadata", async () => {
		const { objects, store } = mediaFixture();
		const key = `${sourcePrefix}.recording/outputs/test/thumbnail.jpg`;
		const source = objects.get(key);
		if (!source) throw new Error("Missing synthetic fixture");
		objects.set(key.replace(sourcePrefix, targetPrefix), {
			...source,
			metadata: { userid: "test-owner" },
		});
		await expect(
			planOwnershipTransfer(ownershipFixture(), "test-target", null, store),
		).rejects.toThrow("DESTINATION_CONFLICT");
		expect(store.copyIfAbsent).not.toHaveBeenCalled();
	});

	it.each([
		"valid",
		"page-url",
		"page-path",
		"page-array",
		"page-version",
		"manifest-url",
		"manifest-path",
		"manifest-array",
		"manifest-version",
	])(
		"validates strict paged inventory and manifest evidence: %s",
		async (change) => {
			const unknown = (location: string) => {
				if (!change.startsWith(`${location}-`)) return {};
				const form = change.slice(location.length + 1);
				return {
					[form]:
						form === "version"
							? "future"
							: form === "array"
								? ["test-outside/object.mp4"]
								: form === "url"
									? "https://media.example.test/object.mp4"
									: "test-outside/object.mp4",
				};
			};
			const { objects, store } = mediaFixture();
			const snapshot = ownershipFixture();
			const directory = `${sourcePrefix}.recording/sources/test`;
			const inventoryKey = `${directory}/inventory.json`;
			const pageKey = `${directory}/page.json`;
			const manifest = JSON.stringify({
				version: 1,
				video_init_uploaded: true,
				audio_init_uploaded: false,
				video_segments: [1],
				audio_segments: [],
				is_complete: true,
				...unknown("manifest"),
			});
			const hash = (bytes: string) =>
				createHash("sha256").update(bytes).digest("hex");
			const entries = [0, 1].map((index) => {
				const key = `${sourcePrefix}segments/video/${index}.mp4`;
				objects.set(key, { bytes: "synthetic", identity: '"test-segment"' });
				return {
					key,
					originalKey: key,
					objectIdentity: '"test-segment"',
					originalIdentity: '"test-segment"',
					size: 9,
					track: "video",
					index,
				};
			});
			const scope = "a".repeat(64);
			const page = JSON.stringify({
				version: 1,
				type: "leaf",
				kind: "objects",
				scope,
				start: 0,
				entries,
				...unknown("page"),
			});
			const inventory = JSON.stringify({
				version: 2,
				kind: "segments",
				manifestSha256: hash(manifest),
				objectCount: 2,
				scope,
				roots: [
					{ key: pageKey, sha256: hash(page), start: 0, count: 2, level: 0 },
				],
			});
			objects.set(pageKey, { bytes: page, identity: '"test-page"' });
			objects.set(inventoryKey, {
				bytes: inventory,
				identity: '"test-inventory"',
			});
			objects.set(`${directory}/manifest.json`, {
				bytes: manifest,
				identity: '"test-manifest"',
			});
			if (!snapshot.processing) throw new Error("Missing synthetic fixture");
			snapshot.processing.source = {
				version: 1,
				kind: "segments",
				requiredAudio: false,
				manifestSha256: hash(manifest),
				inventoryKey,
				inventorySha256: hash(inventory),
			};
			if (change !== "valid") {
				await expect(
					planOwnershipTransfer(snapshot, "test-target", null, store),
				).rejects.toThrow("UNSUPPORTED");
				expect(store.copyIfAbsent).not.toHaveBeenCalled();
				return;
			}
			await expect(
				planOwnershipTransfer(snapshot, "test-target", null, store),
			).resolves.toMatchObject({ videoId: "test-video" });
			objects.delete(`${sourcePrefix}segments/video/1.mp4`);
			await expect(
				planOwnershipTransfer(snapshot, "test-target", null, store),
			).rejects.toThrow("INVALID_REFERENCE");
		},
	);

	it("verifies immutable archived receipts against retained output objects", async () => {
		const snapshot = ownershipFixture();
		if (!snapshot.processing) throw new Error("Missing synthetic fixture");
		snapshot.processing.output = {
			...snapshot.video.metadata?.desktopRecordingUpload,
			verifiedAt: "2025-01-01T00:00:00Z",
		};
		const original = structuredClone(snapshot.processing);
		const { store } = mediaFixture();
		const plan = await planOwnershipTransfer(
			snapshot,
			"test-target",
			null,
			store,
		);
		transferredOwnershipFields(plan, await copyOwnershipMedia(plan, store));
		expect(snapshot.processing).toEqual(original);
		snapshot.processing.output = {
			...(snapshot.processing.output as object),
			objectIdentity: '"changed"',
		};
		await expect(
			planOwnershipTransfer(snapshot, "test-target", null, store),
		).rejects.toThrow("MEDIA_CHANGED");
	});

	it("holds changed archived checksums and missing media comment thumbnails", async () => {
		const snapshot = ownershipFixture();
		const { store, objects } = mediaFixture();
		if (!snapshot.processing) throw new Error("Missing synthetic fixture");
		snapshot.processing.source = {
			...(snapshot.processing.source as Record<string, unknown>),
			inventorySha256: "f".repeat(64),
		};
		await expect(
			planOwnershipTransfer(snapshot, "test-target", null, store),
		).rejects.toThrow("MEDIA_CHANGED");
		snapshot.processing = null;
		objects.delete(`${sourcePrefix}comments/test-comment/thumbnail.jpg`);
		await expect(
			planOwnershipTransfer(snapshot, "test-target", null, store),
		).rejects.toThrow("INVALID_REFERENCE");
	});

	it("holds incomplete byte counts and legacy source types", () => {
		const snapshot = ownershipFixture();
		if (snapshot.upload) snapshot.upload.uploaded = 0;
		expect(() => requireTransferReady(snapshot)).toThrow("NOT_READY");
		if (snapshot.upload) snapshot.upload.uploaded = snapshot.upload.total;
		snapshot.video.source = { type: "desktopSegments" };
		expect(() => requireTransferReady(snapshot)).toThrow("UNSUPPORTED");
	});
	it("plans without writes and copies every object while retaining the source", async () => {
		const snapshot = ownershipFixture();
		const { store, objects } = mediaFixture();
		const original = structuredClone([...objects]);
		const plan = await planOwnershipTransfer(
			snapshot,
			"test-target",
			null,
			store,
		);
		expect(store.copyIfAbsent).not.toHaveBeenCalled();
		expect([...objects]).toEqual(original);
		const copied = await copyOwnershipMedia(plan, store);
		expect(copied).toHaveLength(original.length);
		for (const [key, object] of original) {
			expect(objects.get(key)).toEqual(object);
			expect(objects.get(key.replace(sourcePrefix, targetPrefix))?.bytes).toBe(
				object.bytes,
			);
		}
		expect(snapshot).toEqual(ownershipFixture());
	});

	it("rewrites explicit source, edit, upload and metadata keys without changing source proof", async () => {
		const snapshot = ownershipFixture();
		const { store } = mediaFixture();
		const plan = await planOwnershipTransfer(
			snapshot,
			"test-target",
			"test-dest",
			store,
		);
		const copied = await copyOwnershipMedia(plan, store);
		const fields = transferredOwnershipFields(plan, copied);
		expect(fields.ownerId).toBe("test-target");
		expect(fields.folderId).toBe("test-dest");
		expect(fields.source).toEqual({
			type: "desktopMP4",
			outputKey: `${targetPrefix}.recording/outputs/test/result.mp4`,
			audioLevelOutputKey: `${targetPrefix}.recording/outputs/audio-quality-v3/test/result.mp4`,
			audioLevelSourceKey: `${targetPrefix}.recording/outputs/test/result.mp4`,
			thumbnailKey: `${targetPrefix}.recording/outputs/test/thumbnail.jpg`,
			previewKey: `${targetPrefix}.recording/outputs/test/preview.gif`,
		});
		expect(fields.rawFileKey).toBe(`${targetPrefix}source/original.mp4`);
		expect(fields.editSourceKey).toBe(fields.rawFileKey);
		expect(fields.agentUpload?.rawFileKey).toBe(fields.rawFileKey);
		expect(fields.desktopRecordingUpload?.objectIdentity).toBe(
			copied.find(
				(object) => object.key === fields.desktopRecordingUpload?.outputKey,
			)?.identity,
		);
		expect(
			recordingUploadReceiptSchema.safeParse(fields.desktopRecordingUpload)
				.success,
		).toBe(true);
		expect(fields.desktopRecordingUpload?.artifact).toEqual(
			snapshot.video.metadata?.desktopRecordingUpload?.artifact,
		);
		const published = {
			id: plan.videoId,
			ownerId: fields.ownerId,
			source: fields.source,
		};
		for (const canonical of [
			"result.mp4",
			"screenshot/screen-capture.jpg",
			"preview/animated-preview.gif",
		]) {
			const key = resolveRecordingObjectKey(
				published,
				`${targetPrefix}${canonical}`,
			);
			expect(copied.some((object) => object.key === key)).toBe(true);
			expect(key.startsWith(targetPrefix)).toBe(true);
		}
	});

	it("supports canonical MP4 keys without explicit source overrides", async () => {
		const snapshot = ownershipFixture();
		snapshot.video.source = { type: "webMP4" };
		snapshot.video.metadata = null;
		snapshot.processing = null;
		const { store, objects } = mediaFixture();
		objects.set(`${sourcePrefix}result.mp4`, {
			bytes: "synthetic-result",
			identity: '"result"',
		});
		const plan = await planOwnershipTransfer(
			snapshot,
			"test-target",
			null,
			store,
		);
		expect(
			transferredOwnershipFields(plan, await copyOwnershipMedia(plan, store))
				.source,
		).toEqual({ type: "webMP4" });
	});

	it("reuses verified copies on retry and resolves a lost copy response", async () => {
		const { store } = mediaFixture();
		const plan = await planOwnershipTransfer(
			ownershipFixture(),
			"test-target",
			null,
			store,
		);
		const copy = store.copyIfAbsent;
		store.copyIfAbsent = vi.fn(async (...args: Parameters<typeof copy>) => {
			await copy(...args);
			throw new Error("Synthetic response lost");
		});
		const first = await copyOwnershipMedia(plan, store);
		const count = vi.mocked(store.copyIfAbsent).mock.calls.length;
		expect(await copyOwnershipMedia(plan, store)).toEqual(first);
		expect(store.copyIfAbsent).toHaveBeenCalledTimes(count);
	});

	it("serializes concurrent copies through destination preconditions", async () => {
		const { store, objects } = mediaFixture();
		const plan = await planOwnershipTransfer(
			ownershipFixture(),
			"test-target",
			null,
			store,
		);
		const copies = await Promise.all([
			copyOwnershipMedia(plan, store),
			copyOwnershipMedia(plan, store),
		]);
		expect(copies[0]).toEqual(copies[1]);
		expect(objects.size).toBe(plan.objects.length * 2);
	});

	it("resumes after a partial copy failure without discarding originals", async () => {
		const { store, objects } = mediaFixture();
		const plan = await planOwnershipTransfer(
			ownershipFixture(),
			"test-target",
			null,
			store,
		);
		const copy = store.copyIfAbsent;
		let attempt = 0;
		store.copyIfAbsent = vi.fn(async (...args: Parameters<typeof copy>) => {
			if (++attempt === 3) throw new Error("Synthetic copy unavailable");
			await copy(...args);
		});
		await expect(copyOwnershipMedia(plan, store)).rejects.toThrow();
		expect(
			[...objects.keys()].filter((key) => key.startsWith(sourcePrefix)),
		).toHaveLength(plan.objects.length);
		store.copyIfAbsent = copy;
		await expect(copyOwnershipMedia(plan, store)).resolves.toHaveLength(
			plan.objects.length,
		);
	});

	it("rejects equal-sized corrupt destinations before writing anything", async () => {
		const { store, objects } = mediaFixture();
		objects.set(`${targetPrefix}.recording/outputs/test/thumbnail.jpg`, {
			bytes: "corrupted-3",
			identity: '"wrong"',
		});
		await expect(
			planOwnershipTransfer(ownershipFixture(), "test-target", null, store),
		).rejects.toThrow("DESTINATION_CONFLICT");
		expect(store.copyIfAbsent).not.toHaveBeenCalled();
	});

	it("holds destination objects outside the expected inventory", async () => {
		const { store, objects } = mediaFixture();
		objects.set(`${targetPrefix}unexpected.mp4`, {
			bytes: "synthetic",
			identity: '"other"',
		});
		await expect(
			planOwnershipTransfer(ownershipFixture(), "test-target", null, store),
		).rejects.toThrow("DESTINATION_CONFLICT");
	});

	it.each(["identity", "bytes", "added", "removed"])(
		"detects source %s changes after preview",
		async (change) => {
			const { store, objects } = mediaFixture();
			const plan = await planOwnershipTransfer(
				ownershipFixture(),
				"test-target",
				null,
				store,
			);
			const key = `${sourcePrefix}.recording/outputs/test/thumbnail.jpg`;
			const object = objects.get(key);
			if (!object) throw new Error("Missing synthetic fixture");
			if (change === "identity") object.identity = '"new-identity"';
			if (change === "bytes") object.bytes = "changed-333";
			if (change === "added")
				objects.set(`${sourcePrefix}extra.json`, {
					bytes: "{}",
					identity: '"extra"',
				});
			if (change === "removed") objects.delete(key);
			await expect(copyOwnershipMedia(plan, store)).rejects.toThrow(
				"MEDIA_CHANGED",
			);
			expect(store.copyIfAbsent).not.toHaveBeenCalled();
		},
	);

	it("detects same-sized corruption during copy", async () => {
		const { store, objects } = mediaFixture();
		const plan = await planOwnershipTransfer(
			ownershipFixture(),
			"test-target",
			null,
			store,
		);
		store.copyIfAbsent = vi.fn(async (object, key) => {
			objects.set(key, { bytes: "x".repeat(object.size), identity: '"copy"' });
		});
		await expect(copyOwnershipMedia(plan, store)).rejects.toThrow(
			"DESTINATION_CONFLICT",
		);
	});

	it("requires unchanged original and destination objects before rollback", async () => {
		const { store, objects } = mediaFixture();
		const plan = await planOwnershipTransfer(
			ownershipFixture(),
			"test-target",
			null,
			store,
		);
		const copies = await copyOwnershipMedia(plan, store);
		await expect(
			verifyTransferMedia(plan, store, copies),
		).resolves.toBeUndefined();
		objects.set(`${targetPrefix}.recording/outputs/test/thumbnail.jpg`, {
			bytes: "new-version",
			identity: '"new"',
		});
		await expect(verifyTransferMedia(plan, store, copies)).rejects.toThrow(
			"MEDIA_CHANGED",
		);
	});

	it.each([
		"uploading",
		"processing",
		"generating_thumbnail",
		"error",
	] as const)("holds %s recordings", async (phase) => {
		const snapshot = ownershipFixture();
		if (snapshot.upload) snapshot.upload.phase = phase;
		const { store } = mediaFixture();
		await expect(
			planOwnershipTransfer(snapshot, "test-target", null, store),
		).rejects.toThrow("NOT_READY");
		expect(store.list).not.toHaveBeenCalled();
	});

	it("holds missing completion records and active sidecar work", () => {
		for (const modify of [
			(snapshot: ReturnType<typeof ownershipFixture>) => {
				snapshot.video.transcriptionStatus = null;
			},
			(snapshot: ReturnType<typeof ownershipFixture>) => {
				if (snapshot.processing) snapshot.processing.state = "retry";
			},
			(snapshot: ReturnType<typeof ownershipFixture>) => {
				snapshot.video.metadata = { enhancedAudioStatus: "PROCESSING" };
			},
			(snapshot: ReturnType<typeof ownershipFixture>) => {
				snapshot.video.metadata = { liveTranscript: { status: "active" } };
			},
			(snapshot: ReturnType<typeof ownershipFixture>) => {
				snapshot.video.metadata = { agentUpload: { state: "pending" } };
			},
		]) {
			const snapshot = ownershipFixture();
			modify(snapshot);
			expect(() => requireTransferReady(snapshot)).toThrow("NOT_READY");
		}
	});

	it.each([
		"outputKey",
		"audioLevelOutputKey",
		"audioLevelSourceKey",
		"thumbnailKey",
		"previewKey",
	] as const)(
		"requires the %s reference to be present and in scope",
		async (field) => {
			const snapshot = ownershipFixture();
			if (snapshot.video.source.type !== "desktopMP4")
				throw new Error("Invalid synthetic source");
			snapshot.video.source[field] = "test-other/test-video/missing.mp4";
			await expect(
				planOwnershipTransfer(
					snapshot,
					"test-target",
					null,
					mediaFixture().store,
				),
			).rejects.toThrow("INVALID_REFERENCE");
		},
	);

	it("holds absent edit, raw and finalized job references", async () => {
		for (const modify of [
			(snapshot: ReturnType<typeof ownershipFixture>) => {
				if (snapshot.edit)
					snapshot.edit.sourceKey = `${sourcePrefix}missing.mp4`;
			},
			(snapshot: ReturnType<typeof ownershipFixture>) => {
				if (snapshot.upload)
					snapshot.upload.rawFileKey = `${sourcePrefix}missing.mp4`;
			},
			(snapshot: ReturnType<typeof ownershipFixture>) => {
				if (snapshot.processing)
					snapshot.processing.source = {
						...(snapshot.processing.source as Record<string, unknown>),
						inventoryKey: `${sourcePrefix}missing.json`,
					};
			},
		]) {
			const snapshot = ownershipFixture();
			modify(snapshot);
			await expect(
				planOwnershipTransfer(
					snapshot,
					"test-target",
					null,
					mediaFixture().store,
				),
			).rejects.toThrow("INVALID_REFERENCE");
		}
	});

	it("rejects empty, duplicate, unsafe and excessive inventories", async () => {
		for (const keys of [
			[],
			[`${sourcePrefix}a`, `${sourcePrefix}a`],
			[`${sourcePrefix}../bad`],
			["test-other/test-video/a"],
			Array.from({ length: 10_001 }, (_, index) => `${sourcePrefix}${index}`),
		]) {
			const { store } = mediaFixture();
			store.list = async () => keys;
			await expect(inspectTransferMedia(store, sourcePrefix)).rejects.toThrow(
				"INVALID_REFERENCE",
			);
		}
	});

	it("binds snapshot fingerprints to processing, storage and edit state, independent of key order", () => {
		const snapshot = ownershipFixture();
		expect(ownershipHash(snapshot)).toBe(
			ownershipHash(JSON.parse(JSON.stringify(snapshot))),
		);
		const modified = ownershipFixture();
		modified.video.ownerId = User.UserId.make("test-new-owner");
		expect(ownershipHash(snapshot)).not.toBe(ownershipHash(modified));
	});
	it("qualifies absent upload rows using a decoded receipt and a stable complete inventory", async () => {
		const snapshot = legacyOwnershipFixture();
		const { store } = mediaFixture();
		const plan = await planOwnershipTransfer(
			snapshot,
			"test-target",
			null,
			store,
		);
		expect(plan.completion).toBe("legacy-receipt");
		expect(snapshot.upload).toBeNull();
		expect(store.copyIfAbsent).not.toHaveBeenCalled();
		const changed = legacyOwnershipFixture();
		if (changed.video.metadata?.desktopRecordingUpload)
			changed.video.metadata.desktopRecordingUpload.duration = 2;
		expect(ownershipHash(changed)).not.toBe(plan.snapshotHash);
	});

	it.each([
		"receipt",
		"output",
		"active-job",
		"active-edit",
		"active-transcription",
		"active-audio",
		"ambiguous-output",
		"changed-object",
	])("holds absent-row recordings with %s evidence", async (change) => {
		const snapshot = legacyOwnershipFixture();
		const { store, objects } = mediaFixture();
		if (change === "receipt") snapshot.video.metadata = null;
		if (change === "output")
			objects.delete(`${sourcePrefix}.recording/outputs/test/result.mp4`);
		if (change === "active-job" && snapshot.processing)
			snapshot.processing.state = "processing";
		if (change === "active-edit")
			snapshot.video.metadata = {
				...snapshot.video.metadata,
				editProcessing: {
					token: "test-edit",
					startedAt: "2025-01-01T00:00:00Z",
					ownerId: "test-owner",
					bucket: null,
					storageIntegrationId: null,
					sourceKey: `${sourcePrefix}source/original.mp4`,
					source: "mp4",
					dispatch: "pending",
				},
			};
		if (change === "active-transcription")
			snapshot.video.transcriptionStatus = "PROCESSING";
		if (change === "active-audio")
			snapshot.video.metadata = {
				...snapshot.video.metadata,
				enhancedAudioStatus: "PROCESSING",
			};
		if (
			change === "ambiguous-output" &&
			snapshot.video.source.type === "desktopMP4"
		)
			snapshot.video.source.outputKey = `${sourcePrefix}source/original.mp4`;
		if (change === "changed-object")
			objects.set(`${sourcePrefix}.recording/outputs/test/result.mp4`, {
				bytes: "incomplete",
				identity: '"changed"',
			});
		await expect(
			planOwnershipTransfer(snapshot, "test-target", null, store),
		).rejects.toThrow();
		expect(store.copyIfAbsent).not.toHaveBeenCalled();
	});

	it("holds a legacy inventory that changes during completion qualification", async () => {
		const { store, objects } = mediaFixture();
		const list = store.list;
		let reads = 0;
		store.list = async (prefix) => {
			if (++reads === 2)
				objects.set(`${sourcePrefix}partial.mp4`, {
					bytes: "synthetic",
					identity: '"partial"',
				});
			return list(prefix);
		};
		await expect(
			planOwnershipTransfer(
				legacyOwnershipFixture(),
				"test-target",
				null,
				store,
			),
		).rejects.toThrow("MEDIA_CHANGED");
	});

	it.each(["url", "path", "array", "version"])(
		"holds unknown archived %s forms before any copy",
		async (form) => {
			for (const location of [
				"source",
				"output",
				"inventory",
				"entry",
			] as const) {
				const snapshot = ownershipFixture();
				const { store, objects } = mediaFixture();
				if (!snapshot.processing) throw new Error("Missing synthetic fixture");
				const unknown =
					form === "version"
						? { version: 99 }
						: {
								[form]:
									form === "array"
										? ["test-outside/object.mp4"]
										: form === "url"
											? "https://media.example.test/object.mp4"
											: "test-outside/object.mp4",
							};
				if (location === "source")
					snapshot.processing.source = {
						...(snapshot.processing.source as object),
						...unknown,
					};
				if (location === "output")
					snapshot.processing.output = {
						...snapshot.video.metadata?.desktopRecordingUpload,
						verifiedAt: "2025-01-01T00:00:00Z",
						...unknown,
					};
				if (location === "inventory" || location === "entry") {
					const source = snapshot.processing.source as {
						inventoryKey: string;
						inventorySha256: string;
					};
					const stored = objects.get(source.inventoryKey);
					if (!stored) throw new Error("Missing synthetic inventory");
					const inventory = JSON.parse(stored.bytes) as { objects: object[] };
					if (location === "entry")
						inventory.objects[0] = { ...inventory.objects[0], ...unknown };
					else Object.assign(inventory, unknown);
					stored.bytes = JSON.stringify(inventory);
					source.inventorySha256 = createHash("sha256")
						.update(stored.bytes)
						.digest("hex");
				}
				await expect(
					planOwnershipTransfer(snapshot, "test-target", null, store),
				).rejects.toThrow("UNSUPPORTED");
				expect(store.copyIfAbsent).not.toHaveBeenCalled();
			}
		},
	);
});
