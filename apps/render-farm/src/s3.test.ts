import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeXml, S3 } from "./s3";

describe("decodeXml", () => {
	test("decodes the predefined entities", () => {
		expect(decodeXml("a&amp;b&lt;c&gt;d&quot;e&apos;f")).toBe(`a&b<c>d"e'f`);
	});

	test("decodes each entity once", () => {
		expect(decodeXml("recordings/&amp;lt;x&amp;gt;.mp4")).toBe(
			"recordings/&lt;x&gt;.mp4",
		);
	});

	test("leaves unknown entities alone", () => {
		expect(decodeXml("&nbsp;&amp")).toBe("&nbsp;&amp");
	});
});

describe("uploadFile", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("a cancelled upload stops sending and aborts its multipart upload", async () => {
		const requests: string[] = [];
		const controller = new AbortController();
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			requests.push(`${init?.method} ${url.search}`);
			if (url.searchParams.has("uploads")) {
				return new Response(
					"<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
				);
			}
			if (url.searchParams.has("partNumber")) {
				controller.abort(new Error("cancelled"));
				init?.signal?.throwIfAborted();
			}
			return new Response("", { status: 204 });
		}) as typeof fetch;
		const path = join(tmpdir(), `s3-upload-${Date.now()}.bin`);
		await Bun.write(path, new Uint8Array(1024));
		const s3 = new S3({
			endpoint: "https://s3.test",
			region: "us-east-1",
			bucket: "bucket",
			accessKeyId: "a",
			secretAccessKey: "b",
			virtualHost: false,
		});
		await expect(
			s3.uploadFile("out/file.mp4", path, "video/mp4", {
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
		expect(requests).toEqual([
			"POST ?uploads=",
			"PUT ?partNumber=1&uploadId=u1",
			"DELETE ?uploadId=u1",
		]);
	});

	test("cleanup after a cancelled upload runs with its own deadline", async () => {
		const controller = new AbortController();
		let cleanup: AbortSignal | undefined;
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.searchParams.has("uploads")) {
				return new Response("<UploadId>u1</UploadId>");
			}
			if (init?.method === "DELETE") {
				cleanup = init.signal ?? undefined;
				return new Response("", { status: 204 });
			}
			controller.abort(new Error("cancelled"));
			init?.signal?.throwIfAborted();
			return new Response("", { status: 204 });
		}) as typeof fetch;
		const path = join(tmpdir(), `s3-cleanup-${Date.now()}.bin`);
		await Bun.write(path, new Uint8Array(16));
		const s3 = new S3({
			endpoint: "https://s3.test",
			region: "us-east-1",
			bucket: "bucket",
			accessKeyId: "a",
			secretAccessKey: "b",
			virtualHost: false,
		});
		const upload = s3.uploadFile("out/file.mp4", path, "video/mp4", {
			signal: controller.signal,
		});
		await expect(upload).rejects.toThrow("cancelled");
		expect(cleanup).toBeInstanceOf(AbortSignal);
		expect(cleanup?.aborted).toBe(false);
		expect(cleanup).not.toBe(controller.signal);
	});
});
