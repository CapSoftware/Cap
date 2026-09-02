import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileDesktopRecordingJob } from "@/lib/desktop-recording-job-status";

const input = {
	videoId: "video",
	jobId: "job",
	mediaServerUrl: "https://media.cap.test",
	webhookUrl:
		"https://cap.test/api/webhooks/media-server/progress?retryable=true",
	secret: "test-secret",
};

afterEach(() => vi.unstubAllGlobals());

describe("recording job completion reconciliation", () => {
	it("redelivers a lost completion through the validated webhook", async () => {
		const proof = {
			request: { version: 1 },
			fullDecode: true,
			objectIdentity: '"object"',
		};
		const payload = {
			jobId: "job",
			videoId: "video",
			phase: "complete",
			recordingVerification: proof,
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(payload))
			.mockResolvedValueOnce(Response.json({ success: true }));
		vi.stubGlobal("fetch", fetcher);
		expect(await reconcileDesktopRecordingJob(input)).toBe(true);
		expect(fetcher).toHaveBeenLastCalledWith(
			input.webhookUrl,
			expect.objectContaining({
				body: JSON.stringify(payload),
				method: "POST",
			}),
		);
	});

	it.each([
		{ jobId: "other", videoId: "video", phase: "complete" },
		{ jobId: "job", videoId: "other", phase: "complete" },
		{ jobId: "job", videoId: "video", phase: "processing" },
	])(
		"does not complete from an unrelated or unfinished job %j",
		async (payload) => {
			const fetcher = vi.fn().mockResolvedValueOnce(Response.json(payload));
			vi.stubGlobal("fetch", fetcher);
			expect(await reconcileDesktopRecordingJob(input)).toBe(false);
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);

	it("retains pending state when the media server cannot be reached", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		expect(await reconcileDesktopRecordingJob(input)).toBe(false);
	});

	it("does not acknowledge completion if the webhook rejects its proof", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ jobId: "job", videoId: "video", phase: "complete" }),
			)
			.mockResolvedValueOnce(new Response(null, { status: 503 }));
		vi.stubGlobal("fetch", fetcher);
		expect(await reconcileDesktopRecordingJob(input)).toBe(false);
	});
});
