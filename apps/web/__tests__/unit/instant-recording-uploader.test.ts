import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	InstantRecordingUploader,
	MultipartCompletionUncertainError,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/instant-mp4-uploader";
import type { VideoId } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-types";

const STREAMED_PART_BYTES = 5 * 1024 * 1024 + 128;
const OVERFLOW_PART_BYTES = 129 * 1024 * 1024;
const FINALIZED_BLOB_BYTES = 129 * 1024 * 1024;

type UploadOutcome =
	| { type: "success"; etag: string }
	| { type: "network-error" }
	| { type: "pending" };

class MockXMLHttpRequest {
	static outcomes: UploadOutcome[] = [];
	static abortedCount = 0;
	static recordedHeaders: Array<Map<string, string>> = [];

	upload = {
		onprogress: null as ((event: ProgressEvent<EventTarget>) => void) | null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	status = 0;
	statusText = "";
	timeout = 0;
	private headers = new Map<string, string>();
	private completed = false;

	static setOutcomes(outcomes: UploadOutcome[]) {
		MockXMLHttpRequest.outcomes = [...outcomes];
		MockXMLHttpRequest.abortedCount = 0;
		MockXMLHttpRequest.recordedHeaders = [];
	}

	open() {}

	setRequestHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}

	getResponseHeader(name: string) {
		return this.headers.get(name.toLowerCase()) ?? null;
	}

	send(part: Blob) {
		MockXMLHttpRequest.recordedHeaders.push(new Map(this.headers));

		const outcome = MockXMLHttpRequest.outcomes.shift();
		if (!outcome) {
			throw new Error("Missing upload outcome");
		}

		this.upload.onprogress?.({
			lengthComputable: true,
			loaded: part.size,
			total: part.size,
		} as ProgressEvent<EventTarget>);

		if (outcome.type === "pending") {
			return;
		}

		if (outcome.type === "network-error") {
			this.completed = true;
			this.onerror?.();
			return;
		}

		this.completed = true;
		this.status = 200;
		this.statusText = "OK";
		this.headers.set("etag", `"${outcome.etag}"`);
		this.onload?.();
	}

	abort() {
		if (this.completed) {
			return;
		}

		this.completed = true;
		MockXMLHttpRequest.abortedCount += 1;
		this.onabort?.();
	}
}

const makeJsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

const makeBlob = (size: number, type: string) =>
	new Blob([new Uint8Array(size)], { type });
const videoId = "video-123" as VideoId;

