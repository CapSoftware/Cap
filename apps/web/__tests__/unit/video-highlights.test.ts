import { describe, expect, it } from "vitest";
import {
	canManageHighlight,
	formatHighlightTime,
	HIGHLIGHT_LABEL_MAX_LENGTH,
	highlightDeepLink,
	highlightsAsText,
	normalizeHighlightLabel,
	normalizeHighlightTimestamp,
	sortHighlights,
} from "@/lib/video-highlights";

describe("normalizeHighlightLabel", () => {
	it("trims and collapses whitespace", () => {
		expect(normalizeHighlightLabel("  bug   in\n login ")).toBe("bug in login");
	});

	it("treats empty or missing labels as null", () => {
		expect(normalizeHighlightLabel("   ")).toBeNull();
		expect(normalizeHighlightLabel(null)).toBeNull();
		expect(normalizeHighlightLabel(undefined)).toBeNull();
	});

	it("caps the label length without splitting surrogate pairs", () => {
		const long = "🎯".repeat(HIGHLIGHT_LABEL_MAX_LENGTH + 10);
		const result = normalizeHighlightLabel(long);
		expect(Array.from(result ?? "")).toHaveLength(HIGHLIGHT_LABEL_MAX_LENGTH);
		expect(result?.endsWith("🎯")).toBe(true);
	});
});

describe("normalizeHighlightTimestamp", () => {
	it("rounds to a tenth of a second", () => {
		expect(normalizeHighlightTimestamp(12.345)).toBe(12.3);
	});

	it("rejects negative, non-finite and non-number values", () => {
		expect(normalizeHighlightTimestamp(-1)).toBeNull();
		expect(normalizeHighlightTimestamp(Number.NaN)).toBeNull();
		expect(normalizeHighlightTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
		expect(normalizeHighlightTimestamp("12")).toBeNull();
	});

	it("clamps to the known duration", () => {
		expect(normalizeHighlightTimestamp(999, 60.27)).toBe(60.2);
		expect(normalizeHighlightTimestamp(30, null)).toBe(30);
	});
});

describe("canManageHighlight", () => {
	const ids = { authorId: "author", ownerId: "owner" };

	it("allows the author and the video owner", () => {
		expect(canManageHighlight({ ...ids, viewerId: "author" })).toBe(true);
		expect(canManageHighlight({ ...ids, viewerId: "owner" })).toBe(true);
	});

	it("denies other and signed-out viewers", () => {
		expect(canManageHighlight({ ...ids, viewerId: "someone" })).toBe(false);
		expect(canManageHighlight({ ...ids, viewerId: null })).toBe(false);
	});
});

describe("sortHighlights", () => {
	it("orders by timestamp then id without mutating input", () => {
		const input = [
			{ id: "b", timestamp: 5 },
			{ id: "a", timestamp: 5 },
			{ id: "c", timestamp: 1 },
		];
		expect(sortHighlights(input).map((h) => h.id)).toEqual(["c", "a", "b"]);
		expect(input[0]?.id).toBe("b");
	});
});

describe("formatHighlightTime", () => {
	it("formats minutes and hours", () => {
		expect(formatHighlightTime(0)).toBe("0:00");
		expect(formatHighlightTime(129.9)).toBe("2:09");
		expect(formatHighlightTime(3725)).toBe("1:02:05");
	});
});

describe("highlightDeepLink", () => {
	it("sets whole-second t and keeps other params", () => {
		expect(
			highlightDeepLink("https://cap.example/s/abc?view=timeline#x", 129.9),
		).toBe("https://cap.example/s/abc?view=timeline&t=129");
	});

	it("replaces an existing t", () => {
		expect(highlightDeepLink("https://cap.example/s/abc?t=5", 10)).toBe(
			"https://cap.example/s/abc?t=10",
		);
	});
});

describe("highlightsAsText", () => {
	it("lists highlights in time order with links", () => {
		expect(
			highlightsAsText(
				[
					{ timestamp: 129, label: "Highlights feature" },
					{ timestamp: 3, label: null },
				],
				"https://cap.example/s/abc",
			),
		).toBe(
			"0:03 Highlight https://cap.example/s/abc?t=3\n2:09 Highlights feature https://cap.example/s/abc?t=129",
		);
	});
});
