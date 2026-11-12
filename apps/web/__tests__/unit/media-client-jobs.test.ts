import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	startMediaServerVideoJob,
	tryProbeVideoViaMediaServer,
} from "@/lib/media-client";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "http://media.example",
		MEDIA_SERVER_WEBHOOK_SECRET: "test-secret",
	}),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const networkError = (code: string) =>
	Object.assign(new TypeError("fetch failed"), { cause: { code } });

beforeEach(() => {
	vi.clearAllMocks();
});

describe("startMediaServerVideoJob", () => {
	it("posts the job with the shared secret and returns its id", async () => {
		mockFetch.mockResolvedValue(json({ jobId: "job-1", status: "queued" }));

		const result = await startMediaServerVideoJob("/video/ladder", {
			videoId: "video-1",
		});

		expect(result).toEqual({ status: "started", jobId: "job-1" });
		const [url, init] = mockFetch.mock.calls[0] ?? [];
		expect(url).toBe("http://media.example/video/ladder");
		expect(init.headers).toMatchObject({
			"x-media-server-secret": "test-secret",
		});
		expect(JSON.parse(init.body)).toEqual({
			videoId: "video-1",
			webhookSecret: "test-secret",
		});
	});

	it.each([
		{ status: 404, expected: { status: "unavailable" } },
		{ status: 405, expected: { status: "unavailable" } },
		{ status: 503, expected: { status: "busy" } },
		{ status: 502, expected: { status: "busy" } },
	])("maps HTTP $status to $expected.status", async ({ status, expected }) => {
		mockFetch.mockResolvedValue(json({ error: "nope" }, status));

		expect(await startMediaServerVideoJob("/video/ladder", {})).toEqual(
			expected,
		);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("reports a rejected request with the server's reason", async () => {
		mockFetch.mockResolvedValue(
			json({ error: "Invalid request", details: "uploads: Required" }, 400),
		);

		expect(await startMediaServerVideoJob("/video/ladder", {})).toEqual({
			status: "rejected",
			message: "uploads: Required",
		});
	});

	it("knows the job did not start when the connection was never made", async () => {
		mockFetch.mockRejectedValue(networkError("ECONNREFUSED"));

		expect(await startMediaServerVideoJob("/video/process", {})).toEqual({
			status: "unreachable",
		});
	});

	it.each([
		{
			name: "the request timed out",
			failure: new DOMException("", "TimeoutError"),
		},
		{ name: "the connection dropped", failure: networkError("ECONNRESET") },
	])("cannot tell whether the job started when $name", async ({ failure }) => {
		mockFetch.mockRejectedValue(failure);

		expect(await startMediaServerVideoJob("/video/process", {})).toEqual({
			status: "unconfirmed",
		});
	});

	it("treats an accepted response without a job id as unconfirmed", async () => {
		mockFetch.mockResolvedValue(json({ status: "queued" }));

		expect(await startMediaServerVideoJob("/video/process", {})).toEqual({
			status: "unconfirmed",
		});
	});
});

describe("tryProbeVideoViaMediaServer", () => {
	it("returns the probed metadata", async () => {
		const metadata = { duration: 12, width: 1920, height: 1080, fps: 30 };
		mockFetch.mockResolvedValue(json({ metadata }));

		expect(await tryProbeVideoViaMediaServer("https://storage/video")).toEqual({
			status: "ok",
			metadata,
		});
		expect(mockFetch).toHaveBeenCalledWith(
			"http://media.example/video/probe",
			expect.objectContaining({
				body: JSON.stringify({ videoUrl: "https://storage/video" }),
			}),
		);
	});

	it.each([
		{
			name: "a network failure",
			setup: () => mockFetch.mockRejectedValue(networkError("ECONNREFUSED")),
		},
		{ name: "a 503", setup: () => mockFetch.mockResolvedValue(json({}, 503)) },
		{ name: "a 504", setup: () => mockFetch.mockResolvedValue(json({}, 504)) },
	])("reports $name as unreachable without retrying", async ({ setup }) => {
		setup();

		expect(await tryProbeVideoViaMediaServer("https://storage/video")).toEqual({
			status: "unreachable",
		});
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("reports a file the media server cannot read as rejected", async () => {
		mockFetch.mockResolvedValue(
			json({ error: "Probe failed", details: "Invalid data found" }, 500),
		);

		expect(await tryProbeVideoViaMediaServer("https://storage/video")).toEqual({
			status: "rejected",
			message: "Invalid data found",
			unusable: false,
		});
	});

	it("marks a 422 as a file the media server says cannot be used", async () => {
		mockFetch.mockResolvedValue(
			json(
				{
					error: "Media input cannot be used",
					details: "Media input could not be read",
				},
				422,
			),
		);

		expect(await tryProbeVideoViaMediaServer("https://storage/video")).toEqual({
			status: "rejected",
			message: "Media input could not be read",
			unusable: true,
		});
	});
});
