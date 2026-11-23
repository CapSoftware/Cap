import { InstantRecordingUploader } from "@cap/recorder-core/instant-mp4-uploader";
import type { VideoId } from "@cap/recorder-core/recorder-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STREAMED_PART_BYTES = 5 * 1024 * 1024;

type UploadOutcome =
	| { type: "success"; etag?: string }
	| { type: "pending"; silent?: boolean };

class MockXMLHttpRequest {
	static outcomes: UploadOutcome[] = [];
	static abortedCount = 0;
	static sent: MockXMLHttpRequest[] = [];

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
		MockXMLHttpRequest.sent = [];
	}

	open() {}

	setRequestHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}

	getResponseHeader(name: string) {
		return this.headers.get(name.toLowerCase()) ?? null;
	}

	send(part: Blob) {
		MockXMLHttpRequest.sent.push(this);
		const outcome = MockXMLHttpRequest.outcomes.shift();
		if (!outcome) throw new Error("Missing upload outcome");
		if (outcome.type !== "pending" || !outcome.silent)
			this.upload.onprogress?.({
				lengthComputable: true,
				loaded: part.size,
				total: part.size,
			} as ProgressEvent<EventTarget>);
		if (outcome.type === "pending") return;
		this.succeed(outcome.etag ?? "etag");
	}

	succeed(etag: string) {
		this.completed = true;
		this.status = 200;
		this.headers.set("etag", `"${etag}"`);
		this.onload?.();
	}

	abort() {
		if (this.completed) return;
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

const fakeApi = () => {
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
	return fetchMock;
};

const presignedPartNumbers = (fetchMock: ReturnType<typeof vi.fn>) =>
	fetchMock.mock.calls
		.filter(([input]) => String(input) === "/api/upload/multipart/presign-part")
		.map(
			([, init]) => JSON.parse((init as RequestInit).body as string).partNumber,
		);

const uploader = (adaptiveTransfer: boolean, subpath = "result.mp4") =>
	new InstantRecordingUploader({
		videoId,
		uploadId: "upload-123",
		mimeType: "video/mp4",
		subpath,
		setUploadStatus: vi.fn(),
		sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
		adaptiveTransfer,
	});

describe("Studio upload transfer", () => {
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

	it("signs the next part ahead so the tail uploads without waiting for a signature", async () => {
		const fetchMock = fakeApi();
		MockXMLHttpRequest.setOutcomes([{ type: "success", etag: "etag-1" }]);

		const upload = uploader(true, "mic-upload.webm");
		expect(presignedPartNumbers(fetchMock)).toEqual([1]);

		const chunk = makeBlob(1024, "audio/webm");
		upload.handleChunk(chunk, chunk.size);
		await upload.finalize({ durationSeconds: 1, subpath: "mic-upload.webm" });

		expect(presignedPartNumbers(fetchMock)).toEqual([1]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("signs nothing ahead for Instant uploads", async () => {
		const fetchMock = fakeApi();
		MockXMLHttpRequest.setOutcomes([{ type: "success", etag: "etag-1" }]);

		const upload = uploader(false, "raw-upload.webm");
		expect(fetchMock).not.toHaveBeenCalled();

		const chunk = makeBlob(1024, "video/webm");
		upload.handleChunk(chunk, chunk.size);
		await upload.finalize({ durationSeconds: 1, subpath: "raw-upload.webm" });

		expect(presignedPartNumbers(fetchMock)).toEqual([1]);
	});

	it("waits longer for the reply to a part the browser has fully sent", async () => {
		vi.useFakeTimers();
		fakeApi();
		MockXMLHttpRequest.setOutcomes([
			{ type: "pending" },
			{ type: "success", etag: "etag-after-drain" },
		]);

		const upload = uploader(true);
		const part = makeBlob(STREAMED_PART_BYTES, "video/mp4");
		upload.handleChunk(part, part.size);
		const finalizePromise = upload.finalize({
			durationSeconds: 8,
			subpath: "result.mp4",
		});

		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(MockXMLHttpRequest.abortedCount).toBe(0);
		await vi.advanceTimersByTimeAsync(90_000);
		await finalizePromise;
		expect(MockXMLHttpRequest.abortedCount).toBe(1);
		expect(MockXMLHttpRequest.sent).toHaveLength(2);
	});

	it("keeps the fixed stall timeout for Instant uploads", async () => {
		vi.useFakeTimers();
		fakeApi();
		MockXMLHttpRequest.setOutcomes([
			{ type: "pending" },
			{ type: "success", etag: "etag-after-stall" },
		]);

		const upload = uploader(false);
		const part = makeBlob(STREAMED_PART_BYTES, "video/mp4");
		upload.handleChunk(part, part.size);
		const finalizePromise = upload.finalize({
			durationSeconds: 8,
			subpath: "result.mp4",
		});

		await vi.advanceTimersByTimeAsync(30_500);
		expect(MockXMLHttpRequest.abortedCount).toBe(1);
		await vi.runAllTimersAsync();
		await finalizePromise;
		expect(MockXMLHttpRequest.sent).toHaveLength(2);
	});

	it("lets a part wait its turn while another part is moving", async () => {
		vi.useFakeTimers();
		fakeApi();
		MockXMLHttpRequest.setOutcomes([
			{ type: "pending", silent: true },
			{ type: "pending", silent: true },
		]);

		const upload = uploader(true);
		const part = makeBlob(STREAMED_PART_BYTES, "video/mp4");
		upload.handleChunk(part, part.size);
		upload.handleChunk(part, part.size * 2);
		const finalizePromise = upload.finalize({
			durationSeconds: 8,
			subpath: "result.mp4",
		});

		await vi.advanceTimersByTimeAsync(1_000);
		const [waiting, moving] = MockXMLHttpRequest.sent;
		expect(moving).toBeDefined();
		for (let elapsed = 0; elapsed < 120_000; elapsed += 20_000) {
			moving?.upload.onprogress?.({
				lengthComputable: true,
				loaded: elapsed,
				total: part.size,
			} as ProgressEvent<EventTarget>);
			await vi.advanceTimersByTimeAsync(20_000);
		}
		expect(MockXMLHttpRequest.abortedCount).toBe(0);

		moving?.succeed("etag-moving");
		waiting?.succeed("etag-waiting");
		await finalizePromise;
		expect(MockXMLHttpRequest.abortedCount).toBe(0);
		expect(MockXMLHttpRequest.sent).toHaveLength(2);
	});

	it("retries a part that stops while the others keep the link busy", async () => {
		vi.useFakeTimers();
		fakeApi();
		MockXMLHttpRequest.setOutcomes([
			{ type: "pending", silent: true },
			{ type: "pending", silent: true },
			{ type: "success", etag: "etag-retried" },
		]);

		const upload = uploader(true);
		const part = makeBlob(STREAMED_PART_BYTES, "video/mp4");
		upload.handleChunk(part, part.size);
		upload.handleChunk(part, part.size * 2);
		const finalizePromise = upload.finalize({
			durationSeconds: 8,
			subpath: "result.mp4",
		});

		await vi.advanceTimersByTimeAsync(1_000);
		const [stuck, moving] = MockXMLHttpRequest.sent;
		expect(stuck).toBeDefined();
		for (let step = 0; step <= 20; step++) {
			moving?.upload.onprogress?.({
				lengthComputable: true,
				loaded: step * 1024 * 1024,
				total: 64 * 1024 * 1024,
			} as ProgressEvent<EventTarget>);
			await vi.advanceTimersByTimeAsync(2_000);
		}
		expect(MockXMLHttpRequest.abortedCount).toBe(1);

		moving?.succeed("etag-moving");
		await vi.runAllTimersAsync();
		await finalizePromise;
		expect(MockXMLHttpRequest.sent).toHaveLength(3);
	});

	it("uploads several tracks' tails before any of them completes", async () => {
		const fetchMock = fakeApi();
		MockXMLHttpRequest.setOutcomes([
			{ type: "success", etag: "camera" },
			{ type: "success", etag: "mic" },
		]);

		const camera = uploader(true, "camera-upload.mp4");
		const mic = uploader(true, "mic-upload.webm");
		camera.handleChunk(makeBlob(2048, "video/mp4"), 2048);
		mic.handleChunk(makeBlob(1024, "audio/webm"), 1024);
		await Promise.all([
			camera.uploadRemaining(null),
			mic.uploadRemaining(null),
		]);

		expect(MockXMLHttpRequest.sent).toHaveLength(2);
		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).endsWith("/complete"),
			),
		).toBe(false);

		await camera.finalize({ durationSeconds: 1, subpath: "camera-upload.mp4" });
		await mic.finalize({ durationSeconds: 1, subpath: "mic-upload.webm" });
		expect(
			fetchMock.mock.calls.filter(([input]) =>
				String(input).endsWith("/complete"),
			),
		).toHaveLength(2);
		expect(MockXMLHttpRequest.sent).toHaveLength(2);
	});
});
