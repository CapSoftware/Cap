import { describe, expect, it } from "vitest";
import {
	EDITOR_CONNECTION_COPY,
	editorConnectionDetail,
	editorConnectionDisplay,
	parseEditorConnectionMessage,
} from "@/lib/editor-connection";

describe("parseEditorConnectionMessage", () => {
	it("accepts the editor frame's report", () => {
		expect(
			parseEditorConnectionMessage({
				kind: "cap-editor-connection",
				version: 1,
				level: "poor",
				basis: "media",
				mbps: 1.4,
				latencyMs: 420,
			}),
		).toEqual({ level: "poor", basis: "media", mbps: 1.4, latencyMs: 420 });
	});

	it("rejects anything else", () => {
		for (const data of [
			null,
			"good",
			{ kind: "cap-editor-connection", version: 2, level: "good" },
			{ kind: "cap-editor-connection", version: 1, level: "great" },
			{ kind: "cap-editor-painted", version: 1, level: "good" },
		])
			expect(parseEditorConnectionMessage(data)).toBeNull();
	});

	it("drops numbers it can't trust", () => {
		expect(
			parseEditorConnectionMessage({
				kind: "cap-editor-connection",
				version: 1,
				level: "good",
				basis: "other",
				mbps: Number.NaN,
				latencyMs: -1,
			}),
		).toEqual({ level: "good", basis: null, mbps: null, latencyMs: null });
	});
});

describe("editorConnectionDisplay", () => {
	const report = (level: "good" | "offline") => ({
		level,
		basis: "media" as const,
		mbps: 20,
		latencyMs: 50,
	});

	it("shows the page's own offline state first", () => {
		expect(editorConnectionDisplay(report("good"), false)).toBe("offline");
		expect(editorConnectionDisplay(null, false)).toBe("offline");
	});

	it("checks until the editor reports, or while it catches up", () => {
		expect(editorConnectionDisplay(null, true)).toBe("checking");
		expect(editorConnectionDisplay(report("offline"), true)).toBe("checking");
		expect(editorConnectionDisplay(report("good"), true)).toBe("good");
	});
});

describe("editorConnectionDetail", () => {
	it("formats what the editor measured", () => {
		expect(
			editorConnectionDetail({
				level: "good",
				basis: "media",
				mbps: 23.6,
				latencyMs: 84,
			}),
		).toBe("24 Mbps · 80 ms response");
		expect(
			editorConnectionDetail({
				level: "poor",
				basis: "media",
				mbps: 1.43,
				latencyMs: 1460,
			}),
		).toBe("1.4 Mbps · 1.5 s response");
		expect(
			editorConnectionDetail({
				level: "good",
				basis: "media",
				mbps: 2006,
				latencyMs: 4,
			}),
		).toBe("Over 100 Mbps · 10 ms response");
	});

	it("says nothing it didn't measure", () => {
		expect(
			editorConnectionDetail({
				level: "good",
				basis: "hint",
				mbps: 10,
				latencyMs: 50,
			}),
		).toBeNull();
		expect(editorConnectionDetail(null)).toBeNull();
	});
});

it("copy has no em dashes", () => {
	for (const copy of Object.values(EDITOR_CONNECTION_COPY))
		expect(`${copy.label}${copy.title}${copy.body}`).not.toMatch(/—/);
});
