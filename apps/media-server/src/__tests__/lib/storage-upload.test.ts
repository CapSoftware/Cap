import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFileToStorage } from "../../lib/media-video";
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

	test("uploads at most two parts concurrently and completes in part order", async () => {
		const uploadFile = await createTempUploadFile(partSize * 5);
		const pendingParts = new Map<number, (response: Response) => void>();
		const signedParts: number[] = [];
		let completedParts: unknown;
		let peakUploads = 0;

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/sign")) {
				const { partNumber } = JSON.parse(String(init?.body));
				signedParts.push(partNumber);
				return Response.json({
					url: `https://storage.example.com/part-${partNumber}`,
				});
			}
			if (url.endsWith("/complete")) {
				completedParts = JSON.parse(String(init?.body)).parts;
				return Response.json({ objectIdentity: '"completed-object-version"' });
			}
			if (url.endsWith("/abort")) {
				return Response.json({ success: true });
			}
			const partNumber = Number(url.split("-").at(-1));
			return await new Promise<Response>((resolve) => {
				pendingParts.set(partNumber, resolve);
				peakUploads = Math.max(peakUploads, pendingParts.size);
			});
		}) as typeof fetch;

		const finishPart = (partNumber: number) => {
			const resolve = pendingParts.get(partNumber);
			if (!resolve) throw new Error(`Part ${partNumber} is not uploading`);
			pendingParts.delete(partNumber);
			resolve(
				new Response(null, { headers: { etag: `"etag-${partNumber}"` } }),
			);
		};
		const waitForPart = async (partNumber: number) => {
			for (let i = 0; i < 1_000 && !pendingParts.has(partNumber); i++) {
				await Bun.sleep(1);
			}
			expect(pendingParts.has(partNumber)).toBe(true);
		};

		const controller = new AbortController();
		const upload = uploadFileToStorage(
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
			controller.signal,
		);
		try {
			await waitForPart(2);
			expect(signedParts).toEqual([1, 2]);
			finishPart(2);
			await waitForPart(3);
			finishPart(3);
			await waitForPart(4);
			finishPart(4);
			await waitForPart(5);
			finishPart(5);
			finishPart(1);
			expect((await upload).objectIdentity).toBe('"completed-object-version"');
			expect(peakUploads).toBe(2);
			expect(signedParts).toEqual([1, 2, 3, 4, 5]);
			expect(completedParts).toEqual(
				[1, 2, 3, 4, 5].map((partNumber) => ({
					partNumber,
					etag: `"etag-${partNumber}"`,
					size: partSize,
				})),
			);
		} finally {
			controller.abort();
			for (const [partNumber, resolve] of pendingParts) {
				resolve(
					new Response(null, {
						headers: { etag: `"etag-${partNumber}"` },
					}),
				);
			}
			await upload.catch(() => {});
			await uploadFile.cleanup();
		}
	});

	test("drains concurrent parts before aborting after a failed upload", async () => {
		const uploadFile = await createTempUploadFile(partSize * 5);
		const pendingParts = new Map<number, (response: Response) => void>();
		const events: string[] = [];
		const signedParts: number[] = [];

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/sign")) {
				const { partNumber } = JSON.parse(String(init?.body));
				signedParts.push(partNumber);
				return Response.json({
					url: `https://storage.example.com/part-${partNumber}`,
				});
			}
			if (url.endsWith("/abort")) {
				events.push("abort-request");
				return Response.json({ success: true });
			}
			if (url.endsWith("/complete")) {
				events.push("complete-request");
				return Response.json({ success: true });
			}
			const partNumber = Number(url.split("-").at(-1));
			return await new Promise<Response>((resolve, reject) => {
				pendingParts.set(partNumber, resolve);
				init?.signal?.addEventListener(
					"abort",
					() => {
						if (!pendingParts.delete(partNumber)) return;
						events.push(`part-${partNumber}-stopped`);
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			});
		}) as typeof fetch;

		const upload = uploadFileToStorage(
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
		try {
			for (let i = 0; i < 1_000 && pendingParts.size !== 2; i++) {
				await Bun.sleep(1);
			}
			expect(pendingParts.size).toBe(2);
			const failPart = pendingParts.get(1);
			if (!failPart) throw new Error("Part 1 is not uploading");
			pendingParts.delete(1);
			failPart(new Response("invalid part", { status: 400 }));
			await expect(upload).rejects.toThrow("Multipart upload part 1 failed");
			expect(signedParts).toEqual([1, 2]);
			expect(pendingParts.size).toBe(0);
			expect(events.slice(-1)).toEqual(["abort-request"]);
			expect(events.filter((event) => event.endsWith("-stopped"))).toHaveLength(
				1,
			);
			expect(events).not.toContain("complete-request");
		} finally {
			for (const [partNumber, resolve] of pendingParts) {
				resolve(
					new Response(null, {
						headers: { etag: `"etag-${partNumber}"` },
					}),
				);
			}
			await upload.catch(() => {});
			await uploadFile.cleanup();
		}
	});

	test("stops an active part before aborting when another part cannot be signed", async () => {
		const uploadFile = await createTempUploadFile(partSize * 2);
		const events: string[] = [];
		let activePart = false;

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/sign")) {
				const { partNumber } = JSON.parse(String(init?.body));
				if (partNumber === 1) {
					return Response.json({ url: "https://storage.example.com/part-1" });
				}
				for (let i = 0; i < 1_000 && !activePart; i++) {
					await Bun.sleep(1);
				}
				return new Response("signing failed", { status: 400 });
			}
			if (url.endsWith("/abort")) {
				events.push("abort-request");
				return Response.json({ success: true });
			}
			if (url.endsWith("/complete")) {
				events.push("complete-request");
				return Response.json({ success: true });
			}
			return await new Promise<Response>((_, reject) => {
				activePart = true;
				init?.signal?.addEventListener(
					"abort",
					() => {
						activePart = false;
						events.push("part-1-stopped");
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			});
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
			).rejects.toThrow("Multipart part signing failed");
			expect(activePart).toBe(false);
			expect(events).toEqual(["part-1-stopped", "abort-request"]);
		} finally {
			await uploadFile.cleanup();
		}
	});

	test("retries one transient part failure without canceling other parts", async () => {
		const uploadFile = await createTempUploadFile(partSize + 1);
		const attempts = new Map<number, number>();
		const requests: string[] = [];
		let completedParts: unknown;

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/sign")) {
				const { partNumber } = JSON.parse(String(init?.body));
				return Response.json({
					url: `https://storage.example.com/part-${partNumber}`,
				});
			}
			if (url.endsWith("/complete")) {
				completedParts = JSON.parse(String(init?.body)).parts;
				return Response.json({ objectIdentity: '"completed-object-version"' });
			}
			const partNumber = Number(url.split("-").at(-1));
			const attempt = (attempts.get(partNumber) ?? 0) + 1;
			attempts.set(partNumber, attempt);
			if (partNumber === 1 && attempt === 1) {
				return new Response("temporary failure", { status: 503 });
			}
			return new Response(null, { headers: { etag: `"etag-${partNumber}"` } });
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
				},
				"video/mp4",
			);
			expect(receipt.objectIdentity).toBe('"completed-object-version"');
			expect(attempts.get(1)).toBe(2);
			expect(attempts.get(2)).toBe(1);
			expect(completedParts).toEqual([
				{ partNumber: 1, etag: '"etag-1"', size: partSize },
				{ partNumber: 2, etag: '"etag-2"', size: 1 },
			]);
			expect(requests.some((url) => url.endsWith("/abort"))).toBe(false);
		} finally {
			await uploadFile.cleanup();
		}
	});

	test("cancels active parts before aborting when the caller stops", async () => {
		const uploadFile = await createTempUploadFile(partSize * 5);
		const pendingParts = new Set<number>();
		const events: string[] = [];
		const controller = new AbortController();

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/sign")) {
				const { partNumber } = JSON.parse(String(init?.body));
				return Response.json({
					url: `https://storage.example.com/part-${partNumber}`,
				});
			}
			if (url.endsWith("/abort")) {
				events.push("abort-request");
				return Response.json({ success: true });
			}
			if (url.endsWith("/complete")) {
				events.push("complete-request");
				return Response.json({ success: true });
			}
			const partNumber = Number(url.split("-").at(-1));
			return await new Promise<Response>((_, reject) => {
				pendingParts.add(partNumber);
				init?.signal?.addEventListener(
					"abort",
					() => {
						pendingParts.delete(partNumber);
						events.push(`part-${partNumber}-stopped`);
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			});
		}) as typeof fetch;

		const upload = uploadFileToStorage(
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
			controller.signal,
		);
		try {
			for (let i = 0; i < 1_000 && pendingParts.size !== 2; i++) {
				await Bun.sleep(1);
			}
			expect(pendingParts.size).toBe(2);
			controller.abort(new Error("Upload canceled"));
			await expect(upload).rejects.toThrow("Upload canceled");
			expect(pendingParts.size).toBe(0);
			expect(events.filter((event) => event.endsWith("-stopped"))).toHaveLength(
				2,
			);
			expect(events.slice(-1)).toEqual(["abort-request"]);
			expect(events).not.toContain("complete-request");
		} finally {
			controller.abort();
			await upload.catch(() => {});
			await uploadFile.cleanup();
		}
	});
});
