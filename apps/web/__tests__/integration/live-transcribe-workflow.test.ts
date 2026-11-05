import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyChunkToLiveTranscript,
	createEmptyLiveTranscript,
	liveTranscriptToEditTranscript,
	offsetChunkWords,
} from "@/lib/live-transcribe-core";
import type { writeLiveChunk } from "@/lib/live-transcribe-runner";

const mocks = vi.hoisted(() => ({
	transcribe: vi.fn(),
	getObject: vi.fn(),
	writeLiveChunk: vi.fn(),
	promoteLiveTranscript: vi.fn(),
}));

const video = vi.hoisted(() => ({
	id: "video-123",
	ownerId: "user-456",
	source: { type: "desktopSegments" },
	transcriptionStatus: null,
	settings: null,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: async () => [{ video, orgSettings: null }],
				}),
				where: async () => [video],
			}),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", orgId: "orgId" },
	organizations: { id: "id", settings: "settings" },
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ ASSEMBLY_API_KEY: "test-key" }),
}));
vi.mock("assemblyai", () => ({
	AssemblyAI: class {
		transcripts = { transcribe: mocks.transcribe };
	},
}));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	return {
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{
						getObject: mocks.getObject,
						getInternalSignedObjectUrl: (key: string) =>
							Effect.succeed(`https://storage.test/${key}`),
					},
				]),
		},
	};
});
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("@/lib/workflow-runtime", async () => {
	const { Effect } = await import("effect");
	return { runWorkflowPromise: Effect.runPromise };
});
vi.mock("@/lib/segments-audio-download", () => ({
	downloadConcatenatedSegmentsToBuffer: async () => Buffer.from("audio"),
}));
vi.mock("@/lib/live-transcribe-runner", () => ({
	finishLiveTranscription: vi.fn(),
	liveContextSeconds: () => 0,
	promoteLiveTranscript: mocks.promoteLiveTranscript,
	writeLiveChunk: mocks.writeLiveChunk,
	writeLiveChunkGap: vi.fn(),
}));

import { liveTranscribeWorkflow } from "@/workflows/live-transcribe";

let artifact = createEmptyLiveTranscript("2026-08-03T00:00:00.000Z");

beforeEach(() => {
	artifact = createEmptyLiveTranscript("2026-08-03T00:00:00.000Z");
	mocks.transcribe.mockReset();
	mocks.promoteLiveTranscript.mockResolvedValue({ promoted: true });
	mocks.getObject.mockImplementation((key: string) =>
		Effect.succeed(
			key.endsWith("manifest.json")
				? Option.some(
						JSON.stringify({
							version: 5,
							video_init_uploaded: true,
							audio_init_uploaded: true,
							video_segments: [],
							audio_segments: Array.from({ length: 90 }, (_, index) => ({
								index: index + 1,
								duration: 2,
							})),
							is_complete: true,
						}),
					)
				: Option.none(),
		),
	);
	mocks.writeLiveChunk.mockImplementation(
		async (options: Parameters<typeof writeLiveChunk>[0]) => {
			artifact = applyChunkToLiveTranscript(artifact, {
				...options.chunk,
				words: offsetChunkWords(
					options.words,
					options.chunk.startMs,
					options.chunk.durationMs,
					options.chunk.contextMs,
				),
				languageCode: options.languageCode,
				nowIso: "2026-08-03T00:03:00.000Z",
			});
			return { status: "written", artifact };
		},
	);
});

describe("live transcription language detection", () => {
	it.each(["en", "en_us"])(
		"ignores the provider's %s language on a no-speech error",
		async (languageCode) => {
			mocks.transcribe
				.mockResolvedValueOnce({
					status: "error",
					error:
						"language_detection cannot be performed on files with no spoken audio.",
					words: null,
					language_code: languageCode,
				})
				.mockResolvedValue({
					status: "completed",
					words: [{ text: "Hallo", start: 100, end: 1000 }],
					language_code: "de",
				});

			expect(
				await liveTranscribeWorkflow({
					videoId: video.id,
					userId: video.ownerId,
				}),
			).toMatchObject({ success: true });

			expect(mocks.transcribe).toHaveBeenCalledTimes(3);
			expect.soft(mocks.writeLiveChunk.mock.calls[0]?.[0]).toMatchObject({
				words: [],
				languageCode: null,
			});
			expect.soft(mocks.transcribe.mock.calls[1]?.[0]).toMatchObject({
				language_detection: true,
			});
			expect.soft(mocks.transcribe.mock.calls[2]?.[0]).toMatchObject({
				language_code: "de",
			});
			expect.soft(artifact.languageCode).toBe("de");
			expect
				.soft(
					liveTranscriptToEditTranscript(artifact, "universal-3-5-pro")
						.languageCode,
				)
				.toBe("de");
			expect(artifact.transcribedDurationMs).toBe(180_000);
			expect(mocks.promoteLiveTranscript).toHaveBeenCalledOnce();
		},
	);
});
