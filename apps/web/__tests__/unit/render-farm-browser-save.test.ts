import { expect, test } from "vitest";
import { recentBrowserSave } from "@/lib/render-farm-status";

const browserSave = (updatedAt: string) => ({ updatedAt, progress: 0.4 });

test("a save the tab is still reporting, or just finished, is recent", () => {
	const now = Date.parse("2026-09-28T12:00:20.000Z");
	expect(
		recentBrowserSave(
			{ browserSave: browserSave("2026-09-28T12:00:10.000Z") },
			now,
		)?.progress,
	).toBe(0.4);
});

test("a report that has gone quiet is not", () => {
	const now = Date.parse("2026-09-28T12:01:00.000Z");
	expect(
		recentBrowserSave(
			{ browserSave: browserSave("2026-09-28T12:00:10.000Z") },
			now,
		),
	).toBeNull();
	expect(recentBrowserSave(null, now)).toBeNull();
});
