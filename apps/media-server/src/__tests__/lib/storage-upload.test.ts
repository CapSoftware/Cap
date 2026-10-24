import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	beginStorageUpload,
	multipartUploadConcurrencyFromEnv,
	uploadFileToStorage,
} from "../../lib/media-video";
import { verifyRemoteRecordingBytes } from "../../lib/recording-verification";

const originalFetch = globalThis.fetch;
const partSize = 5 * 1024 * 1024;

async function createTempUploadFile(size: number) {
	const dir = await mkdtemp(join(tmpdir(), "cap-upload-test-"));
	const path = join(dir, "result.mp4");
	const data = new Uint8Array(size);
	data[0] = 1;
	data[size - 1] = 2;
	await writeFile(path, data);
	return {
		path,
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

describe("uploadFileToStorage", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("uploads a 10 GB sparse file as 160 bounded parts with its Loom attempt", async () => {
		const uploadFile = await createTempUploadFile(1);
		const handle = await open(uploadFile.path, "r+");
		try {
			await handle.truncate(10 * 1024 ** 3);
		} finally {
			await handle.close();
		}
		let uploadedParts = 0;
		let uploadedBytes = 0;
		let completed = false;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/sign-part")) {
				const request = JSON.parse(String(init?.body));
				expect(request.loomImportAttemptId).toBe("loom-run:0");
				expect(request.contentLength).toBe(64 * 1024 ** 2);
				return Response.json({
					url: `https://storage.test/part/${request.partNumber}`,
				});
			}
			if (init?.method === "PUT") {
				const body = init.body;
				if (!(body instanceof Blob))
					throw new Error("Expected a bounded file slice");
				uploadedParts++;
				uploadedBytes += body.size;
				expect(body.size).toBe(64 * 1024 ** 2);
				return new Response(null, {
					headers: { ETag: `"part-${uploadedParts}"` },
				});
			}
			if (url.endsWith("/complete")) {
				const request = JSON.parse(String(init?.body));
				expect(request.loomImportAttemptId).toBe("loom-run:0");
				expect(request.parts).toHaveLength(160);
				completed = true;
				return Response.json({ objectIdentity: '"multipart-result"' });
			}
			throw new Error("Unexpected multipart request");
		}) as typeof fetch;
		try {
			await uploadFileToStorage(
				uploadFile.path,
				{
					type: "multipart",
					videoId: "video",
					key: "owner/video/raw-upload.mp4",
					uploadId: "upload",
					partSize: 64 * 1024 ** 2,
					signPartUrl: "https://cap.test/sign-part",
					completeUrl: "https://cap.test/complete",
					abortUrl: "https://cap.test/abort",
					loomImportAttemptId: "loom-run:0",
				},
				"video/mp4",
			);
			expect(uploadedParts).toBe(160);
			expect(uploadedBytes).toBe(10 * 1024 ** 3);
			expect(completed).toBe(true);
		} finally {
			await uploadFile.cleanup();
		}
	});

	test.each([false, true])(
		"checks full remote bytes after Drive metadata version drift (corrupt=%s)",
		async (corrupt) => {
			const uploadFile = await createTempUploadFile(11);
			const bytes = new Uint8Array(
				await Bun.file(uploadFile.path).arrayBuffer(),
			);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const identity = `"cap-drive-content-v1:${createHash("sha256")
				.update(JSON.stringify(["drive-file-1", bytes.length, sha256]))
				.digest("hex")}"`;
			globalThis.fetch = (async (_input, init) => {
				if (init?.method === "PUT")
					return Response.json({
						id: "drive-file-1",
						version: "1",
						size: "11",
						sha256Checksum: sha256,
						headRevisionId: "revision-1",
					});
				const headers = new Headers(init?.headers);
				expect(headers.get("if-match")).toBe(identity);
				if (headers.has("range"))
					return new Response(bytes.slice(0, 1), {
						status: 206,
						headers: {
							ETag: identity,
							"Content-Length": "1",
							"Content-Range": "bytes 0-0/11",
						},
					});
				const returned = bytes.slice();
				if (corrupt) returned[5] = 99;
				return new Response(returned, {
					headers: { ETag: identity, "Content-Length": "11" },
				});
			}) as typeof fetch;
			try {
				const receipt = await uploadFileToStorage(
					uploadFile.path,
					{
						type: "put",
						url: "https://www.googleapis.com/upload/drive/v3/files?upload_id=session",
					},
					"video/mp4",
				);
				expect(receipt.objectIdentity).toBe(identity);
				const verified = verifyRemoteRecordingBytes(
					"https://storage.example.com/recording.mp4",
					{
						expectedSha256: sha256,
						expectedFileSize: 11,
						expectedObjectIdentity: identity,
					},
				);
				if (corrupt)
					await expect(verified).rejects.toThrow(
						"Uploaded recording bytes do not match",
					);
				else expect((await verified).remoteSha256).toBe(sha256);
			} finally {
				await uploadFile.cleanup();
			}
		},
	);

	test("returns the successful PUT identity without a later HEAD lookup", async () => {
		const uploadFile = await createTempUploadFile(11);
		const methods: string[] = [];
		globalThis.fetch = (async (_input, init) => {
			methods.push(init?.method ?? "GET");
			return methods.length === 1
				? new Response("Unavailable", {
						status: 503,
						headers: { ETag: '"failed-attempt"' },
					})
				: new Response(null, {
						status: 200,
						headers: { ETag: '"written-version"' },
					});
		}) as typeof fetch;
		try {
			const receipt = await uploadFileToStorage(
				uploadFile.path,
				{ type: "put", url: "https://storage.example.com/recording.mp4" },
				"video/mp4",
			);
			expect(receipt.objectIdentity).toBe('"written-version"');
			expect(methods).toEqual(["PUT", "PUT"]);
		} finally {
			await uploadFile.cleanup();
		}
	});

	test.each([undefined, 'W/"weak-version"'])(
		"keeps successful legacy uploads compatible without claiming identity (%s)",
		async (identity) => {
			const uploadFile = await createTempUploadFile(11);
			globalThis.fetch = (async (_input, _init) =>
				new Response(null, {
					headers: identity ? { ETag: identity } : {},
				})) as typeof fetch;
			try {
				const receipt = await uploadFileToStorage(
					uploadFile.path,
					{ type: "put", url: "https://storage.example.com/recording.mp4" },
					"video/mp4",
				);
				expect(receipt.objectIdentity).toBeUndefined();
			} finally {
				await uploadFile.cleanup();
			}
		},
	);

	test.each(["1", "6", "9007199254740993"])(
		"binds a Drive upload to content independently of metadata version %s",
		async (version) => {
			const uploadFile = await createTempUploadFile(11);
			const methods: string[] = [];
			globalThis.fetch = (async (_input, init) => {
				methods.push(init?.method ?? "GET");
				expect(new Headers(init?.headers).get("content-range")).toBe(
					"bytes 0-10/11",
				);
				return Response.json({
					id: "drive-file-1",
					version,
					size: "11",
					sha256Checksum: "a".repeat(64),
					headRevisionId: "revision-1",
				});
			}) as typeof fetch;
			try {
				const receipt = await uploadFileToStorage(
					uploadFile.path,
					{
						type: "put",
						url: "https://www.googleapis.com/upload/drive/v3/files?upload_id=session",
					},
					"video/mp4",
				);
				expect(receipt.objectIdentity).toBe(
					'"cap-drive-content-v1:9c353d47a7cf9c0f30c3008eb3576c4629a878019572a4d68404cbe0f222b88c"',
				);
				expect(methods).toEqual(["PUT"]);
			} finally {
				await uploadFile.cleanup();
			}
		},
	);

	test.each([
		{ id: "drive-file-1", size: "11" },
		{ id: "drive-file-1", version: "1", size: "11" },
		{ id: "drive-file-1", size: "11", sha256Checksum: "a".repeat(64) },
		{
			id: "drive-file-1",
			size: "11",
			sha256Checksum: "invalid",
			headRevisionId: "revision-1",
		},
		{
			id: "drive-file-1",
			size: "12",
			sha256Checksum: "a".repeat(64),
			headRevisionId: "revision-1",
		},
		{ id: 'invalid"id', version: "1", size: "11" },
		{ id: "drive-file-1", version: "0", size: "11" },
		{ id: "drive-file-1", version: "1", size: "12" },
	])(
		"withholds incomplete or inconsistent Drive upload identity: %j",
		async (metadata) => {
			const uploadFile = await createTempUploadFile(11);
			globalThis.fetch = (async (_input, _init) =>
				Response.json(metadata)) as typeof fetch;
			try {
				const receipt = await uploadFileToStorage(
					uploadFile.path,
					{
						type: "put",
						url: "https://www.googleapis.com/upload/drive/v3/files?upload_id=session",
					},
					"video/mp4",
				);
				expect(receipt.objectIdentity).toBeUndefined();
			} finally {
				await uploadFile.cleanup();
			}
		},
	);

	test("uploads multipart files in signed parts and completes them", async () => {
		const uploadFile = await createTempUploadFile(partSize + 3);
		const requests: Array<{
			url: string;
			method: string;
			secret: string | null;
			json?: unknown;
			bodySize?: number;
		}> = [];

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const headers = new Headers(init?.headers);

			if (method === "POST") {
				const json = JSON.parse(String(init?.body));
				requests.push({
					url,
					method,
					secret: headers.get("x-media-server-secret"),
					json,
				});

				if (url.endsWith("/sign")) {
					return Response.json({
						url: `https://storage.example.com/part-${json.partNumber}`,
					});
				}

				return Response.json({
					success: true,
					objectIdentity: '"completed-object-version"',
				});
			}

			const body = init?.body as Blob;
			requests.push({
				url,
				method,
				secret: headers.get("x-media-server-secret"),
				bodySize: body.size,
			});
			const partNumber = url.endsWith("part-1") ? 1 : 2;
			return new Response(null, {
				status: 200,
				headers: { etag: `"etag-${partNumber}"` },
			});
		}) as typeof fetch;

		try {
			const receipt = await uploadFileToStorage(
				uploadFile.path,
				{
					type: "multipart",
					videoId: "video-id",
					key: "user-id/video-id/result.mp4",
					uploadId: "upload-id",
					partSize,
					signPartUrl: "https://cap.example.com/sign",
					completeUrl: "https://cap.example.com/complete",
					abortUrl: "https://cap.example.com/abort",
					webhookSecret: "secret",
				},
				"video/mp4",
			);
			expect(receipt.objectIdentity).toBe('"completed-object-version"');
		} finally {
			await uploadFile.cleanup();
		}

		const putRequests = requests.filter((request) => request.method === "PUT");
		expect(putRequests.map((request) => request.bodySize)).toEqual([
			partSize,
			3,
		]);

		const completeRequest = requests.find((request) =>
			request.url.endsWith("/complete"),
		);
		expect(completeRequest?.secret).toBe("secret");
		expect(completeRequest?.json).toEqual({
			videoId: "video-id",
			key: "user-id/video-id/result.mp4",
			uploadId: "upload-id",
			parts: [
				{ partNumber: 1, etag: '"etag-1"', size: partSize },
				{ partNumber: 2, etag: '"etag-2"', size: 3 },
			],
		});
	});

	test("uploads multipart parts concurrently and completes them in order", async () => {
		const uploadFile = await createTempUploadFile(partSize * 4 + 1);
		let inFlight = 0;
		let maxInFlight = 0;
		let completed: unknown;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (init?.method === "POST") {
				const json = JSON.parse(String(init.body));
				if (url.endsWith("/sign"))
					return Response.json({
						url: `https://storage.example.com/part-${json.partNumber}`,
					});
				completed = json;
				return Response.json({ objectIdentity: '"completed"' });
			}
			const partNumber = Number(url.split("part-")[1]);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Bun.sleep((6 - partNumber) * 5);
			inFlight--;
			return new Response(null, {
				status: 200,
				headers: { etag: `"etag-${partNumber}"` },
			});
		}) as typeof fetch;
		process.env.MEDIA_SERVER_UPLOAD_CONCURRENCY = "3";
		try {
			await uploadFileToStorage(
				uploadFile.path,
				{
					type: "multipart",
					videoId: "video-id",
					key: "user-id/video-id/result.mp4",
					uploadId: "upload-id",
					partSize,
					signPartUrl: "https://cap.example.com/sign",
					completeUrl: "https://cap.example.com/complete",
					abortUrl: "https://cap.example.com/abort",
				},
				"video/mp4",
			);
		} finally {
			delete process.env.MEDIA_SERVER_UPLOAD_CONCURRENCY;
			await uploadFile.cleanup();
		}
		expect(maxInFlight).toBe(3);
		expect(
			(completed as { parts: Array<{ partNumber: number }> }).parts.map(
				(part) => part.partNumber,
			),
		).toEqual([1, 2, 3, 4, 5]);
	});

	test("reads a bounded multipart upload concurrency", () => {
		expect(multipartUploadConcurrencyFromEnv({})).toBe(1);
		expect(
			multipartUploadConcurrencyFromEnv({
				MEDIA_SERVER_UPLOAD_CONCURRENCY: "8",
			}),
		).toBe(8);
		expect(
			multipartUploadConcurrencyFromEnv({
				MEDIA_SERVER_UPLOAD_CONCURRENCY: "99",
			}),
		).toBe(16);
	});

	test("aborts multipart uploads when a part fails", async () => {
		const uploadFile = await createTempUploadFile(partSize + 1);
		const requests: Array<{ url: string; method: string }> = [];

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			requests.push({ url, method });

			if (url.endsWith("/sign")) {
				return Response.json({ url: "https://storage.example.com/part-1" });
			}

			if (url.endsWith("/abort")) {
				return Response.json({ success: true });
			}

			return new Response("invalid part", { status: 400 });
		}) as typeof fetch;

		try {
			await expect(
				uploadFileToStorage(
					uploadFile.path,
					{
						type: "multipart",
						videoId: "video-id",
						key: "user-id/video-id/result.mp4",
						uploadId: "upload-id",
						partSize,
						signPartUrl: "https://cap.example.com/sign",
						completeUrl: "https://cap.example.com/complete",
						abortUrl: "https://cap.example.com/abort",
					},
					"video/mp4",
				),
			).rejects.toThrow("Multipart upload part 1 failed");
		} finally {
			await uploadFile.cleanup();
		}

		expect(requests.some((request) => request.url.endsWith("/abort"))).toBe(
			true,
		);
	});
});

