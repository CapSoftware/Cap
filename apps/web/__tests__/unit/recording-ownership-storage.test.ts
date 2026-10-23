import { createHash } from "node:crypto";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOwnershipMediaStore } from "@/lib/recording-ownership-storage";
import { ownershipHash } from "@/lib/recording-ownership-transfer";

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));

type Access = Parameters<typeof makeOwnershipMediaStore>[0];

function storageFixture() {
	const head = {
		VersionId: undefined as string | undefined,
		ContentLength: 9,
		ETag: '"test-source"',
		ContentType: "video/mp4",
		Metadata: { fixture: "synthetic" } as Record<string, string>,
	};
	const access = {
		provider: "s3" as const,
		bucketName: "test-bucket",
		headObject: vi.fn(() => Effect.succeed(head)),
		getInternalSignedObjectUrl: vi.fn(() =>
			Effect.succeed("https://storage.example.test/object"),
		),
		listObjects: vi.fn(() =>
			Effect.succeed({
				Contents: [{ Key: "test-owner/test-video/result.mp4" }],
				IsTruncated: false,
			}),
		),
		multipart: {
			create: vi.fn(() => Effect.succeed({ UploadId: "test-upload" })),
			copyPart: vi.fn(() =>
				Effect.succeed({
					CopyPartResult: { ETag: '"test-part"' },
					$metadata: {},
				}),
			),
			complete: vi.fn(() => Effect.succeed({ ETag: '"test-destination"' })),
			abort: vi.fn(() => Effect.succeed({})),
		},
	};
	return {
		access,
		head,
		store: makeOwnershipMediaStore(access as unknown as Access),
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("ownership transfer storage adapter", () => {
	it.each(["valid", "oversized", "truncated", "checksum", "invalid-json"])(
		"bounds and verifies archived JSON reads: %s",
		async (mode) => {
			const { store, access } = storageFixture();
			const bytes = mode === "invalid-json" ? "synthetic" : '{"version":1}';
			const fetch = vi.fn(
				async () => new Response(mode === "truncated" ? "{}" : bytes),
			);
			vi.stubGlobal("fetch", fetch);
			const object = {
				key: "test-owner/test-video/inventory.json",
				size:
					mode === "oversized" ? 4 * 1024 * 1024 + 1 : Buffer.byteLength(bytes),
				identity: '"test-json"',
				sha256:
					mode === "checksum"
						? "a".repeat(64)
						: createHash("sha256").update(bytes).digest("hex"),
				contentType: "application/json",
				metadataHash: ownershipHash({}),
				copyMetadataHash: ownershipHash({}),
			};
			if (mode === "valid") {
				await expect(store.readJson(object)).resolves.toEqual({ version: 1 });
				expect(fetch).toHaveBeenCalledWith(
					"https://storage.example.test/object",
					expect.objectContaining({
						headers: {
							"If-Match": object.identity,
							"Accept-Encoding": "identity",
						},
						redirect: "error",
					}),
				);
			} else {
				await expect(store.readJson(object)).rejects.toThrow(
					mode === "oversized"
						? "UNSUPPORTED"
						: mode === "invalid-json"
							? "INVALID_REFERENCE"
							: "MEDIA_CHANGED",
				);
			}
			if (mode === "oversized") expect(fetch).not.toHaveBeenCalled();
			expect(access.multipart.create).not.toHaveBeenCalled();
		},
	);

	it("strips stale metadata and MIME parameters at object creation", async () => {
		const { store, head, access } = storageFixture();
		head.Metadata = {
			userid: "test-owner",
			duration: "1",
			videocodec: "h264",
			source: "synthetic",
		};
		head.ContentType = "video/mp4; name=synthetic.mp4";
		await store.copyIfAbsent(
			{
				key: "test-owner/test-video/result.mp4",
				size: 9,
				identity: head.ETag,
				contentType: "video/mp4",
				sha256: "a".repeat(64),
				metadataHash: ownershipHash(head.Metadata),
				copyMetadataHash: ownershipHash({ duration: "1", videocodec: "h264" }),
			},
			"test-target/test-video/result.mp4",
		);
		expect(access.multipart.create).toHaveBeenCalledWith(
			"test-target/test-video/result.mp4",
			{
				ContentType: "video/mp4",
				Metadata: { duration: "1", videocodec: "h264" },
			},
		);
	});
	it("streams a conditional read, hashes content and rechecks the object identity", async () => {
		const { store, access } = storageFixture();
		const fetch = vi.fn(async () => new Response("synthetic"));
		vi.stubGlobal("fetch", fetch);
		const object = await store.inspect("test-owner/test-video/result.mp4");
		expect(object).toMatchObject({
			size: 9,
			identity: '"test-source"',
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(access.headObject).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledWith(
			"https://storage.example.test/object",
			expect.objectContaining({
				redirect: "error",
				headers: { "If-Match": '"test-source"', "Accept-Encoding": "identity" },
			}),
		);
	});

	it("pins version-aware reads and copy sources", async () => {
		const { store, head, access } = storageFixture();
		head.VersionId = "synthetic-version";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("synthetic")),
		);
		const object = await store.inspect("test-owner/test-video/result.mp4");
		expect(object.versionId).toBe("synthetic-version");
		expect(access.getInternalSignedObjectUrl).toHaveBeenCalledWith(object.key, {
			versionId: "synthetic-version",
		});
		await store.copyIfAbsent(object, "test-target/test-video/result.mp4");
		expect(access.multipart.copyPart).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			1,
			expect.objectContaining({
				CopySource:
					"test-bucket/test-owner/test-video/result.mp4?versionId=synthetic-version",
			}),
		);
	});
	it("holds replaced versions even with identical ETags", async () => {
		const { store, head, access } = storageFixture();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("synthetic")),
		);
		access.headObject
			.mockImplementationOnce(() =>
				Effect.succeed({ ...head, VersionId: "synthetic-before" }),
			)
			.mockImplementationOnce(() =>
				Effect.succeed({ ...head, VersionId: "synthetic-after" }),
			);
		await expect(
			store.inspect("test-owner/test-video/result.mp4"),
		).rejects.toThrow("MEDIA_CHANGED");
	});

	it("fails closed on a truncated read or a changed source", async () => {
		const { store, access } = storageFixture();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("short")),
		);
		await expect(
			store.inspect("test-owner/test-video/result.mp4"),
		).rejects.toThrow("MEDIA_CHANGED");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("synthetic")),
		);
		access.headObject.mockImplementationOnce(() =>
			Effect.succeed({
				VersionId: undefined,
				ContentLength: 9,
				ETag: '"before"',
				ContentType: "video/mp4",
				Metadata: { fixture: "synthetic" } as Record<string, string>,
			}),
		);
		await expect(
			store.inspect("test-owner/test-video/result.mp4"),
		).rejects.toThrow("MEDIA_CHANGED");
	});

	it("holds a content type change even when bytes and identity are unchanged", async () => {
		const { store, access, head } = storageFixture();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("synthetic")),
		);
		access.headObject
			.mockImplementationOnce(() => Effect.succeed({ ...head }))
			.mockImplementationOnce(() =>
				Effect.succeed({ ...head, ContentType: "audio/mp4" }),
			);
		await expect(
			store.inspect("test-owner/test-video/result.mp4"),
		).rejects.toThrow("MEDIA_CHANGED");
	});

	it("uses conditional multipart publication for small objects and encodes source keys", async () => {
		const { store, access } = storageFixture();
		await store.copyIfAbsent(
			{
				key: "test-owner/test-video/raw #1.mp4",
				size: 9,
				identity: '"test-source"',
				sha256: "a".repeat(64),
				contentType: "video/mp4",
				metadataHash: ownershipHash({ fixture: "synthetic" }),
				copyMetadataHash: ownershipHash({}),
			},
			"test-target/test-video/raw #1.mp4",
		);
		expect(access.multipart.copyPart).toHaveBeenCalledWith(
			"test-target/test-video/raw #1.mp4",
			"test-upload",
			1,
			{
				CopySource: "test-bucket/test-owner/test-video/raw%20%231.mp4",
				CopySourceIfMatch: '"test-source"',
				CopySourceRange: "bytes=0-8",
			},
		);
		expect(access.multipart.complete).toHaveBeenCalledWith(
			"test-target/test-video/raw #1.mp4",
			"test-upload",
			{
				IfNoneMatch: "*",
				MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"test-part"' }] },
			},
		);
		expect(access.multipart.abort).not.toHaveBeenCalled();
	});

	it("copies large objects in bounded conditional parts", async () => {
		const { store, access, head } = storageFixture();
		head.ContentLength = 5 * 1024 ** 3 + 1;
		await store.copyIfAbsent(
			{
				key: "test-owner/test-video/result.mp4",
				size: head.ContentLength,
				identity: head.ETag,
				sha256: "a".repeat(64),
				contentType: "video/mp4",
				metadataHash: ownershipHash({ fixture: "synthetic" }),
				copyMetadataHash: ownershipHash({}),
			},
			"test-target/test-video/result.mp4",
		);
		expect(access.multipart.copyPart.mock.calls.length).toBeGreaterThan(1);
		expect(access.multipart.complete).toHaveBeenCalledOnce();
	});

	it("aborts incomplete multipart copies without removing any object", async () => {
		const { store, access } = storageFixture();
		access.multipart.copyPart.mockImplementation(() =>
			Effect.die(new Error("Synthetic part failure")),
		);
		await expect(
			store.copyIfAbsent(
				{
					key: "test-owner/test-video/result.mp4",
					size: 9,
					identity: '"test-source"',
					sha256: "a".repeat(64),
					contentType: "video/mp4",
					metadataHash: ownershipHash({ fixture: "synthetic" }),
					copyMetadataHash: ownershipHash({}),
				},
				"test-target/test-video/result.mp4",
			),
		).rejects.toThrow("STORAGE_FAILED");
		expect(access.multipart.complete).not.toHaveBeenCalled();
		expect(access.multipart.abort).toHaveBeenCalledOnce();
	});

	it("rejects a source that changed before multipart creation", async () => {
		const { store, access } = storageFixture();
		await expect(
			store.copyIfAbsent(
				{
					key: "test-owner/test-video/result.mp4",
					size: 9,
					identity: '"old-source"',
					sha256: "a".repeat(64),
					contentType: "video/mp4",
					metadataHash: ownershipHash({ fixture: "synthetic" }),
					copyMetadataHash: ownershipHash({}),
				},
				"test-target/test-video/result.mp4",
			),
		).rejects.toThrow("MEDIA_CHANGED");
		expect(access.multipart.create).not.toHaveBeenCalled();
	});

	it.each(["missing", "repeated"])(
		"holds %s continuation tokens",
		async (mode) => {
			const { access } = storageFixture();
			const malformed = {
				...access,
				listObjects: () =>
					Effect.succeed({
						Contents: [],
						IsTruncated: true,
						NextContinuationToken:
							mode === "repeated" ? "test-token" : undefined,
					}),
			};
			await expect(
				makeOwnershipMediaStore(malformed as unknown as Access).list(
					"test-owner/test-video/",
				),
			).rejects.toThrow("STORAGE_FAILED");
		},
	);

	it("enumerates every page before returning the inventory", async () => {
		const { access } = storageFixture();
		const listObjects = vi.fn(
			({ continuationToken }: { continuationToken?: string }) =>
				Effect.succeed({
					Contents: [
						{
							Key: `test-owner/test-video/${continuationToken ? "last" : "first"}.mp4`,
						},
					],
					IsTruncated: !continuationToken,
					NextContinuationToken: continuationToken ? undefined : "test-token",
				}),
		);
		const store = makeOwnershipMediaStore({
			...access,
			listObjects,
		} as unknown as Access);
		expect(await store.list("test-owner/test-video/")).toEqual([
			"test-owner/test-video/first.mp4",
			"test-owner/test-video/last.mp4",
		]);
		expect(listObjects).toHaveBeenCalledTimes(2);
	});

	it("holds storage without conditional copy support", () => {
		const { access } = storageFixture();
		expect(() =>
			makeOwnershipMediaStore({
				...access,
				provider: "googleDrive",
			} as unknown as Access),
		).toThrow("UNSUPPORTED");
		expect(() =>
			makeOwnershipMediaStore({
				...access,
				multipart: { ...access.multipart, copyPart: undefined },
			} as unknown as Access),
		).toThrow("UNSUPPORTED");
	});
});
