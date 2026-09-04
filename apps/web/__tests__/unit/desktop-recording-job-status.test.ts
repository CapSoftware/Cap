import { afterEach, describe, expect, it, vi } from "vitest";
import {
	observeDesktopRecordingJob,
	reconcileDesktopRecordingJob,
} from "@/lib/desktop-recording-job-status";

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
	it("does not treat a replica-local 404 as worker death", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 404 }));
		vi.stubGlobal("fetch", fetcher);
		expect(await observeDesktopRecordingJob(input)).toEqual({
			status: "unavailable",
			delivered: false,
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("identifies workers whose lease can only be renewed by their own callback", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					jobId: "job",
					videoId: "video",
					phase: "processing",
					recordingWorker: { version: 1, action: "progress", sequence: 3 },
				}),
			),
		);
		expect(await observeDesktopRecordingJob(input)).toEqual({
			status: "active",
			delivered: false,
			workerProtocol: 1,
		});
	});

	it.each([
		{ success: true },
		{
			recordingWorker: {
				version: 1,
				status: "accepted",
				generation: "generation",
				attemptId: "attempt",
				jobId: "other",
				sequence: 4,
			},
		},
		{
			recordingWorker: {
				version: 1,
				status: "stale",
				generation: "generation",
				attemptId: "attempt",
				jobId: "job",
				sequence: 4,
			},
		},
	])(
		"requires an exact terminal acknowledgement for owned workers",
		async (ack) => {
			const fetcher = vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({
						jobId: "job",
						videoId: "video",
						generation: "generation",
						attemptId: "attempt",
						phase: "complete",
						recordingWorker: { version: 1, action: "progress", sequence: 4 },
					}),
				)
				.mockResolvedValueOnce(Response.json(ack));
			vi.stubGlobal("fetch", fetcher);
			expect(await observeDesktopRecordingJob(input)).toEqual({
				status: "terminal",
				delivered: false,
			});
		},
	);

	it("accepts an exact redelivery acknowledgement after the completion ACK was lost", async () => {
		const fence = {
			generation: "generation",
			attemptId: "attempt",
			jobId: "job",
		};
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({
						...fence,
						videoId: "video",
						phase: "complete",
						recordingWorker: { version: 1, action: "progress", sequence: 4 },
					}),
				)
				.mockResolvedValueOnce(
					Response.json({
						recordingWorker: {
							...fence,
							version: 1,
							status: "accepted",
							sequence: 4,
						},
					}),
				),
		);
		expect(await reconcileDesktopRecordingJob(input)).toBe(true);
	});

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

	it.each([
		{ generation: "old", attemptId: "attempt", inventorySha256: "inventory" },
		{
			generation: "generation",
			attemptId: "old",
			inventorySha256: "inventory",
		},
		{ generation: "generation", attemptId: "attempt", inventorySha256: "old" },
		{},
	])(
		"never forwards a completion outside the current immutable attempt %j",
		async (context) => {
			const fetcher = vi.fn().mockResolvedValueOnce(
				Response.json({
					jobId: "job",
					videoId: "video",
					phase: "complete",
					...context,
				}),
			);
			vi.stubGlobal("fetch", fetcher);
			expect(
				await observeDesktopRecordingJob({
					...input,
					generation: "generation",
					attemptId: "attempt",
					inventorySha256: "inventory",
				}),
			).toEqual({ status: "unavailable", delivered: false });
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);

	it("distinguishes a positively observed active attempt from a lost worker", async () => {
		const context = {
			generation: "generation",
			attemptId: "attempt",
			inventorySha256: "inventory",
		};
		const fetcher = vi.fn().mockResolvedValueOnce(
			Response.json({
				jobId: "job",
				videoId: "video",
				phase: "processing",
				...context,
			}),
		);
		vi.stubGlobal("fetch", fetcher);
		expect(await observeDesktopRecordingJob({ ...input, ...context })).toEqual({
			status: "active",
			delivered: false,
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});
});
