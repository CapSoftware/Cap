import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://worker.example.com",
		LOOM_IMPORTER_URL: "https://media.example.com/loom-importer",
		MEDIA_SERVER_WEBHOOK_SECRET: "fixture-secret",
	}),
}));
vi.mock("@cap/database", () => ({ db: vi.fn() }));

import { getLoomImporterJobState } from "@/lib/loom-media-dispatch";

describe("getLoomImporterJobState", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		[{ jobId: "job", videoId: "video", phase: "downloading" }, "running"],
		[{ jobId: "job", videoId: "video", phase: "queued" }, "running"],
		[{ jobId: "job", videoId: "video", phase: "complete" }, "finished"],
		[{ jobId: "job", videoId: "video", phase: "error" }, "finished"],
		[{ jobId: "job", videoId: "video", phase: "cancelled" }, "finished"],
		[{ jobId: "job", videoId: "other", phase: "error" }, "unknown"],
	])("reads the importer's job %j", async (body, expected) => {
		const fetch = vi.fn().mockResolvedValue(Response.json(body));
		vi.stubGlobal("fetch", fetch);
		await expect(
			getLoomImporterJobState({ jobId: "job", videoId: "video" }),
		).resolves.toBe(expected);
		expect(fetch).toHaveBeenCalledWith(
			"https://media.example.com/loom-importer/video/process/job/status",
			expect.objectContaining({ redirect: "error" }),
		);
	});

	it("knows a job the importer no longer has", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("missing", { status: 404 })),
		);
		await expect(
			getLoomImporterJobState({ jobId: "job", videoId: "video" }),
		).resolves.toBe("missing");
	});

	it.each([
		[() => Promise.resolve(new Response("down", { status: 503 }))],
		[() => Promise.reject(new Error("network"))],
	])("cannot tell when the importer does not answer: %#", async (respond) => {
		vi.stubGlobal("fetch", vi.fn().mockImplementation(respond));
		await expect(
			getLoomImporterJobState({ jobId: "job", videoId: "video" }),
		).resolves.toBe("unknown");
	});

	it("looks a video up in the importer's job list when there is no job id", async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				jobs: [{ jobId: "other", videoId: "other-video", phase: "queued" }],
			}),
		);
		vi.stubGlobal("fetch", fetch);
		await expect(getLoomImporterJobState({ videoId: "video" })).resolves.toBe(
			"missing",
		);
		fetch.mockResolvedValue(
			Response.json({
				jobs: [{ jobId: "j", videoId: "video", phase: "queued" }],
			}),
		);
		await expect(getLoomImporterJobState({ videoId: "video" })).resolves.toBe(
			"running",
		);
		expect(fetch).toHaveBeenCalledWith(
			"https://media.example.com/loom-importer/video/status",
			expect.anything(),
		);
	});
});
