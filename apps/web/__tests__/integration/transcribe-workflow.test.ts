import { beforeEach, describe, expect, it, vi } from "vitest";
import { assemblyAIEditResponse } from "../fixtures/assemblyai-edit-response";

const mocks = vi.hoisted(() => ({
	transcribe: vi.fn(),
	putObject: vi.fn(),
	deleteObject: vi.fn(),
	getInternalSignedObjectUrl: vi.fn(),
	startAiGeneration: vi.fn(),
	updates: [] as Record<string, unknown>[],
}));

const schemaMocks = vi.hoisted(() => ({
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		updatedAt: "videos.updatedAt",
	},
	organizations: { id: "organizations.id" },
	videoUploads: { videoId: "videoUploads.videoId" },
	videoEdits: {
		videoId: "videoEdits.videoId",
		editSpec: "videoEdits.editSpec",
	},
}));

const videoRow = vi.hoisted(() => ({
	id: "video-123",
	ownerId: "user-456",
	duration: 4,
	settings: null,
	source: { type: "webMP4" },
	isScreenshot: false,
	transcriptionStatus: "COMPLETE",
	updatedAt: new Date("2026-07-30T00:00:00.000Z"),
	metadata: {
		editTranscriptBackfill: {
			status: "processing",
			requestId: "request-1",
			requestedAt: "2026-07-30T00:00:00.000Z",
		},
	},
}));

const state = vi.hoisted(() => ({ editRows: [] as unknown[] }));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: "test-assembly-api-key",
		NEXTAUTH_SECRET: "test-secret-with-enough-entropy",
	}),
}));

vi.mock("@cap/database/schema", () => schemaMocks);

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const query = {
				from: (table: unknown) => {
					if (table === schemaMocks.videoUploads) {
						return {
							where: () => ({ limit: async () => [] }),
						};
					}
					if (table === schemaMocks.videoEdits) {
						return { where: async () => state.editRows };
					}
					return {
						leftJoin: () => ({
							where: async () => [{ video: videoRow, orgSettings: null }],
						}),
						where: async () => [videoRow],
					};
				},
			};
			return query;
		},
		update: () => ({
			set: (values: Record<string, unknown>) => {
				mocks.updates.push(values);
				return { where: async () => [{ affectedRows: 1 }] };
			},
		}),
	}),
}));

vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => ({ conditions }),
	eq: (field: unknown, value: unknown) => ({ field, value }),
	isNull: (field: unknown) => ({ isNull: field }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	}),
}));

vi.mock("server-only", () => ({}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("workflow/api", () => ({
	start: vi.fn(),
}));

vi.mock("assemblyai", () => ({
	AssemblyAI: class {
		transcripts = { transcribe: mocks.transcribe };
	},
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () => ({
			pipe: (runner: (value: unknown) => unknown) =>
				runner([
					{
						putObject: mocks.putObject,
						deleteObject: mocks.deleteObject,
						getInternalSignedObjectUrl: mocks.getInternalSignedObjectUrl,
					},
				]),
		}),
	},
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (value: unknown) => Promise.resolve(value),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => true,
	probeVideoViaMediaServer: async () => ({
		audioCodec: "aac",
		videoCodec: "h264",
		duration: 4,
		audioChannels: 2,
		sampleRate: 48_000,
	}),
	extractAudioViaMediaServer: async () => Buffer.from("audio"),
	checkHasAudioTrackViaMediaServer: async () => true,
}));

vi.mock("@/lib/audio-extract", () => ({
	checkHasAudioTrack: async () => true,
	extractAudioFromUrl: async () => ({
		filePath: "/tmp/audio.mp3",
		cleanup: async () => {},
	}),
}));

vi.mock("@/lib/audio-enhance", () => ({
	ENHANCED_AUDIO_CONTENT_TYPE: "audio/mpeg",
	ENHANCED_AUDIO_EXTENSION: "mp3",
	enhanceAudioFromUrl: async () => Buffer.from(""),
}));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: mocks.startAiGeneration,
}));

function pipeValue(value: unknown) {
	return { pipe: (runner: (input: unknown) => unknown) => runner(value) };
}

