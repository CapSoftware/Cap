import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	retry: vi.fn(),
	queue: vi.fn(),
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@/lib/messenger/constants", () => ({
	MESSENGER_ADMIN_EMAIL: "admin@cap.test",
}));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	retryBlockedDesktopRecording: mocks.retry,
}));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	queueDesktopSegmentsFinalization: mocks.queue,
}));

import { adminRetryBlockedRecordings } from "@/actions/admin/retry-blocked-recordings";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.user.mockResolvedValue({ email: "admin@cap.test" });
	mocks.queue.mockResolvedValue("queued");
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

	it("queues retryable recordings once each and reports the rest without starting them", async () => {
		mocks.retry.mockImplementation(async ({ videoId }: { videoId: string }) =>
			videoId === "blocked1"
				? {
						status: "queued",
						ownerId: "owner1",
						previousErrorCode: "processing-budget-exhausted",
					}
				: videoId === "missing1"
					? { status: "not-found" }
					: { status: "not-retryable", state: "verified", errorCode: null },
		);
		const results = await adminRetryBlockedRecordings(
			"https://cap.so/s/blocked1\nmissing1, verified1 blocked1",
		);
		expect(results).toEqual([
			{
				input: "https://cap.so/s/blocked1",
				videoId: "blocked1",
				status: "queued",
				detail: "was processing-budget-exhausted; queued",
				shareUrl: "https://cap.test/s/blocked1",
			},
			{ input: "missing1", videoId: "missing1", status: "not-found" },
			{
				input: "verified1",
				videoId: "verified1",
				status: "not-retryable",
				detail: "verified",
			},
		]);
		expect(mocks.retry).toHaveBeenCalledTimes(3);
		expect(mocks.queue).toHaveBeenCalledTimes(1);
		expect(mocks.queue).toHaveBeenCalledWith({
			videoId: "blocked1",
			userId: "owner1",
		});
	});

	it("reports a failed workflow start instead of throwing", async () => {
		mocks.retry.mockResolvedValue({
			status: "queued",
			ownerId: "owner1",
			previousErrorCode: "source-invalid",
		});
		mocks.queue.mockRejectedValue(new Error("Workflow dispatch failed"));
		expect(await adminRetryBlockedRecordings("blocked1")).toEqual([
			{
				input: "blocked1",
				status: "failed",
				detail: "Workflow dispatch failed",
			},
		]);
	});
});
