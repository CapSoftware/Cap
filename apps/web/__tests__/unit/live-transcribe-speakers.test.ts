import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	speakerLabels: false,
	video: {
		id: "video-123",
		ownerId: "user-456",
		transcriptionStatus: null as string | null,
	},
	transcribeVideo: vi.fn(),
	getAccessForVideo: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ ASSEMBLY_SPEAKER_LABELS: mocks.speakerLabels }),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "video.id", transcriptionStatus: "video.transcriptionStatus" },
	users: { id: "user.id" },
	videoEdits: {},
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: async () => [mocks.video] }),
		}),
		update: mocks.update,
	}),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.getAccessForVideo },
}));
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: mocks.transcribeVideo,
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => false,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (value: unknown) => Promise.resolve(value),
}));
vi.mock("@/lib/edit-transcript-storage", () => ({
	encryptEditTranscriptObject: vi.fn(),
}));

import { promoteLiveTranscript } from "@/lib/live-transcribe-runner";

describe("live transcript speaker diarization", () => {
	beforeEach(() => {
		mocks.speakerLabels = false;
		mocks.video.transcriptionStatus = null;
		mocks.transcribeVideo.mockResolvedValue({ success: true });
		mocks.getAccessForVideo.mockImplementation(() => {
			throw new Error("promotion storage reached");
		});
	});

	it("uses a full final pass instead of promoting unlabeled chunks when opted in", async () => {
		mocks.speakerLabels = true;
		expect(await promoteLiveTranscript("video-123", "user-456")).toEqual({
			promoted: false,
			reason: "speaker diarization requires a full transcription pass",
		});
		expect(mocks.transcribeVideo).toHaveBeenCalledExactlyOnceWith(
			"video-123",
			"user-456",
			false,
			{ earlyFromSegments: true },
		);
		expect(mocks.getAccessForVideo).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("preserves the existing promotion path when diarization is disabled", async () => {
		expect(await promoteLiveTranscript("video-123", "user-456")).toEqual({
			promoted: false,
			reason: "promotion storage reached",
		});
		expect(mocks.getAccessForVideo).toHaveBeenCalledOnce();
		expect(mocks.transcribeVideo).not.toHaveBeenCalled();
	});

	it("does not queue another paid pass after canonical completion", async () => {
		mocks.speakerLabels = true;
		mocks.video.transcriptionStatus = "COMPLETE";
		expect(await promoteLiveTranscript("video-123", "user-456")).toEqual({
			promoted: false,
			reason: "canonical status is COMPLETE",
		});
		expect(mocks.transcribeVideo).not.toHaveBeenCalled();
	});

	it("does not queue a paid pass for a different owner", async () => {
		mocks.speakerLabels = true;
		expect(await promoteLiveTranscript("video-123", "other-user")).toEqual({
			promoted: false,
			reason: "video not found",
		});
		expect(mocks.transcribeVideo).not.toHaveBeenCalled();
	});
});
