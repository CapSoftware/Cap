import { expect, test } from "vitest";
import { activeBrowserSave } from "@/lib/render-farm-status";

const browserSave = (updatedAt: string) => ({
	version: 1 as const,
	startedAt: "2026-09-28T12:00:00.000Z",
	updatedAt,
	progress: 0.4,
});

test("a save the tab is still reporting shows as rendering", () => {
	const now = Date.parse("2026-09-28T12:00:20.000Z");
	expect(
		activeBrowserSave(
			{ browserSave: browserSave("2026-09-28T12:00:10.000Z") },
			now,
		)?.progress,
	).toBe(0.4);
});

test("a save whose tab stopped reporting no longer shows", () => {
	const now = Date.parse("2026-09-28T12:01:00.000Z");
	expect(
		activeBrowserSave(
			{ browserSave: browserSave("2026-09-28T12:00:10.000Z") },
			now,
		),
	).toBeNull();
	expect(activeBrowserSave(null, now)).toBeNull();
});
