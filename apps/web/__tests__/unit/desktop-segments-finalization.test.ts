import type { User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensure: vi.fn(),
	state: vi.fn(),
	recoverable: vi.fn(),
	start: vi.fn(),
	attach: vi.fn(),
	dispatchFailure: vi.fn(),
	transcribe: vi.fn(),
}));
vi.mock("@cap/database", () => ({
	db: () => ({ select: () => ({ from: () => ({ where: async () => [] }) }) }),
}));
vi.mock("@cap/database/schema", () => ({ users: {}, videos: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => false,
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: mocks.transcribe }));
vi.mock("@/workflows/finalize-desktop-recording", () => ({
	finalizeDesktopRecordingWorkflow: vi.fn(),
}));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	ensureSegmentProcessingJob: mocks.ensure,
	getProcessingState: mocks.state,
	isDesktopRecordingJobRecoverable: mocks.recoverable,
	attachWorkflowRun: mocks.attach,
	recordWorkflowDispatchFailure: mocks.dispatchFailure,
	SourceCommitPendingError: class SourceCommitPendingError extends Error {},
	DesktopRecordingSourceBlockedError: class DesktopRecordingSourceBlockedError extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	},
}));

import {
	DesktopRecordingSourceBlockedError,
	SourceCommitPendingError,
} from "@/lib/desktop-recording-jobs";
import { queueDesktopSegmentsFinalization } from "@/lib/desktop-segments-finalization";

const input = {
	videoId: "video" as Video.VideoId,
	userId: "user" as User.UserId,
};
const job = {
	videoId: input.videoId,
	ownerId: input.userId,
	generation: "generation",
	state: "committing",
	source: null,
};
const committed = { ...job, state: "processing", source: { kind: "segments" } };

beforeEach(() => {
	mocks.ensure.mockResolvedValue({ job, created: true });
	mocks.state.mockResolvedValue(job);
	mocks.recoverable.mockReturnValue(true);
	mocks.start.mockResolvedValue({ runId: "run" });
	mocks.attach.mockResolvedValue(undefined);
	mocks.dispatchFailure.mockResolvedValue(undefined);
	mocks.transcribe.mockResolvedValue({ success: true });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("durable finalization acknowledgement", () => {
	it("persists intent before starting a workflow and does not acknowledge an uncommitted source", async () => {
		await expect(
			queueDesktopSegmentsFinalization(input),
		).rejects.toBeInstanceOf(SourceCommitPendingError);
		expect(mocks.ensure.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.start.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), [
			{ ...input, generation: job.generation },
		]);
		expect(mocks.attach).toHaveBeenCalledWith({
			videoId: input.videoId,
			generation: job.generation,
			workflowRunId: "run",
		});
	});

	it("leaves an uncommitted job recoverable when workflow dispatch fails", async () => {
		mocks.start.mockRejectedValueOnce(new Error("queue offline"));
		await expect(
			queueDesktopSegmentsFinalization(input),
		).rejects.toBeInstanceOf(SourceCommitPendingError);
		expect(mocks.dispatchFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				generation: job.generation,
				errorMessage: "queue offline",
			}),
		);
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("acknowledges retained source independently from a temporary dispatch outage", async () => {
		mocks.ensure.mockResolvedValue({ job: committed, created: false });
		mocks.state.mockResolvedValue(committed);
		mocks.start.mockRejectedValueOnce(new Error("queue offline"));
		await expect(queueDesktopSegmentsFinalization(input)).resolves.toBe(
			"already-processing",
		);
		expect(mocks.dispatchFailure).toHaveBeenCalledOnce();
	});

	it("keeps transcription errors and recording ids out of the log format string", async () => {
		const request = { ...input, videoId: "%s%d" as Video.VideoId };
		const retained = { ...committed, videoId: request.videoId };
		const error = new Error("Transcription unavailable");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.ensure.mockResolvedValue({ job: retained, created: true });
		mocks.state.mockResolvedValue(retained);
		mocks.transcribe.mockRejectedValueOnce(error);
		await expect(queueDesktopSegmentsFinalization(request)).resolves.toBe(
			"queued",
		);
		expect(warning).toHaveBeenCalledWith(
			"[queueDesktopSegmentsFinalization] Early transcription queue failed",
			{ videoId: request.videoId, error },
		);
	});

	it("does not launch another workflow while an attempt has a live lease", async () => {
		mocks.ensure.mockResolvedValue({ job: committed, created: false });
		mocks.state.mockResolvedValue(committed);
		mocks.recoverable.mockReturnValue(false);
		await expect(queueDesktopSegmentsFinalization(input)).resolves.toBe(
			"already-processing",
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("never acknowledges a source from a generation that was replaced during dispatch", async () => {
		mocks.ensure.mockResolvedValue({ job: committed, created: false });
		mocks.state.mockResolvedValue(null);
		await expect(
			queueDesktopSegmentsFinalization(input),
		).rejects.toBeInstanceOf(SourceCommitPendingError);
	});

	it("keeps incomplete source separate from transient worker failure", async () => {
		mocks.ensure.mockResolvedValue({ job: committed, created: false });
		mocks.recoverable.mockReturnValue(false);
		mocks.state.mockResolvedValue({
			...committed,
			state: "source-blocked",
			errorCode: "source-incomplete",
			errorMessage: "Audio fragment is missing",
		});
		await expect(
			queueDesktopSegmentsFinalization(input),
		).rejects.toBeInstanceOf(DesktopRecordingSourceBlockedError);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("passes a late client proof into the existing durable intent", async () => {
		const verification = {
			version: 1 as const,
			artifact: { kind: "segments" as const, manifestSha256: "a".repeat(64) },
			requiredAudio: false,
		};
		mocks.ensure.mockResolvedValue({ job: committed, created: false });
		mocks.state.mockResolvedValue(committed);
		mocks.recoverable.mockReturnValue(false);
		await queueDesktopSegmentsFinalization({ ...input, verification });
		expect(mocks.ensure).toHaveBeenCalledWith({ ...input, verification });
		expect(mocks.start).not.toHaveBeenCalled();
	});
});
