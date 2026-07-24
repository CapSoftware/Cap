import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.fn();
const mockStart = vi.fn();

vi.mock("@cap/database", () => ({
	db: mockDb,
}));

vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		updatedAt: "videos.updatedAt",
	},
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ GROQ_API_KEY: "test-key" }),
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	})),
}));

vi.mock("workflow/api", () => ({
	start: mockStart,
}));

vi.mock("@/workflows/generate-ai", () => ({
	generateAiWorkflow: vi.fn(),
}));

function makeSelectChain(video: unknown) {
	const chain = {
		select: vi.fn(),
		from: vi.fn(),
		where: vi.fn(),
	};
	chain.select.mockReturnValue(chain);
	chain.from.mockReturnValue(chain);
	chain.where.mockResolvedValue([{ video }]);
	return chain;
}

function makeUpdateChain(affectedRows: number) {
	const chain = {
		update: vi.fn(),
		set: vi.fn(),
		where: vi.fn(),
	};
	chain.update.mockReturnValue(chain);
	chain.set.mockReturnValue(chain);
	chain.where.mockResolvedValue([{ affectedRows }]);
	return chain;
}

const video = {
	id: "video-1",
	transcriptionStatus: "COMPLETE",
	metadata: {},
	updatedAt: new Date("2026-07-20T15:00:00.000Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	mockStart.mockResolvedValue({ runId: "run-1" });
});

describe("startAiGeneration", () => {
	it("starts after atomically claiming the current video version", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain(video))
			.mockReturnValueOnce(makeUpdateChain(1));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI generation workflow started",
		});
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("does not start a duplicate after losing the optimistic claim", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain(video))
			.mockReturnValueOnce(makeUpdateChain(0));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI generation already in progress",
		});
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("marks only the queued generation as errored when start fails", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain(video))
			.mockReturnValueOnce(makeUpdateChain(1))
			.mockReturnValueOnce(makeUpdateChain(1));
		mockStart.mockRejectedValueOnce(new Error("workflow unavailable"));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: false,
			message: "Failed to start AI generation workflow",
		});
		expect(mockDb).toHaveBeenCalledTimes(3);
	});
});
