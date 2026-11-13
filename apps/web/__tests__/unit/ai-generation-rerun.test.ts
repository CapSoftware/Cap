import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => true }));
vi.mock("@/workflows/generate-ai", () => ({ generateAiWorkflow: vi.fn() }));

import { isAiGenerationRerun } from "@/lib/generate-ai";

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
