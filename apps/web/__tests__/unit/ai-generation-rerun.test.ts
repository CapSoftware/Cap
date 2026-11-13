import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => true }));
vi.mock("@/workflows/generate-ai", () => ({ generateAiWorkflow: vi.fn() }));

import { chargesProcessingRerun, isAiGenerationRerun } from "@/lib/generate-ai";

const legacySummary =
	"The AI was unable to generate a proper summary for this content.";

describe("AI generation rerun", () => {
	it("treats a video that never ran AI generation as a first run", () => {
		expect(isAiGenerationRerun({})).toBe(false);
	});

	it("does not count work that is already queued or running", () => {
		expect(isAiGenerationRerun({ aiGenerationStatus: "QUEUED" })).toBe(false);
		expect(isAiGenerationRerun({ aiGenerationStatus: "PROCESSING" })).toBe(
			false,
		);
	});

	it("does not count a finished result, which generation leaves alone", () => {
		expect(
			isAiGenerationRerun({
				aiGenerationStatus: "COMPLETE",
				summary: "A summary",
				chapters: [{ title: "Intro", start: 0 }],
			}),
		).toBe(false);
	});

	it("counts every state that starts generation again", () => {
		expect(isAiGenerationRerun({ aiGenerationStatus: "ERROR" })).toBe(true);
		expect(isAiGenerationRerun({ aiGenerationStatus: "SKIPPED" })).toBe(true);
		expect(
			isAiGenerationRerun({
				aiGenerationStatus: "COMPLETE",
				summary: legacySummary,
				chapters: [{ title: "Intro", start: 0 }],
			}),
		).toBe(true);
		expect(
			isAiGenerationRerun({
				aiGenerationStatus: "COMPLETE",
				summary: "A summary",
			}),
		).toBe(true);
	});
});

describe("agent processing rerun charge", () => {
	const complete = {
		aiGenerationStatus: "COMPLETE" as const,
		summary: "A summary",
		chapters: [{ title: "Intro", start: 0 }],
	};

	it("does not charge first-time processing", () => {
		for (const target of ["all", "transcript", "ai"] as const) {
			expect(
				chargesProcessingRerun({
					target,
					retry: undefined,
					transcriptionStatus: target === "ai" ? "COMPLETE" : null,
					metadata: {},
				}),
			).toBe(false);
		}
		expect(
			chargesProcessingRerun({
				target: "ai",
				retry: true,
				transcriptionStatus: "COMPLETE",
				metadata: complete,
			}),
		).toBe(false);
	});

	it("charges a transcript retry after a failure", () => {
		for (const target of ["all", "transcript"] as const) {
			expect(
				chargesProcessingRerun({
					target,
					retry: true,
					transcriptionStatus: "ERROR",
					metadata: {},
				}),
			).toBe(true);
		}
		expect(
			chargesProcessingRerun({
				target: "transcript",
				retry: undefined,
				transcriptionStatus: "ERROR",
				metadata: {},
			}),
		).toBe(false);
	});

	it("charges an AI retry after a failure or skip", () => {
		for (const aiGenerationStatus of ["ERROR", "SKIPPED"] as const) {
			for (const target of ["all", "ai"] as const) {
				expect(
					chargesProcessingRerun({
						target,
						retry: true,
						transcriptionStatus: "COMPLETE",
						metadata: { aiGenerationStatus },
					}),
				).toBe(true);
			}
		}
	});

	it("does not charge a request the mutation refuses as a conflict", () => {
		for (const aiGenerationStatus of ["ERROR", "SKIPPED"] as const) {
			expect(
				chargesProcessingRerun({
					target: "ai",
					retry: undefined,
					transcriptionStatus: "COMPLETE",
					metadata: { aiGenerationStatus },
				}),
			).toBe(false);
		}
	});

	it("charges a rerun of an incomplete result even without retry", () => {
		expect(
			chargesProcessingRerun({
				target: "ai",
				retry: undefined,
				transcriptionStatus: "COMPLETE",
				metadata: { aiGenerationStatus: "COMPLETE", summary: "A summary" },
			}),
		).toBe(true);
	});

	it("does not charge AI work that waits on transcription", () => {
		expect(
			chargesProcessingRerun({
				target: "all",
				retry: true,
				transcriptionStatus: "PROCESSING",
				metadata: { aiGenerationStatus: "ERROR" },
			}),
		).toBe(false);
	});
});
