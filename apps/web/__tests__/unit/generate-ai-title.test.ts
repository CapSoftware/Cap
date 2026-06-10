import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({
	db: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {},
}));

vi.mock("@/lib/groq-client", () => ({
	GROQ_MODEL: "test-model",
	getGroqClient: vi.fn(() => null),
}));

vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("server-only", () => ({}));

import {
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
