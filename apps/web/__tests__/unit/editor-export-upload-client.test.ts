import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { uploadWebEditorExport } from "../../lib/editor-export-upload-client";

const CHUNK_BYTES = 16 * 1024 * 1024;
const metadata = { duration: 95, width: 1920, height: 1080, fps: 30 };

class MockXMLHttpRequest {
	static parts = new Map<number, Blob>();
	static aborted = 0;
	upload = {
		onprogress: null as ((event: ProgressEvent<EventTarget>) => void) | null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	status = 0;
	statusText = "";
	responseType = "";
	timeout = 0;
	private partNumber = 0;
	private completed = false;

	open(method: string, url: string) {
		expect(method).toBe("PUT");
		this.partNumber = Number(url.match(/part-(\d+)$/)?.[1]);
	}

	setRequestHeader() {}

	getResponseHeader(name: string) {
		return name.toLowerCase() === "etag" ? `"etag-${this.partNumber}"` : null;
	}

	send(part: Blob) {
		MockXMLHttpRequest.parts.set(this.partNumber, part);
		queueMicrotask(() => {
			if (this.completed) return;
			this.upload.onprogress?.({
				lengthComputable: true,
				loaded: part.size,
				total: part.size,
			} as ProgressEvent<EventTarget>);
			this.status = 200;
			this.completed = true;
			this.onload?.();
		});
	}

	abort() {
		if (this.completed) return;
		this.completed = true;
		MockXMLHttpRequest.aborted += 1;
		this.onabort?.();
	}
}

beforeEach(() => {
	MockXMLHttpRequest.parts.clear();
	MockXMLHttpRequest.aborted = 0;
	vi.stubGlobal("window", globalThis as typeof globalThis & Window);
	vi.stubGlobal(
		"XMLHttpRequest",
		MockXMLHttpRequest as unknown as typeof XMLHttpRequest,
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("a two-chunk MP4 reaches multipart publication with identical bytes and source metadata", async () => {
	const size = CHUNK_BYTES + 3 * 1024 * 1024 + 123;
	const asset = new Uint8Array(size);
	asset.fill(0x35, 0, CHUNK_BYTES);
	asset.fill(0xa7, CHUNK_BYTES);
	const chunks: Array<{ offset: number; length: number }> = [];
	let completion: Record<string, unknown> | null = null;
	const progress: Array<{ stage: string; fraction: number }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (
				url.startsWith("/api/editor/sessions/session/exports/export/chunk?")
			) {
				const query = new URL(url, "http://cap.test").searchParams;
				const offset = Number(query.get("offset"));
				const length = Number(query.get("length"));
				chunks.push({ offset, length });
				expect(query.get("videoId")).toBe("video");
				return new Response(
					new Blob([
						asset.buffer.slice(offset, offset + length) as ArrayBuffer,
					]),
					{
						status: 206,
						headers: {
							"Content-Type": "video/mp4",
							"Content-Length": String(length),
							"Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
						},
					},
				);
			}
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body.replaceExisting).toBe(true);
			expect(body.videoId).toBe("video");
			expect(body.subpath).toBe("result.mp4");
			if (url.endsWith("/initiate")) {
				expect(body.contentType).toBe("video/mp4");
				return Response.json({ uploadId: "upload", provider: "s3" });
			}
			if (url.endsWith("/presign-part")) {
				return Response.json({
					presignedUrl: `https://uploads.example/part-${body.partNumber}`,
					provider: "s3",
				});
			}
			if (url.endsWith("/complete")) {
				completion = body;
				return Response.json({ success: true, processingStarted: true });
			}
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	await uploadWebEditorExport(
		"video",
		"session",
		"export",
		size,
		metadata,
		new AbortController().signal,
		(value) => progress.push(value),
	);
	expect(chunks).toEqual([
		{ offset: 0, length: CHUNK_BYTES },
		{ offset: CHUNK_BYTES, length: size - CHUNK_BYTES },
	]);
	expect(completion).toMatchObject({
		uploadId: "upload",
		durationInSecs: metadata.duration,
		width: metadata.width,
		height: metadata.height,
		fps: metadata.fps,
		parts: [
			{ partNumber: 1, etag: "etag-1", size: CHUNK_BYTES },
			{ partNumber: 2, etag: "etag-2", size: size - CHUNK_BYTES },
		],
	});
	const uploaded = new Blob([
		MockXMLHttpRequest.parts.get(1) ?? new Blob(),
		MockXMLHttpRequest.parts.get(2) ?? new Blob(),
	]);
	expect(uploaded.size).toBe(size);
	const digest = (bytes: ArrayBuffer) =>
		createHash("sha256").update(Buffer.from(bytes)).digest("hex");
	expect(digest(await uploaded.arrayBuffer())).toBe(digest(asset.buffer));
	expect(progress.at(-1)).toEqual({ stage: "ready", fraction: 1 });
});

test("a lost multipart completion response resolves from the published recording", async () => {
	const size = 6 * 1024 * 1024;
	let completeAttempts = 0;
	let statusChecks = 0;
	let aborted = false;
	const progress: Array<{ stage: string; fraction: number }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/chunk?")) {
				return new Response(new Blob([new Uint8Array(size)]), {
					status: 206,
					headers: {
						"Content-Type": "video/mp4",
						"Content-Length": String(size),
						"Content-Range": `bytes 0-${size - 1}/${size}`,
					},
				});
			}
			if (url.endsWith("/initiate")) {
				return Response.json({
					uploadId: "cap-reupload.payload.signature",
					provider: "s3",
				});
			}
			if (url.endsWith("/presign-part")) {
				return Response.json({
					presignedUrl: "https://uploads.example/part-1",
					provider: "s3",
				});
			}
			if (url.endsWith("/complete")) {
				completeAttempts += 1;
				return new Response("Completion response lost", { status: 500 });
			}
			if (url.endsWith("/share-status")) {
				const body = JSON.parse(String(init?.body)) as {
					videoId: string;
					uploadId: string;
				};
				expect(body).toEqual({
					videoId: "video",
					uploadId: "cap-reupload.payload.signature",
				});
				statusChecks += 1;
				return Response.json({
					status: statusChecks === 1 ? "active" : "published",
				});
			}
			if (url.endsWith("/abort")) {
				aborted = true;
				return Response.json({ success: true });
			}
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	await uploadWebEditorExport(
		"video",
		"session",
		"export",
		size,
		metadata,
		new AbortController().signal,
		(value) => progress.push(value),
	);
	expect(completeAttempts).toBe(4);
	expect(statusChecks).toBe(2);
	expect(aborted).toBe(false);
	expect(progress.at(-1)).toEqual({ stage: "ready", fraction: 1 });
}, 20_000);

test("aborting while a chunk body is read does not publish the recording", async () => {
	const controller = new AbortController();
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/initiate"))
				return Response.json({ uploadId: "upload", provider: "s3" });
			if (url.endsWith("/abort")) return Response.json({ success: true });
			if (url.includes("/chunk?")) {
				const response = new Response(new Blob([new Uint8Array(1024)]), {
					status: 206,
					headers: {
						"Content-Type": "video/mp4",
						"Content-Length": "1024",
						"Content-Range": "bytes 0-1023/1024",
					},
				});
				vi.spyOn(response, "blob").mockImplementation(async () => {
					controller.abort();
					return new Blob([new Uint8Array(1024)]);
				});
				return response;
			}
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	await expect(
		uploadWebEditorExport(
			"video",
			"session",
			"export",
			1024,
			metadata,
			controller.signal,
		),
	).rejects.toThrow("Recording upload was canceled");
	expect(requests.some((url) => url.endsWith("/abort"))).toBe(true);
	expect(requests.some((url) => url.endsWith("/complete"))).toBe(false);
});
