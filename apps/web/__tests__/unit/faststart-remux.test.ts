import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ after: vi.fn() }));

vi.mock("next/server", () => ({ after: mocks.after }));

const { startFaststartRemux } = await import("@/lib/faststart-remux");

const request = {
	videoId: "video-1",
	userId: "user-1",
	videoUrl: "https://storage.example/get/raw",
	outputPresignedUrl: "https://storage.example/put/raw",
	previewGifPresignedUrl: "https://storage.example/put/gif",
};

const answer = (status: number, body = "") => new Response(body, { status });

describe("faststart remux dispatch", () => {
	const fetchMock = vi.fn();
	const settled = vi.fn();
	let deferred: Promise<void>[] = [];
	const start = (overrides: { webhookSecret?: string } = {}) =>
		startFaststartRemux({
			mediaServerUrl: "https://media.example",
			webhookSecret:
				"webhookSecret" in overrides ? overrides.webhookSecret : "secret",
			request,
			onRetriesSettled: settled,
			retryDelaysMs: [1, 1, 1],
			defer: (work) => {
				deferred.push(work);
			},
		});

	beforeEach(() => {
		vi.clearAllMocks();
		deferred = [];
		settled.mockResolvedValue(undefined);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("sends one request, the same one as before, when the media server accepts it", async () => {
		fetchMock.mockResolvedValue(answer(200, "{}"));

		expect(await start()).toBe("queued");

		expect(fetchMock.mock.calls).toEqual([
			[
				"https://media.example/video/process",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-media-server-secret": "secret",
					},
					body: JSON.stringify({
						videoId: "video-1",
						userId: "user-1",
						videoUrl: "https://storage.example/get/raw",
						outputPresignedUrl: "https://storage.example/put/raw",
						previewGifPresignedUrl: "https://storage.example/put/gif",
						remuxOnly: true,
					}),
				},
			],
		]);
		expect(deferred).toHaveLength(0);
		expect(mocks.after).not.toHaveBeenCalled();
		expect(settled).not.toHaveBeenCalled();
		expect(console.error).not.toHaveBeenCalled();
	});

	it("leaves the secret header out when no secret is configured, as before", async () => {
		fetchMock.mockResolvedValue(answer(200, "{}"));

		await start({ webhookSecret: undefined });

		expect(fetchMock.mock.calls[0]?.[1].headers).toEqual({
			"Content-Type": "application/json",
		});
	});

	it("answers straight away when the media server is busy and queues the remux once it has room", async () => {
		fetchMock
			.mockResolvedValueOnce(answer(503, "SERVER_BUSY"))
			.mockResolvedValueOnce(answer(503, "SERVER_BUSY"))
			.mockResolvedValue(answer(200, "{}"));

		expect(await start()).toBe("retrying");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(deferred).toHaveLength(1);

		await deferred[0];

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(settled.mock.calls).toEqual([[true]]);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			"https://media.example/video/process",
		);
		expect(JSON.parse(fetchMock.mock.calls[2]?.[1].body)).toMatchObject({
			videoId: "video-1",
			remuxOnly: true,
		});
	});

	it("retries when the media server cannot be reached", async () => {
		fetchMock
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValue(answer(200, "{}"));

		expect(await start()).toBe("retrying");
		await deferred[0];

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(settled.mock.calls).toEqual([[true]]);
	});

	it("gives up after three more tries and says so, so transcription can go ahead without the remux", async () => {
		fetchMock.mockImplementation(async () => answer(503, "SERVER_BUSY"));

		expect(await start()).toBe("retrying");
		await deferred[0];

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(settled.mock.calls).toEqual([[false]]);
	});

	it("does not retry a request the media server refused", async () => {
		fetchMock.mockResolvedValue(answer(400, "bad request"));

		expect(await start()).toBe("failed");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(deferred).toHaveLength(0);
		expect(settled).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			"Failed to queue faststart remux:",
			expect.objectContaining({
				message: "Media server remux failed: 400 bad request",
			}),
		);
	});

	it("stops retrying when a later answer is a refusal", async () => {
		fetchMock
			.mockResolvedValueOnce(answer(502))
			.mockResolvedValue(answer(422, "unreadable"));

		expect(await start()).toBe("retrying");
		await deferred[0];

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(settled.mock.calls).toEqual([[false]]);
	});

	it("behaves as it did before when nothing can run after the response", async () => {
		fetchMock.mockResolvedValue(answer(503, "SERVER_BUSY"));
		mocks.after.mockImplementation(() => {
			throw new Error("after() called outside a request scope");
		});

		expect(
			await startFaststartRemux({
				mediaServerUrl: "https://media.example",
				webhookSecret: "secret",
				request,
				onRetriesSettled: settled,
			}),
		).toBe("failed");

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(settled).not.toHaveBeenCalled();
	});

	it("hands the retries to the platform so they outlive the response", async () => {
		fetchMock
			.mockResolvedValueOnce(answer(504))
			.mockResolvedValue(answer(200, "{}"));

		expect(
			await startFaststartRemux({
				mediaServerUrl: "https://media.example",
				webhookSecret: "secret",
				request,
				onRetriesSettled: settled,
				retryDelaysMs: [1],
			}),
		).toBe("retrying");

		expect(mocks.after).toHaveBeenCalledTimes(1);
		await mocks.after.mock.calls[0]?.[0];
		expect(settled.mock.calls).toEqual([[true]]);
	});

	it("does not let a failure while settling escape into the platform", async () => {
		fetchMock
			.mockResolvedValueOnce(answer(503))
			.mockResolvedValue(answer(200, "{}"));
		settled.mockRejectedValue(new Error("database unavailable"));

		expect(await start()).toBe("retrying");

		await expect(deferred[0]).resolves.toBeUndefined();
	});
});
