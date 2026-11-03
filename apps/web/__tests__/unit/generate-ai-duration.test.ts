import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, generateTextMock, runWorkflowPromiseMock } = vi.hoisted(() => ({
	dbMock: vi.fn(),
	generateTextMock: vi.fn(),
	runWorkflowPromiseMock: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: dbMock }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend/src/Storage/index", () => ({ Storage: {} }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: runWorkflowPromiseMock,
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));
vi.mock("workflow", () => ({ FatalError: class FatalError extends Error {} }));
vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => true,
	getAiProviderChain: () => [
		{ model: () => ({}), defaultMaxOutputTokens: 8000 },
	],
}));

import { generateAiWorkflow } from "@/workflows/generate-ai";

beforeEach(() => {
	vi.clearAllMocks();
});

async function generate(
	duration: number | null,
	chapters: { title: string; start: number }[],
	multiChunk: boolean,
	lastCueEnd = "00:05:01.500",
) {
	const video = {
		name: "Customer demo",
		transcriptionStatus: "COMPLETE",
		metadata: {},
		duration,
	};
	const select = {
		from: vi.fn().mockReturnThis(),
		leftJoin: vi.fn().mockReturnThis(),
		where: vi
			.fn()
			.mockResolvedValueOnce([{ video }])
			.mockResolvedValueOnce([video]),
	};
	const update = {
		set: vi.fn().mockReturnThis(),
		where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
	};
	dbMock.mockReturnValue({
		select: () => select,
		update: () => update,
	});
	runWorkflowPromiseMock.mockResolvedValue(
		Option.some(
			`WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${multiChunk ? "a".repeat(24000) : "I explain the demo."}\n\n00:05:00.000 --> ${lastCueEnd}\nI finish the demonstration.\n`,
		),
	);
	generateTextMock.mockResolvedValue({
		text: JSON.stringify({
			title: "Demo review",
			summary: "I explain the demo and next steps.",
			chapters,
		}),
	});

	await expect(
		generateAiWorkflow({ videoId: "video-1", userId: "user-1" }),
	).resolves.toMatchObject({ success: true });
	expect(generateTextMock).toHaveBeenCalledTimes(multiChunk ? 3 : 1);

	const savedMetadata = update.set.mock.lastCall?.[0].metadata;
	return new MySqlDialect().sqlToQuery(savedMetadata).params;
}

describe.each([false, true])("AI duration with multiChunk=%s", (multiChunk) => {
	it.each([301.5, 302])(
		"rejects a chapter at %s for a video ending at 301.5 seconds",
		async (start) => {
			const chapters = [
				{ title: "Introduction", start: 0 },
				{ title: "Outside the video", start },
			];
			const params = await generate(301.5, chapters, multiChunk);

			expect(params).toContain(JSON.stringify(chapters.slice(0, 1)));
			expect(generateTextMock.mock.calls[0]?.[0].prompt).toContain(
				"301.5 seconds long",
			);
		},
	);

	it("keeps chapters beyond the transcript-based duration estimate", async () => {
		const chapters = [
			{ title: "Introduction", start: 0 },
			{ title: "Wrap up", start: 330 },
		];
		const params = await generate(360, chapters, multiChunk, "00:06:00.000");

		expect(params).toContain(JSON.stringify(chapters));
		expect(generateTextMock.mock.calls[0]?.[0].prompt).toContain(
			"360 seconds long",
		);
	});

	it.each([null, 0])(
		"keeps the transcript estimate when stored duration is %s",
		async (duration) => {
			const chapters = [
				{ title: "Introduction", start: 0 },
				{ title: "Wrap up", start: 300 },
			];
			const params = await generate(duration, chapters, multiChunk);

			expect(params).toContain(JSON.stringify(chapters));
			expect(generateTextMock.mock.calls[0]?.[0].prompt).toContain(
				"303 seconds long",
			);
		},
	);
});