describe("beginStorageUpload", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const multipartTarget = {
		type: "multipart" as const,
		videoId: "video",
		key: "owner/video/result.mp4",
		uploadId: "upload",
		partSize,
		signPartUrl: "https://cap.test/sign-part",
		completeUrl: "https://cap.test/complete",
		abortUrl: "https://cap.test/abort",
	};

	async function waitUntil(condition: () => boolean) {
		for (let tries = 0; tries < 100 && !condition(); tries++)
			await Bun.sleep(5);
	}

	function recordMultipart(holdParts?: Promise<void>) {
		const calls: string[] = [];
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/sign-part")) {
				const { partNumber } = JSON.parse(String(init?.body));
				calls.push(`sign-${partNumber}`);
				return Response.json({
					url: `https://storage.test/part/${partNumber}`,
				});
			}
			if (init?.method === "PUT") {
				calls.push(`put-${url.split("/").at(-1)}`);
				if (holdParts)
					await Promise.race([
						holdParts,
						new Promise((_, reject) =>
							init.signal?.addEventListener("abort", () =>
								reject(new DOMException("Aborted", "AbortError")),
							),
						),
					]);
				return new Response(null, { headers: { ETag: `"etag-${url}"` } });
			}
			if (url.endsWith("/complete")) {
				calls.push("complete");
				return Response.json({ objectIdentity: '"done"' });
			}
			if (url.endsWith("/abort")) {
				calls.push("abort");
				return Response.json({ success: true });
			}
			throw new Error(`Unexpected request ${url}`);
		}) as typeof fetch;
		return calls;
	}

	const puts = (calls: string[]) =>
		calls.filter((call) => call.startsWith("put"));

	test("uploads multipart parts before finish and completes only when finished", async () => {
		const uploadFile = await createTempUploadFile(partSize * 2 + 1);
		const calls = recordMultipart();
		try {
			const pending = beginStorageUpload(
				uploadFile.path,
				multipartTarget,
				"video/mp4",
			);
			await waitUntil(() => puts(calls).length === 3);
			expect(puts(calls)).toHaveLength(3);
			expect(calls).not.toContain("complete");
			expect(await pending.finish()).toEqual({ objectIdentity: '"done"' });
			expect(calls.at(-1)).toBe("complete");
			expect(calls).not.toContain("abort");
		} finally {
			await uploadFile.cleanup();
		}
	});

	test("cancel stops in-flight parts without completing and leaves the abort to the caller", async () => {
		const uploadFile = await createTempUploadFile(partSize * 2 + 1);
		let release = () => {};
		const calls = recordMultipart(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		try {
			const pending = beginStorageUpload(
				uploadFile.path,
				multipartTarget,
				"video/mp4",
			);
			await waitUntil(() => puts(calls).length > 0);
			expect(puts(calls).length).toBeGreaterThan(0);
			await pending.cancel();
			expect(calls).not.toContain("complete");
			expect(calls).not.toContain("abort");
		} finally {
			release();
			await uploadFile.cleanup();
		}
	});

	test("sends nothing for a single PUT target until finish", async () => {
		const uploadFile = await createTempUploadFile(16);
		const calls: string[] = [];
		globalThis.fetch = (async (_input, init) => {
			calls.push(String(init?.method));
			return new Response(null, { headers: { ETag: '"put"' } });
		}) as typeof fetch;
		try {
			const pending = beginStorageUpload(
				uploadFile.path,
				{ type: "put", url: "https://storage.test/result.mp4" },
				"video/mp4",
			);
			await Bun.sleep(20);
			expect(calls).toHaveLength(0);
			await pending.finish();
			expect(calls).toEqual(["PUT"]);
		} finally {
			await uploadFile.cleanup();
		}
	});
});
