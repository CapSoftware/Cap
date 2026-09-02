import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFileToStorage } from "../../lib/media-video";

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

	test("binds a Drive upload to its completed response version without rounding", async () => {
		const uploadFile = await createTempUploadFile(11);
		const methods: string[] = [];
		globalThis.fetch = (async (_input, init) => {
			methods.push(init?.method ?? "GET");
			expect(new Headers(init?.headers).get("content-range")).toBe(
				"bytes 0-10/11",
			);
			return Response.json({
				id: "drive-file-1",
				version: "9007199254740993",
				size: "11",
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
			expect(receipt.objectIdentity).toBe('"drive-file-1:9007199254740993"');
			expect(methods).toEqual(["PUT"]);
		} finally {
			await uploadFile.cleanup();
		}
	});

	test.each([
		{ id: "drive-file-1", size: "11" },
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
});
