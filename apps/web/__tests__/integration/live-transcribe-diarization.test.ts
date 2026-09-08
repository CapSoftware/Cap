import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyLiveTranscript } from "@/lib/live-transcribe-core";

const mocks = vi.hoisted(() => ({
	queue: vi.fn(),
	objects: new Map<string, string>(),
	writes: [] as string[],
}));
const video = {
	id: "live-video",
	ownerId: "live-owner",
	source: { type: "desktopSegments" },
	transcriptionStatus: null,
	settings: null,
};
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ ASSEMBLY_API_KEY: "test-key" }),
}));
vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "video-id",
		ownerId: "owner-id",
		metadata: "metadata",
		updatedAt: "updated-at",
	},
	organizations: { id: "org-id", settings: "settings" },
	users: { id: "user-id" },
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({ where: async () => [{ video, orgSettings: null }] }),
				where: async () => [video],
			}),
		}),
		update: () => ({ set: () => ({ where: async () => [] }) }),
	}),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getObject: (key: string) =>
						Effect.succeed(Option.fromNullable(mocks.objects.get(key))),
					putObject: (key: string, value: string) =>
						Effect.sync(() => {
							mocks.writes.push(key);
							mocks.objects.set(key, value);
						}),
				},
			]),
	},
}));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: () => ({}) }));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: mocks.queue }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => false,
}));

const artifactKey = "live-owner/live-video/transcription.live.json";
beforeEach(() => {
	mocks.objects.clear();
	mocks.writes.length = 0;
	mocks.queue.mockResolvedValue({ success: true, message: "Queued" });
	mocks.objects.set(
		artifactKey,
		JSON.stringify({
			...createEmptyLiveTranscript("2026-09-08T00:00:00.000Z"),
			lastAudioSegmentIndex: 2,
			transcribedDurationMs: 4000,
		}),
	);
	mocks.objects.set(
		"live-owner/live-video/segments/manifest.json",
		JSON.stringify({
			version: 5,
			video_init_uploaded: true,
			audio_init_uploaded: true,
			video_segments: [],
			audio_segments: [
				{ index: 1, duration: 2 },
				{ index: 2, duration: 2 },
			],
			is_complete: true,
		}),
	);
});

describe("live recording diarization handoff", () => {
	it("queues a full recording pass even when provisional chunks cover every segment", async () => {
		const { liveTranscribeWorkflow } = await import(
			"@/workflows/live-transcribe"
		);
		await liveTranscribeWorkflow({ videoId: video.id, userId: video.ownerId });
		expect(mocks.queue).toHaveBeenCalledExactlyOnceWith(
			video.id,
			video.ownerId,
			false,
			{ earlyFromSegments: true },
		);
		expect(mocks.writes).toEqual([artifactKey]);
		expect(JSON.parse(mocks.objects.get(artifactKey) ?? "{}").state).toBe(
			"complete",
		);
	});
	it("surfaces queue failures so the durable workflow retries the final transcription", async () => {
		mocks.queue.mockResolvedValue({
			success: false,
			message: "Queue unavailable",
		});
		const { liveTranscribeWorkflow } = await import(
			"@/workflows/live-transcribe"
		);
		await expect(
			liveTranscribeWorkflow({ videoId: video.id, userId: video.ownerId }),
		).rejects.toThrow("Queue unavailable");
	});
});
