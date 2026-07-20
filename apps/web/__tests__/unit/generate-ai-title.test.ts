import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({
	db: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {},
}));

vi.mock("@/lib/groq-client", () => ({
	GROQ_MODEL: "test-model",
	getGroqClient: vi.fn(() => null),
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: vi.fn(),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("server-only", () => ({}));

import {
	getAiContentGuidelines,
	getAiLanguageInstruction,
	shouldReplaceVideoTitle,
} from "@/workflows/generate-ai";

describe("shouldReplaceVideoTitle", () => {
	it("replaces default Cap titles", () => {
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Cap Recording - 15 May 2026",
				nextAiTitle: "Quarterly Roadmap Review",
			}),
		).toBe(true);
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Cap 2026-07-20 at 10.37.55",
				nextAiTitle: "Quarterly Roadmap Review",
			}),
		).toBe(true);
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Cap Upload - 15 May 2026",
				nextAiTitle: "Quarterly Roadmap Review",
			}),
		).toBe(true);
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Untitled",
				nextAiTitle: "Quarterly Roadmap Review",
			}),
		).toBe(true);
	});

	it("replaces a title that was previously set by AI", () => {
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Old Generated Title",
				previousAiTitle: "Old Generated Title",
				nextAiTitle: "New Generated Title",
			}),
		).toBe(true);
	});

	it("replaces source-derived desktop titles", () => {
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Acme App",
				sourceName: "Acme App",
				nextAiTitle: "Quarterly Roadmap Review",
			}),
		).toBe(true);
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Built-in Retina Display (Area) 2026-06-03 02:45 PM",
				nextAiTitle: "Quarterly Roadmap Review",
			}),
		).toBe(true);
	});

	it("preserves manual titles", () => {
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Customer Demo For Acme",
				previousAiTitle: "Old Generated Title",
				nextAiTitle: "New Generated Title",
			}),
		).toBe(false);
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Cap 2026 Roadmap",
				nextAiTitle: "New Generated Title",
			}),
		).toBe(false);
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Acme App",
				sourceName: "Acme App",
				nextAiTitle: "New Generated Title",
				titleManuallyEdited: true,
			}),
		).toBe(false);
	});

	it("does not replace with a blank generated title", () => {
		expect(
			shouldReplaceVideoTitle({
				currentTitle: "Cap Recording - 15 May 2026",
				nextAiTitle: "   ",
			}),
		).toBe(false);
	});
});

describe("getAiLanguageInstruction", () => {
	it("uses transcript language when auto-detect is selected", () => {
		expect(getAiLanguageInstruction("auto")).toContain(
			"same language as the transcript",
		);
	});

	it("uses the selected language name", () => {
		expect(getAiLanguageInstruction("es")).toContain("Spanish");
	});
});

describe("getAiContentGuidelines", () => {
	it("prioritizes subject, intention, and standalone understanding", () => {
		const { summary } = getAiContentGuidelines(114);

		expect(summary).toContain("understand the video without watching it");
		expect(summary).toContain("subject and the speaker's intention first");
		expect(summary).toContain(
			"outcomes, decisions, action items, and next steps",
		);
		expect(summary).toContain("meaning and useful information");
		expect(summary).toContain("minor UI actions");
		expect(summary).toContain("never omit information required");
		expect(summary).toContain("rather than enumerating every utterance");
	});

	it("scales summary length without padding", () => {
		expect(getAiContentGuidelines(20).summary).toContain(
			"no more than 35 words",
		);
		expect(getAiContentGuidelines(114).summary).toContain("50-90 words");
		expect(getAiContentGuidelines(300).summary).toContain("80-150 words");
		expect(getAiContentGuidelines(1200).summary).toContain("150-250 words");
		expect(getAiContentGuidelines(3600).summary).toContain("250-400 words");
		expect(getAiContentGuidelines(114).summary).toContain(
			"Do not pad the summary",
		);
	});

	it("omits chapters for videos shorter than two minutes", () => {
		expect(getAiContentGuidelines(119).chapters).toContain(
			'empty "chapters" array',
		);
		expect(getAiContentGuidelines(120).chapters).toContain(
			"fewest chapters needed",
		);
	});
});
