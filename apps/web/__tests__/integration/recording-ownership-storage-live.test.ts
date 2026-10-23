import { createHash } from "node:crypto";
import * as S3 from "@aws-sdk/client-s3";
import { Organisation, User, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const state = vi.hoisted(() => ({
	access: undefined as
		| Effect.Effect.Success<
				typeof import("@cap/web-backend/src/S3Buckets/S3BucketAccess").createS3BucketAccess
		  >
		| undefined,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@cap/web-backend/src/S3Buckets/index.ts", async () => {
	const { Effect, Option } = await import("effect");
	class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
		sync: () => ({
			getBucketAccess: () => {
				if (!state.access) throw new Error("Synthetic bucket unavailable");
				return Effect.succeed([state.access, Option.none()] as const);
			},
		}),
	}) {}
	return { S3Buckets };
});
vi.mock("@cap/web-backend/src/Storage/StorageRepo.ts", async () => {
	const { Effect } = await import("effect");
	class StorageRepo extends Effect.Service<StorageRepo>()("StorageRepo", {
		sync: () => ({}),
	}) {}
	return { StorageRepo };
});

import { S3Buckets } from "@cap/web-backend/src/S3Buckets";
import { createS3BucketAccess } from "@cap/web-backend/src/S3Buckets/S3BucketAccess";
import { S3BucketClientProvider } from "@cap/web-backend/src/S3Buckets/S3BucketClientProvider";
import { Storage } from "@cap/web-backend/src/Storage";
import { StorageRepo } from "@cap/web-backend/src/Storage/StorageRepo";
import { makeOwnershipMediaStore } from "@/lib/recording-ownership-storage";
import {
	copyOwnershipMedia,
	type OwnershipTransferPlan,
	ownershipFields,
	type TransferObject,
} from "@/lib/recording-ownership-transfer";
import {
	ownershipFixture,
	sourcePrefix,
	targetPrefix,
} from "../helpers/ownership-transfer";

const enabled = process.env.CAP_OWNERSHIP_STORAGE_INTEGRATION === "synthetic";
const sourceKey = `${sourcePrefix}result.mp4`;
const destinationKey = `${targetPrefix}result.mp4`;
const bytes = Buffer.from("synthetic recording bytes");
let client: S3.S3Client;
let bucketPrefix: string;
let bucket: string;
let counter = 0;
let access: Extract<
	Parameters<typeof makeOwnershipMediaStore>[0],
	{ provider: "s3" }
>;
let store: ReturnType<typeof makeOwnershipMediaStore>;

function hash(value: Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}
async function put(key = sourceKey, body = bytes) {
	return client.send(
		new S3.PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: "video/mp4; name=synthetic.mp4",
			Metadata: { duration: "1", videocodec: "h264", userid: "test-owner" },
		}),
	);
}
function plan(object: TransferObject): OwnershipTransferPlan {
	return {
		version: 1,
		videoId: "test-video",
		organizationId: "test-org",
		bucketId: null,
		before: ownershipFields(ownershipFixture()),
		targetUserId: "test-target",
		destinationFolderId: null,
		snapshotHash: "synthetic-storage-phase",
		originalFolderHash: "synthetic-storage-phase",
		objects: [object],
		completion: "legacy-receipt",
	};
}
async function versions(key: string) {
	const result = await client.send(
		new S3.ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
	);
	return result.Versions?.filter((version) => version.Key === key) ?? [];
}
async function outstandingUploads() {
	const result = await client.send(
		new S3.ListMultipartUploadsCommand({ Bucket: bucket }),
	);
	return result.Uploads ?? [];
}