describe("InstantRecordingUploader", () => {
	beforeEach(() => {
		vi.stubGlobal("window", globalThis as typeof globalThis & Window);
		vi.stubGlobal(
			"XMLHttpRequest",
			MockXMLHttpRequest as unknown as typeof XMLHttpRequest,
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("uploads streamed chunks and completes multipart with the raw subpath", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/presign-part") {
					expect(body).toMatchObject({
						videoId,
						uploadId: "upload-123",
						partNumber: 1,
						subpath: "raw-upload.webm",
					});
					return makeJsonResponse({
						presignedUrl: "https://uploads.example/part-1",
					});
				}

				if (url === "/api/upload/multipart/complete") {
					expect(body).toMatchObject({
						videoId,
						uploadId: "upload-123",
						subpath: "raw-upload.webm",
						durationInSecs: 12,
						width: 1920,
						height: 1080,
					});
					expect(body.parts).toHaveLength(1);
					expect(body.parts[0]).toMatchObject({
						partNumber: 1,
						etag: "etag-1",
					});
					return makeJsonResponse({ success: true });
				}

				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([{ type: "success", etag: "etag-1" }]);

		const setUploadStatus = vi.fn();
		const sendProgressUpdate = vi.fn().mockResolvedValue(undefined);
		const onChunkStateChange = vi.fn();

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus,
			sendProgressUpdate,
			onChunkStateChange,
		});

		const chunk = makeBlob(STREAMED_PART_BYTES, "video/webm;codecs=vp9,opus");
		uploader.handleChunk(chunk, chunk.size);

		await uploader.finalize({
			durationSeconds: 12,
			width: 1920,
			height: 1080,
			subpath: "raw-upload.webm",
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sendProgressUpdate).toHaveBeenLastCalledWith(chunk.size, chunk.size);
		expect(setUploadStatus).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: "uploadingVideo",
				capId: videoId,
				progress: 100,
			}),
		);
		expect(onChunkStateChange).toHaveBeenLastCalledWith([
			expect.objectContaining({
				partNumber: 1,
				status: "complete",
			}),
		]);
		expect(MockXMLHttpRequest.recordedHeaders[0]?.has("content-type")).toBe(
			false,
		);
	});

	it("normalizes multipart initiate content type before creating the upload", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/initiate") {
					expect(body).toMatchObject({
						videoId,
						contentType: "video/webm",
						subpath: "raw-upload.webm",
					});
					return makeJsonResponse({ uploadId: "upload-123" });
				}

				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);

		vi.stubGlobal("fetch", fetchMock);

		const { initiateMultipartUpload } = await import(
			"@/app/(org)/dashboard/caps/components/web-recorder-dialog/instant-mp4-uploader"
		);

		await expect(
			initiateMultipartUpload({
				videoId,
				contentType: "video/webm;codecs=vp9,opus",
				subpath: "raw-upload.webm",
			}),
		).resolves.toBe("upload-123");
	});

	it("completes multipart uploads with parts ordered by part number", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/presign-part") {
					return makeJsonResponse({
						presignedUrl: `https://uploads.example/part-${body.partNumber}`,
					});
				}

				if (url === "/api/upload/multipart/complete") {
					expect(body.parts).toEqual([
						expect.objectContaining({ partNumber: 1, etag: "etag-1" }),
						expect.objectContaining({ partNumber: 2, etag: "etag-2" }),
					]);
					return makeJsonResponse({ success: true });
				}

				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([
			{ type: "success", etag: "etag-1" },
			{ type: "success", etag: "etag-2" },
		]);

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
			onChunkStateChange: vi.fn(),
		});

		const firstChunk = makeBlob(
			STREAMED_PART_BYTES,
			"video/webm;codecs=vp9,opus",
		);
		const secondChunk = makeBlob(
			STREAMED_PART_BYTES,
			"video/webm;codecs=vp9,opus",
		);

		uploader.handleChunk(firstChunk, firstChunk.size);
		uploader.handleChunk(secondChunk, firstChunk.size + secondChunk.size);

		await uploader.finalize({
			durationSeconds: 14,
			subpath: "raw-upload.webm",
		});
	});

	it("retries a failed part upload before completing", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();

			if (url === "/api/upload/multipart/presign-part") {
				return makeJsonResponse({
					presignedUrl: `https://uploads.example/${fetchMock.mock.calls.length}`,
				});
			}

			if (url === "/api/upload/multipart/complete") {
				return makeJsonResponse({ success: true });
			}

			throw new Error(`Unexpected fetch call: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([
			{ type: "network-error" },
			{ type: "success", etag: "etag-retried" },
		]);

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
			onChunkStateChange: vi.fn(),
		});

		const chunk = makeBlob(STREAMED_PART_BYTES, "video/webm;codecs=vp9,opus");
		uploader.handleChunk(chunk, chunk.size);

		const finalizePromise = uploader.finalize({
			durationSeconds: 8,
			subpath: "raw-upload.webm",
		});

		await vi.runAllTimersAsync();
		await finalizePromise;

		const presignCalls = fetchMock.mock.calls.filter(
			([input]) => input.toString() === "/api/upload/multipart/presign-part",
		);
		expect(presignCalls).toHaveLength(2);
	});

	it("retries a stalled part upload before completing", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();

			if (url === "/api/upload/multipart/presign-part") {
				return makeJsonResponse({
					presignedUrl: `https://uploads.example/${fetchMock.mock.calls.length}`,
				});
			}

			if (url === "/api/upload/multipart/complete") {
				return makeJsonResponse({ success: true });
			}

			throw new Error(`Unexpected fetch call: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([
			{ type: "pending" },
			{ type: "success", etag: "etag-after-stall" },
		]);

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
			onChunkStateChange: vi.fn(),
		});

		const chunk = makeBlob(STREAMED_PART_BYTES, "video/webm;codecs=vp9,opus");
		uploader.handleChunk(chunk, chunk.size);

		const finalizePromise = uploader.finalize({
			durationSeconds: 8,
			subpath: "raw-upload.webm",
		});

		await vi.advanceTimersByTimeAsync(30_500);
		await finalizePromise;

		const presignCalls = fetchMock.mock.calls.filter(
			([input]) => input.toString() === "/api/upload/multipart/presign-part",
		);
		expect(presignCalls).toHaveLength(2);
		expect(MockXMLHttpRequest.abortedCount).toBe(1);
	});

	it("marks the uploader as fatal after the final retry fails", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();

			if (url === "/api/upload/multipart/presign-part") {
				return makeJsonResponse({
					presignedUrl: `https://uploads.example/${fetchMock.mock.calls.length}`,
				});
			}

			throw new Error(`Unexpected fetch call: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([
			{ type: "network-error" },
			{ type: "network-error" },
			{ type: "network-error" },
		]);

		const onFatalError = vi.fn();
		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
			onChunkStateChange: vi.fn(),
			onFatalError,
		});

		const chunk = makeBlob(STREAMED_PART_BYTES, "video/webm;codecs=vp9,opus");
		uploader.handleChunk(chunk, chunk.size);

		const finalizePromise = uploader.finalize({
			durationSeconds: 8,
			subpath: "raw-upload.webm",
		});
		const finalizeExpectation = expect(finalizePromise).rejects.toThrow(
			"Failed to upload part 1: network error",
		);

		await vi.runAllTimersAsync();
		await finalizeExpectation;
		expect(onFatalError).toHaveBeenCalledTimes(1);
		expect(() => uploader.handleChunk(chunk, chunk.size)).toThrow(
			"Failed to upload part 1: network error",
		);
	});

	it("keeps finalize successful when server-side processing has not started yet", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/presign-part") {
					expect(body).toMatchObject({
						videoId,
						uploadId: "upload-123",
						partNumber: 1,
						subpath: "raw-upload.webm",
					});
					return makeJsonResponse({
						presignedUrl: "https://uploads.example/part-1",
					});
				}

				if (url === "/api/upload/multipart/complete") {
					return makeJsonResponse({
						success: true,
						processingStarted: false,
					});
				}

				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([{ type: "success", etag: "etag-1" }]);

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
		});

		const chunk = makeBlob(STREAMED_PART_BYTES, "video/webm;codecs=vp9,opus");
		uploader.handleChunk(chunk, chunk.size);

		await expect(
			uploader.finalize({
				durationSeconds: 12,
				subpath: "raw-upload.webm",
			}),
		).resolves.toBeUndefined();
		expect(uploader.getProcessingStarted()).toBe(false);
	});

	it("treats interrupted multipart completion as uncertain instead of fatal cleanup", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/presign-part") {
					expect(body).toMatchObject({
						videoId,
						uploadId: "upload-123",
						partNumber: 1,
						subpath: "raw-upload.webm",
					});
					return makeJsonResponse({
						presignedUrl: "https://uploads.example/part-1",
					});
				}

				if (url === "/api/upload/multipart/complete") {
					return new Response("gateway timeout", { status: 504 });
				}

				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([{ type: "success", etag: "etag-1" }]);

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
		});

		const chunk = makeBlob(STREAMED_PART_BYTES, "video/webm;codecs=vp9,opus");
		uploader.handleChunk(chunk, chunk.size);

		await expect(
			uploader.finalize({
				durationSeconds: 12,
				subpath: "raw-upload.webm",
			}),
		).rejects.toBeInstanceOf(MultipartCompletionUncertainError);
	});

	it("surfaces upload overflow before multipart completion", async () => {
		const onOverflow = vi.fn();

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
			onOverflow,
		});

		const chunk = makeBlob(OVERFLOW_PART_BYTES, "video/webm;codecs=vp9,opus");

		expect(() => uploader.handleChunk(chunk, chunk.size)).toThrow(
			"Upload could not keep up with recording",
		);
		expect(onOverflow).toHaveBeenCalledTimes(1);
		await expect(
			uploader.finalize({
				durationSeconds: 20,
				subpath: "raw-upload.webm",
			}),
		).rejects.toThrow("Upload could not keep up with recording");
	});

	it("uploads large finalized blobs in multiple parts without hitting live overflow limits", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/presign-part") {
					return makeJsonResponse({
						presignedUrl: `https://uploads.example/part-${body.partNumber}`,
					});
				}

				if (url === "/api/upload/multipart/complete") {
					expect(body.parts).toHaveLength(9);
					expect(body.parts[0]).toMatchObject({
						partNumber: 1,
						etag: "etag-1",
					});
					expect(body.parts[8]).toMatchObject({
						partNumber: 9,
						etag: "etag-9",
					});
					return makeJsonResponse({ success: true });
				}

				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes(
			Array.from({ length: 9 }, (_, index) => ({
				type: "success" as const,
				etag: `etag-${index + 1}`,
			})),
		);

		const sendProgressUpdate = vi.fn().mockResolvedValue(undefined);
		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/mp4",
			subpath: "raw-upload.mp4",
			setUploadStatus: vi.fn(),
			sendProgressUpdate,
			onChunkStateChange: vi.fn(),
		});

		await uploader.finalize({
			finalBlob: makeBlob(FINALIZED_BLOB_BYTES, "video/mp4"),
			durationSeconds: 180,
			subpath: "raw-upload.mp4",
		});

		const presignCalls = fetchMock.mock.calls.filter(
			([input]) => input.toString() === "/api/upload/multipart/presign-part",
		);
		expect(presignCalls).toHaveLength(9);
		expect(sendProgressUpdate).toHaveBeenLastCalledWith(
			FINALIZED_BLOB_BYTES,
			FINALIZED_BLOB_BYTES,
		);
	});

	it("aborts multipart uploads with the raw subpath on cancel", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/abort") {
					expect(body).toEqual({
						videoId,
						uploadId: "upload-123",
						subpath: "raw-upload.webm",
					});
					return makeJsonResponse({ success: true });
				}

				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);

		vi.stubGlobal("fetch", fetchMock);

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
		});

		await uploader.cancel();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("aborts in-flight part uploads immediately on cancel", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();

			if (url === "/api/upload/multipart/presign-part") {
				return makeJsonResponse({
					presignedUrl: "https://uploads.example/part-1",
				});
			}

			if (url === "/api/upload/multipart/abort") {
				return makeJsonResponse({ success: true });
			}

			throw new Error(`Unexpected fetch call: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([{ type: "pending" }]);

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
		});

		const chunk = makeBlob(STREAMED_PART_BYTES, "video/webm;codecs=vp9,opus");
		uploader.handleChunk(chunk, chunk.size);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/upload/multipart/presign-part",
			expect.objectContaining({
				method: "POST",
			}),
		);
		expect(MockXMLHttpRequest.outcomes).toHaveLength(0);
		await uploader.cancel();

		expect(MockXMLHttpRequest.abortedCount).toBe(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/upload/multipart/abort",
			expect.objectContaining({
				method: "POST",
			}),
		);
	});

	it("cancels cleanly while waiting to retry a failed part upload", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();

			if (url === "/api/upload/multipart/presign-part") {
				return makeJsonResponse({
					presignedUrl: "https://uploads.example/part-1",
				});
			}

			if (url === "/api/upload/multipart/abort") {
				return makeJsonResponse({ success: true });
			}

			throw new Error(`Unexpected fetch call: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([{ type: "network-error" }]);

		const uploader = new InstantRecordingUploader({
			videoId,
			uploadId: "upload-123",
			mimeType: "video/webm;codecs=vp9,opus",
			subpath: "raw-upload.webm",
			setUploadStatus: vi.fn(),
			sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
		});

		const chunk = makeBlob(STREAMED_PART_BYTES, "video/webm;codecs=vp9,opus");
		uploader.handleChunk(chunk, chunk.size);

		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(
			Promise.race([
				uploader.cancel().then(() => "cancelled"),
				new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
			]),
		).resolves.toBe("cancelled");
	});
});
