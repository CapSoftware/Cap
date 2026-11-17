import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://worker.example.com",
		MEDIA_SERVER_WEBHOOK_SECRET: "fixture-secret",
	}),
}));

import { isLoomMediaJobFailed } from "@/lib/loom-media-dispatch";

describe("Loom worker failure reconciliation", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		[{ jobId: "job", videoId: "video", phase: "error" }, true],
		[{ jobId: "other", videoId: "video", phase: "error" }, false],
		[{ jobId: "job", videoId: "other", phase: "error" }, false],
		[{ jobId: "job", videoId: "video", phase: "processing" }, false],
		[{ jobId: "job", videoId: "video", phase: "complete" }, false],
		[{ jobId: "job", videoId: "video", phase: "cancelled" }, false],
		[{}, false],
	])(
		"requires the exact job, recording and failed phase: %j",
		async (body, failed) => {
			const fetch = vi.fn().mockResolvedValue(Response.json(body));
			vi.stubGlobal("fetch", fetch);
			expect(await isLoomMediaJobFailed("job", "video")).toBe(failed);
			expect(fetch).toHaveBeenCalledWith(
				"https://worker.example.com/video/process/job/status",
				expect.objectContaining({ redirect: "error" }),
			);
		},
	);

	it.each([404, 500])(
		"does not treat HTTP %s as a failed job",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(new Response(null, { status })),
			);
			expect(await isLoomMediaJobFailed("job", "video")).toBe(false);
		},
	);

	it("holds an unavailable worker instead of authorizing another dispatch", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Timed out")));
		expect(await isLoomMediaJobFailed("job", "video")).toBe(false);
	});
});