describe.skipIf(!enabled)(
	"isolated S3 recording ownership qualification",
	() => {
		beforeAll(async () => {
			const endpoint = process.env.CAP_OWNERSHIP_TEST_S3_ENDPOINT;
			const accessKeyId = process.env.CAP_OWNERSHIP_TEST_S3_ACCESS_KEY;
			const secretAccessKey = process.env.CAP_OWNERSHIP_TEST_S3_SECRET_KEY;
			const prefix = process.env.CAP_OWNERSHIP_TEST_S3_BUCKET_PREFIX;
			if (!endpoint || !accessKeyId || !secretAccessKey || !prefix)
				throw new Error("Missing synthetic storage configuration");
			const url = new URL(endpoint);
			if (
				url.protocol !== "http:" ||
				url.hostname !== "127.0.0.1" ||
				!url.port ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash ||
				!/^synthetic_[a-f0-9]{40}$/.test(accessKeyId) ||
				!/^synthetic_[a-f0-9]{40}$/.test(secretAccessKey) ||
				!/^ownership-synthetic-[a-f0-9]{12}$/.test(prefix)
			)
				throw new Error("Refusing non-synthetic storage");
			bucketPrefix = prefix;
			client = new S3.S3Client({
				endpoint,
				region: "us-east-1",
				forcePathStyle: true,
				credentials: { accessKeyId, secretAccessKey },
			});
			let ready = false;
			for (let attempt = 0; attempt < 60; attempt++) {
				try {
					await client.send(new S3.ListBucketsCommand({}));
					ready = true;
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
			if (!ready) throw new Error("Synthetic storage did not become ready");
		});
		afterAll(() => client?.destroy());
		beforeEach(async () => {
			vi.restoreAllMocks();
			bucket = `${bucketPrefix}-${++counter}`;
			await client.send(new S3.CreateBucketCommand({ Bucket: bucket }));
			await client.send(
				new S3.PutBucketVersioningCommand({
					Bucket: bucket,
					VersioningConfiguration: { Status: "Enabled" },
				}),
			);
			state.access = await Effect.runPromise(
				createS3BucketAccess.pipe(
					Effect.provideService(S3BucketClientProvider, {
						bucket,
						isPathStyle: true,
						getInternal: Effect.succeed(client),
						getPublic: Effect.succeed(client),
					}),
				),
			);
			const video = Video.Video.make({
				id: Video.VideoId.make("test-video"),
				ownerId: User.UserId.make("test-owner"),
				orgId: Organisation.OrganisationId.make("test-org"),
				name: "Synthetic recording",
				public: false,
				source: { type: "webMP4" },
				metadata: Option.none(),
				bucketId: Option.none(),
				storageIntegrationId: Option.none(),
				folderId: Option.none(),
				transcriptionStatus: Option.none(),
				width: Option.none(),
				height: Option.none(),
				duration: Option.some(1),
				createdAt: new Date("2025-01-01T00:00:00Z"),
				updatedAt: new Date("2025-01-01T00:00:00Z"),
			});
			const [resolved] = await Effect.runPromise(
				Storage.getAccessForVideo(video, {
					resolvePublishedOutput: false,
				}).pipe(
					Effect.provide(Storage.DefaultWithoutDependencies),
					Effect.provide(StorageRepo.Default),
					Effect.provide(S3Buckets.Default),
				),
			);
			if (resolved.provider !== "s3")
				throw new Error("Expected synthetic S3 storage");
			access = resolved;
			store = makeOwnershipMediaStore(access);
		});

		it("hashes versioned reads and preserves originals while filtering copied metadata", async () => {
			const uploaded = await put();
			const source = await store.inspect(sourceKey);
			expect(source).toMatchObject({
				versionId: uploaded.VersionId,
				sha256: hash(bytes),
				size: bytes.length,
			});
			expect(await store.list(sourcePrefix)).toEqual([sourceKey]);
			await copyOwnershipMedia(plan(source), store);
			const destination = await store.inspect(destinationKey);
			expect(destination.sha256).toBe(source.sha256);
			expect(await store.inspect(sourceKey)).toEqual(source);
			const head = await client.send(
				new S3.HeadObjectCommand({ Bucket: bucket, Key: destinationKey }),
			);
			expect(head.Metadata).toEqual({ duration: "1", videocodec: "h264" });
			expect(head.ContentType).toBe("video/mp4");
			expect(await versions(destinationKey)).toHaveLength(1);
		});

		it("copies multiple real ranged parts and verifies bytes with a different destination ETag", async () => {
			const large = Buffer.alloc(129 * 1024 ** 2, 0x53);
			await put(sourceKey, large);
			const source = await store.inspect(sourceKey);
			const copied = vi.spyOn(access.multipart, "copyPart");
			await copyOwnershipMedia(plan(source), makeOwnershipMediaStore(access));
			const destination = await store.inspect(destinationKey);
			expect(copied).toHaveBeenCalledTimes(2);
			expect(destination.sha256).toBe(hash(large));
			expect(destination.identity).not.toBe(source.identity);
			expect(await outstandingUploads()).toEqual([]);
		}, 120000);

		it("allows one concurrent conditional completion and retries by readback without new versions", async () => {
			await put();
			const source = await store.inspect(sourceKey);
			const results = await Promise.allSettled([
				store.copyIfAbsent(source, destinationKey),
				store.copyIfAbsent(source, destinationKey),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				results.filter((result) => result.status === "rejected"),
			).toHaveLength(1);
			await copyOwnershipMedia(plan(source), store);
			await copyOwnershipMedia(plan(source), store);
			expect(await versions(destinationKey)).toHaveLength(1);
			expect((await store.inspect(destinationKey)).sha256).toBe(source.sha256);
			expect(await outstandingUploads()).toEqual([]);
		});

		it("never overwrites a conflicting existing destination", async () => {
			await put();
			const source = await store.inspect(sourceKey);
			await put(
				destinationKey,
				Buffer.from("synthetic conflicting destination"),
			);
			const before = await store.inspect(destinationKey);
			await expect(store.copyIfAbsent(source, destinationKey)).rejects.toThrow(
				"STORAGE_FAILED",
			);
			await expect(copyOwnershipMedia(plan(source), store)).rejects.toThrow(
				"DESTINATION_CONFLICT",
			);
			expect(await store.inspect(destinationKey)).toEqual(before);
			expect(await versions(destinationKey)).toHaveLength(1);
			expect(await outstandingUploads()).toEqual([]);
		});

		it("holds identical-byte source replacements with different versions", async () => {
			await put();
			const source = await store.inspect(sourceKey);
			await put();
			const changed = await store.inspect(sourceKey);
			expect(changed.identity).toBe(source.identity);
			expect(changed.versionId).not.toBe(source.versionId);
			await expect(store.copyIfAbsent(source, destinationKey)).rejects.toThrow(
				"MEDIA_CHANGED",
			);
			expect(await versions(destinationKey)).toEqual([]);
		});

		it("pins the copy source version and holds publication when the latest source changes during copying", async () => {
			await put();
			const source = await store.inspect(sourceKey);
			const create = access.multipart.create;
			vi.spyOn(access.multipart, "create").mockImplementationOnce((...args) =>
				create(...args).pipe(
					Effect.tap(() =>
						Effect.promise(() =>
							put(sourceKey, Buffer.from("synthetic replacement")),
						),
					),
				),
			);
			await expect(copyOwnershipMedia(plan(source), store)).rejects.toThrow(
				"MEDIA_CHANGED",
			);
			expect((await store.inspect(destinationKey)).sha256).toBe(source.sha256);
			expect((await store.inspect(sourceKey)).sha256).not.toBe(source.sha256);
			expect(await versions(sourceKey)).toHaveLength(2);
		});

		it("enforces conditional ranged GETs and reads archived JSON from the pinned version", async () => {
			const key = `${sourcePrefix}inventory.json`;
			const original = Buffer.from('{"version":1,"kind":"synthetic"}');
			await put(key, original);
			const object = await store.inspect(key);
			await put(key, Buffer.from('{"version":2,"kind":"synthetic"}'));
			expect(await store.readJson(object)).toEqual({
				version: 1,
				kind: "synthetic",
			});
			const url = await access
				.getInternalSignedObjectUrl(key, {
					versionId: object.versionId ?? undefined,
				})
				.pipe(Effect.runPromise);
			const range = await fetch(url, {
				headers: { Range: "bytes=0-8", "If-Match": object.identity },
				redirect: "error",
			});
			expect(range.status).toBe(206);
			expect(range.headers.get("x-amz-version-id")).toBe(object.versionId);
			expect(Buffer.from(await range.arrayBuffer())).toEqual(
				original.subarray(0, 9),
			);
			const rejected = await fetch(url, {
				headers: { "If-Match": '"synthetic-wrong-etag"' },
				redirect: "error",
			});
			expect(rejected.status).toBe(412);
			await rejected.body?.cancel();
		});

		it("detects version replacement between HEAD and the conditional read", async () => {
			await put();
			const sign = access.getInternalSignedObjectUrl;
			vi.spyOn(access, "getInternalSignedObjectUrl").mockImplementationOnce(
				(key, options) =>
					sign(key, options).pipe(
						Effect.tap(() => Effect.promise(() => put())),
					),
			);
			await expect(store.inspect(sourceKey)).rejects.toThrow("MEDIA_CHANGED");
		});

		it("recovers a lost completion acknowledgement without replacing the committed destination", async () => {
			await put();
			const source = await store.inspect(sourceKey);
			const complete = access.multipart.complete;
			vi.spyOn(access.multipart, "complete").mockImplementationOnce((...args) =>
				complete(...args).pipe(
					Effect.flatMap(() =>
						Effect.die(new Error("synthetic lost acknowledgement")),
					),
				),
			);
			await copyOwnershipMedia(plan(source), store);
			await copyOwnershipMedia(plan(source), store);
			expect(await versions(destinationKey)).toHaveLength(1);
			expect((await store.inspect(destinationKey)).sha256).toBe(source.sha256);
			expect(await outstandingUploads()).toEqual([]);
		});
	},
);
