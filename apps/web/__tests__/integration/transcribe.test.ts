import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({
		DEEPGRAM_API_KEY: "test-deepgram-api-key",
		DATABASE_URL: "mysql://test@localhost/test",
	})),
}));

const mockStart = vi.hoisted(() => vi.fn());

vi.mock("workflow/api", () => ({
	start: mockStart,
}));

vi.mock("@/workflows/transcribe", () => ({
	transcribeVideoWorkflow: vi.fn(),
}));

let mockQueryResult: unknown[] = [];

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					leftJoin: () => ({
						where: vi
							.fn()
							.mockImplementation(() => Promise.resolve(mockQueryResult)),
					}),
				}),
			}),
		}),
		update: () => ({
			set: () => ({
				where: vi.fn().mockResolvedValue([]),
			}),
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", settings: "settings" },
	organizations: { id: "id", settings: "settings" },
	s3Buckets: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field, value) => ({ field, value })),
}));

import type { Video } from "@cap/web-domain";
import { transcribeVideo } from "@/lib/transcribe";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

describe("transcribeVideo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockQueryResult = [];
	});

	describe("input validation", () => {
		it("requires DEEPGRAM_API_KEY environment variable", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValueOnce({
				DEEPGRAM_API_KEY: undefined,
			} as ReturnType<typeof serverEnv>);

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toContain("environment variables");
		});

		it("rejects empty videoId", async () => {
			const result = await transcribeVideo("" as Video.VideoId, "user-456");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});

		it("rejects empty userId", async () => {
			const result = await transcribeVideo("video-123" as Video.VideoId, "");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});

		it("rejects when both videoId and userId are empty", async () => {
			const result = await transcribeVideo("" as Video.VideoId, "");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});
	});

	describe("video lookup", () => {
		it("returns error when video does not exist", async () => {
			mockQueryResult = [];

			const result = await transcribeVideo(
				"nonexistent-video" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe("Video does not exist");
		});

		it("returns error when video result is malformed", async () => {
			mockQueryResult = [
				{ video: null, bucket: null, settings: null, orgSettings: null },
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe("Video information is missing");
		});
	});

	describe("transcription disabled scenarios", () => {
		it("skips transcription when video settings disable it", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: { disableTranscript: true },
					},
					bucket: null,
					settings: { disableTranscript: true },
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("disabled");
			expect(mockStart).not.toHaveBeenCalled();
		});

		it("skips transcription when org settings disable it", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: null,
					},
					bucket: null,
					settings: null,
					orgSettings: { disableTranscript: true },
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("disabled");
		});

		it("video settings take precedence over org settings", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: { disableTranscript: false },
					},
					bucket: null,
					settings: { disableTranscript: false },
					orgSettings: { disableTranscript: true },
				},
			];
			mockStart.mockResolvedValue({ id: "run-123" });

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(mockStart).toHaveBeenCalled();
		});
	});

	describe("existing transcription status", () => {
		it("returns early when transcription is already complete", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: "COMPLETE",
						settings: null,
					},
					bucket: null,
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("already completed");
			expect(mockStart).not.toHaveBeenCalled();
		});

		it("returns early when transcription is in progress", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: "PROCESSING",
						settings: null,
					},
					bucket: null,
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("in progress");
			expect(mockStart).not.toHaveBeenCalled();
		});
	});

	describe("workflow triggering", () => {
		beforeEach(() => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: null,
					},
					bucket: { id: "bucket-456" },
					settings: null,
					orgSettings: null,
				},
			];
			mockStart.mockResolvedValue({ id: "workflow-run-123" });
		});

		it("triggers workflow for valid video", async () => {
			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toBe("Transcription workflow started");
			expect(mockStart).toHaveBeenCalledTimes(1);
		});

		it("passes correct payload to workflow", async () => {
			await transcribeVideo("video-123" as Video.VideoId, "user-456", true);

			expect(mockStart).toHaveBeenCalledWith(transcribeVideoWorkflow, [
				{
					videoId: "video-123",
					userId: "user-456",
					aiGenerationEnabled: true,
				},
			]);
		});

		it("defaults aiGenerationEnabled to false", async () => {
			await transcribeVideo("video-123" as Video.VideoId, "user-456");

			expect(mockStart).toHaveBeenCalledWith(transcribeVideoWorkflow, [
				{
					videoId: "video-123",
					userId: "user-456",
					aiGenerationEnabled: false,
				},
			]);
		});

		it("handles workflow trigger failure gracefully", async () => {
			mockStart.mockRejectedValue(new Error("Workflow service unavailable"));

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe("Failed to start transcription workflow");
		});
	});
});
