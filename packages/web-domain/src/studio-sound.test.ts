import { expect, test } from "bun:test";
import {
	defaultPreference,
	fromUserPreferences,
	parsePreference,
} from "./studio-sound";

test("Studio Sound uses the desktop default until a valid web preference is saved", () => {
	expect(fromUserPreferences(null)).toEqual(defaultPreference);
	expect(fromUserPreferences({ studioSound: { isolation: "strong" } })).toEqual(
		defaultPreference,
	);
	expect(
		fromUserPreferences({
			studioSound: { enabledByDefault: false, isolation: "light" },
		}),
	).toEqual({ enabledByDefault: false, isolation: "light" });
	expect(parsePreference({ enabledByDefault: true, isolation: "nope" })).toBe(
		null,
	);
});