describe("transcribeVideoWorkflow", () => {
	beforeEach(() => {
		mocks.updates.length = 0;
		state.editRows = [];
		mocks.transcribe.mockResolvedValue({
			...assemblyAIEditResponse,
			audio_duration: 4,
		});
		mocks.putObject.mockImplementation(() => pipeValue(undefined));
		mocks.deleteObject.mockImplementation(() => pipeValue(undefined));
		mocks.getInternalSignedObjectUrl.mockImplementation(() =>
			pipeValue("https://storage.test/object"),
		);
		mocks.startAiGeneration.mockResolvedValue({ success: true, message: "ok" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				arrayBuffer: async () => new ArrayBuffer(8),
			})),
		);
	});

	it("persists captions and the word transcript from a single paid pass", async () => {
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");

		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});

		expect(result.success).toBe(true);
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);
		expect(mocks.transcribe.mock.calls[0]?.[0]).toMatchObject({
			disfluencies: true,
			speech_models: ["universal-3-5-pro", "universal-2"],
		});

		const writes = new Map(
			mocks.putObject.mock.calls.map((call) => [call[0] as string, call[1]]),
		);
		expect(
			[...writes.keys()].filter((key) => key.includes("transcription")),
		).toEqual([
			"user-456/video-123/transcription.vtt",
			"user-456/video-123/transcription.edit.v3.json",
		]);

		const vtt = writes.get("user-456/video-123/transcription.vtt") as string;
		expect(vtt.startsWith("WEBVTT")).toBe(true);
		expect(vtt).toContain("this is a real example.");
		expect(vtt).not.toContain("Um,");

		const { parseEditTranscript } = await import("@/lib/edit-transcript");
		const { decryptEditTranscriptObject } = await import(
			"@/lib/edit-transcript-storage"
		);
		const encrypted = writes.get(
			"user-456/video-123/transcription.edit.v3.json",
		) as string;
		expect(encrypted).not.toContain("this is a real example");
		const stored = parseEditTranscript(
			decryptEditTranscriptObject(encrypted, "user-456", "video-123") ?? "",
		);
		expect(stored).toMatchObject({ version: 3, durationMs: 4_000 });
		// verbatim: fillers stay in the stored words even though captions drop them
		expect(stored?.words.map((word) => word.text)).toContain("Um,");
		expect(stored?.words).toHaveLength(9);

		expect(mocks.updates.at(-1)).toEqual({ transcriptionStatus: "COMPLETE" });
	});

	it("marks audio without speech as skipped without retrying transcription", async () => {
		mocks.transcribe.mockResolvedValueOnce({
			id: "silent-transcript",
			status: "error",
			error:
				"language_detection cannot be performed on files with no spoken audio.",
		});

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: true,
		});

		expect(result).toEqual({
			success: true,
			message: "Video has no spoken audio - skipped transcription",
		});
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);
		expect(mocks.updates).toContainEqual({ transcriptionStatus: "NO_AUDIO" });
		expect(mocks.updates).not.toContainEqual({ transcriptionStatus: "ERROR" });
		expect(mocks.startAiGeneration).not.toHaveBeenCalled();
	});

	it("preserves transcription failures unrelated to missing speech", async () => {
		mocks.transcribe.mockResolvedValueOnce({
			id: "failed-transcript",
			status: "error",
			error: "Audio could not be decoded",
		});

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");

		await expect(
			transcribeVideoWorkflow({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			}),
		).rejects.toThrow("Audio could not be decoded");
		expect(mocks.updates).toContainEqual({ transcriptionStatus: "ERROR" });
		expect(mocks.updates).not.toContainEqual({
			transcriptionStatus: "NO_AUDIO",
		});
	});

	it("never overwrites the original-timeline transcript of an edited video", async () => {
		state.editRows = [
			{
				sourceKey: "user-456/video-123/original.mp4",
				editSpec: {
					version: 1,
					sourceDuration: 12,
					keepRanges: [{ start: 0, end: 4 }],
				},
			},
		];

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});

		const writtenKeys = mocks.putObject.mock.calls.map((call) => call[0]);
		expect(writtenKeys).toContain("user-456/video-123/transcription.vtt");
		expect(writtenKeys).not.toContain(
			"user-456/video-123/transcription.edit.v3.json",
		);
	});
});

describe("backfillEditTranscriptWorkflow", () => {
	beforeEach(() => {
		state.editRows = [];
		videoRow.metadata = {
			editTranscriptBackfill: {
				status: "processing",
				requestId: "request-1",
				requestedAt: "2026-07-30T00:00:00.000Z",
			},
		};
		mocks.transcribe.mockResolvedValue({
			...assemblyAIEditResponse,
			audio_duration: 4,
		});
		mocks.putObject.mockImplementation(() => pipeValue(undefined));
		mocks.deleteObject.mockImplementation(() => pipeValue(undefined));
		mocks.getInternalSignedObjectUrl.mockImplementation(() =>
			pipeValue("https://storage.test/object"),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				arrayBuffer: async () => new ArrayBuffer(8),
			})),
		);
	});

	it("transcribes the original media in the original timeline when edits exist", async () => {
		state.editRows = [
			{
				sourceKey: "user-456/video-123/original.mp4",
				editSpec: {
					version: 1,
					sourceDuration: 12,
					keepRanges: [{ start: 0, end: 4 }],
				},
			},
		];

		const { backfillEditTranscriptWorkflow } = await import(
			"@/workflows/transcribe"
		);
		const result = await backfillEditTranscriptWorkflow({
			videoId: "video-123",
			userId: "user-456",
			requestId: "request-1",
		});

		expect(result.success).toBe(true);
		expect(mocks.getInternalSignedObjectUrl.mock.calls[0]?.[0]).toBe(
			"user-456/video-123/original.mp4",
		);

		const { parseEditTranscript } = await import("@/lib/edit-transcript");
		const { decryptEditTranscriptObject } = await import(
			"@/lib/edit-transcript-storage"
		);
		const write = mocks.putObject.mock.calls.find(
			(call) => call[0] === "user-456/video-123/transcription.edit.v3.json",
		);
		const decrypted = decryptEditTranscriptObject(
			write?.[1] as string,
			"user-456",
			"video-123",
		);
		expect(parseEditTranscript(decrypted ?? "")).toMatchObject({
			durationMs: 12_000,
		});
		expect(mocks.deleteObject).not.toHaveBeenCalledWith(
			"user-456/video-123/transcription.edit.v3.status.json",
		);
	});

	it("does not run a backfill after its database claim is replaced", async () => {
		const { backfillEditTranscriptWorkflow } = await import(
			"@/workflows/transcribe"
		);
		const result = await backfillEditTranscriptWorkflow({
			videoId: "video-123",
			userId: "user-456",
			requestId: "expired-request",
		});

		expect(result.success).toBe(false);
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.putObject).not.toHaveBeenCalledWith(
			"user-456/video-123/transcription.edit.v3.json",
			expect.anything(),
			expect.anything(),
		);
	});
});
