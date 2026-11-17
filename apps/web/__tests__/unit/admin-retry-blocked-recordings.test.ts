import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	retry: vi.fn(),
	state: vi.fn(),
	ensure: vi.fn(),
	attach: vi.fn(),
	dispatchFailure: vi.fn(),
	start: vi.fn(),
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/database/schema", () => ({ users: {}, videos: {} }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@/lib/messenger/constants", () => ({
	MESSENGER_ADMIN_EMAIL: "admin@cap.test",
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/finalize-desktop-recording", () => ({
	finalizeDesktopRecordingWorkflow: vi.fn(),
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: vi.fn(),
}));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	retryBlockedDesktopRecording: mocks.retry,
	getProcessingState: mocks.state,
	ensureSegmentProcessingJob: mocks.ensure,
	isDesktopRecordingJobRecoverable: () => true,
	attachWorkflowRun: mocks.attach,
	recordWorkflowDispatchFailure: mocks.dispatchFailure,
	DesktopRecordingSourceBlockedError: class extends Error {},
	SourceCommitPendingError: class extends Error {},
}));

import { adminRetryBlockedRecordings } from "@/actions/admin/retry-blocked-recordings";

const source = { kind: "mp4" };
let current: Record<string, unknown>;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.user.mockResolvedValue({ email: "admin@cap.test" });
	mocks.retry.mockResolvedValue({
		status: "queued",
		ownerId: "owner1",
		previousErrorCode: "processing-budget-exhausted",
	});
	current = { state: "retry", source, errorCode: null };
	mocks.ensure.mockImplementation(async () => ({
		job: { generation: "generation", ...current },
		created: false,
	}));
	mocks.state.mockImplementation(async () => ({ ...current }));
	mocks.start.mockResolvedValue({ runId: "run" });
	mocks.dispatchFailure.mockImplementation(async () => {
		current = { ...current, errorCode: "workflow-dispatch-failed" };
	});
});

describe("admin retry of blocked recordings", () => {
	it("rejects anyone who is not the admin", async () => {
		mocks.user.mockResolvedValue({ email: "someone@cap.test" });
		await expect(adminRetryBlockedRecordings("video1")).rejects.toThrow(
			"Unauthorized",
		);
		expect(mocks.retry).not.toHaveBeenCalled();
	});

	it("limits a request to 25 recordings", async () => {
		const input = Array.from({ length: 26 }, (_, i) => `video${i}`).join("\n");
		await expect(adminRetryBlockedRecordings(input)).rejects.toThrow(
			"at most 25",
		);
		expect(mocks.retry).not.toHaveBeenCalled();
	});

	it("starts the finalize workflow for a released recording", async () => {
		expect(await adminRetryBlockedRecordings("blocked1")).toEqual([
			{
				input: "blocked1",
				videoId: "blocked1",
				status: "queued",
				detail: "was processing-budget-exhausted",
				shareUrl: "https://cap.test/s/blocked1",
			},
		]);
		expect(mocks.start).toHaveBeenCalledOnce();
		expect(mocks.attach).toHaveBeenCalledWith({
			videoId: "blocked1",
			generation: "generation",
			workflowRunId: "run",
		});
	});

	it("reports a workflow that failed to start instead of claiming it was queued", async () => {
		mocks.start.mockRejectedValue(new Error("Workflow API unavailable"));
		expect(await adminRetryBlockedRecordings("blocked1")).toEqual([
			{
				input: "blocked1",
				videoId: "blocked1",
				status: "dispatch-failed",
				detail: "the workflow did not start; automatic recovery will retry it",
				shareUrl: "https://cap.test/s/blocked1",
			},
		]);
		expect(mocks.dispatchFailure).toHaveBeenCalledOnce();
	});

	it("handles each video once and reports the rest without starting them", async () => {
		mocks.retry.mockImplementation(async ({ videoId }: { videoId: string }) =>
			videoId === "blocked1"
				? {
						status: "queued",
						ownerId: "owner1",
						previousErrorCode: "source-invalid",
					}
				: videoId === "missing1"
					? { status: "not-found" }
					: { status: "not-retryable", state: "verified", errorCode: null },
		);
		const results = await adminRetryBlockedRecordings(
			"https://cap.so/s/blocked1\nmissing1, verified1 blocked1",
		);
		expect(results.map(({ videoId, status }) => [videoId, status])).toEqual([
			["blocked1", "queued"],
			["missing1", "not-found"],
			["verified1", "not-retryable"],
		]);
		expect(mocks.retry).toHaveBeenCalledTimes(3);
		expect(mocks.start).toHaveBeenCalledOnce();
	});
});
