import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	generateText: vi.fn(),
	runWorkflowPromise: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend/src/Storage/index", () => ({ Storage: {} }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: mocks.runWorkflowPromise,
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));
vi.mock("workflow", () => ({ FatalError: class FatalError extends Error {} }));
vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({
	generateText: mocks.generateText,
	APICallError: { isInstance: () => false },
}));
vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => true,
	getAiProviderChain: () =>
		["groq", "openai"].map((provider) => ({
			provider,
			modelId: `${provider}-model`,
			model: () => ({}),
			defaultMaxOutputTokens: 8000,
		})),
}));

import { generateAiWorkflow } from "@/workflows/generate-ai";

const section = {
	summary: "I explain the release checklist.",
	keyPoints: ["Run the tests before releasing."],
	chapters: [{ title: "Release checklist", start: 300 }],
};
const final = {
	title: "Release plan",
	summary: "I review the release checklist and testing requirements.",
};

describe("long-video AI generation", () => {
	const update = {
		set: vi.fn(),
		where: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.generateText.mockReset();
		update.set.mockReturnValue(update);
		update.where.mockResolvedValue([{ affectedRows: 1 }]);
		const video = {
			name: "Customer demo",
			transcriptionStatus: "COMPLETE",
			metadata: {},
			duration: 600,
		};
		const select = {
			from: vi.fn().mockReturnThis(),
			leftJoin: vi.fn().mockReturnThis(),
			where: vi
				.fn()
				.mockResolvedValueOnce([{ video }])
				.mockResolvedValueOnce([video]),
		};
		mocks.db.mockReturnValue({
			select: () => select,
			update: () => update,
		});
		mocks.runWorkflowPromise.mockResolvedValue(
			Option.some(
				`WEBVTT\n\n00:00:00.000 --> 00:05:00.000\n${"a".repeat(24000)}\n\n00:05:00.000 --> 00:10:00.000\nI explain the release checklist.\n`,
			),
		);
	});

	it.each(["invalid JSON", JSON.stringify(final)])(
		"fails before final synthesis when every section fails, even if the final response would be %s",
		async (finalResponse) => {
			mocks.generateText
				.mockResolvedValueOnce({ text: "invalid JSON" })
				.mockResolvedValueOnce({ text: "invalid JSON" })
				.mockResolvedValueOnce({ text: "invalid JSON" })
				.mockResolvedValueOnce({ text: "invalid JSON" })
				.mockResolvedValue({ text: finalResponse });

			await expect(
				generateAiWorkflow({ videoId: "video-1", userId: "user-1" }),
			).rejects.toThrow("No valid section analyses");
			expect(mocks.generateText).toHaveBeenCalledTimes(4);
			expect(update.set).toHaveBeenCalledTimes(2);
			const saved = update.set.mock.lastCall?.[0].metadata;
			expect(new MySqlDialect().sqlToQuery(saved).sql).toContain(
				"'$.aiGenerationStatus', 'ERROR'",
			);
		},
	);

	it("keeps the section fallback when at least one section succeeded", async () => {
		mocks.generateText
			.mockResolvedValueOnce({ text: "invalid JSON" })
			.mockResolvedValueOnce({ text: "invalid JSON" })
			.mockResolvedValueOnce({ text: JSON.stringify(section) })
			.mockResolvedValue({ text: "invalid JSON" });

		await expect(
			generateAiWorkflow({ videoId: "video-1", userId: "user-1" }),
		).resolves.toMatchObject({ success: true });
		expect(mocks.generateText).toHaveBeenCalledTimes(5);
		const saved = new MySqlDialect().sqlToQuery(
			update.set.mock.lastCall?.[0].metadata,
		);
		expect(saved.sql).toContain("'$.aiGenerationStatus', 'COMPLETE'");
		expect(saved.params).toContain(
			JSON.stringify(
				`**Part 1:** ${section.summary}\n\n**Key Points:**\n- ${section.keyPoints[0]}`,
			),
		);
	});

	it("synthesizes the successful section analyses", async () => {
		mocks.generateText
			.mockResolvedValueOnce({ text: JSON.stringify(section) })
			.mockResolvedValueOnce({ text: JSON.stringify(section) })
			.mockResolvedValue({ text: JSON.stringify(final) });

		await expect(
			generateAiWorkflow({ videoId: "video-1", userId: "user-1" }),
		).resolves.toMatchObject({ success: true });
		expect(mocks.generateText).toHaveBeenCalledTimes(3);
		expect(mocks.generateText.mock.lastCall?.[0].prompt).toContain(
			section.summary,
		);
		const saved = new MySqlDialect().sqlToQuery(
			update.set.mock.lastCall?.[0].metadata,
		);
		expect(saved.params).toContain(JSON.stringify(final.summary));
	});
});
