import { describe, expect, it } from "vitest";
import {
	createHandledKeyTracker,
	hasBrowserShortcutModifier,
} from "@/app/s/[videoId]/_components/video/shortcut-modifiers";

const press = (mods: {
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	altGraph?: boolean;
}) => ({
	metaKey: mods.metaKey ?? false,
	ctrlKey: mods.ctrlKey ?? false,
	altKey: mods.altKey ?? false,
	getModifierState: (key: string) => key === "AltGraph" && !!mods.altGraph,
});

describe("hasBrowserShortcutModifier", () => {
	it("is false for plain and shift-only keys", () => {
		expect(hasBrowserShortcutModifier(press({}))).toBe(false);
	});

	it.each(["metaKey", "ctrlKey", "altKey"] as const)("is true with %s", (k) => {
		expect(hasBrowserShortcutModifier(press({ [k]: true }))).toBe(true);
	});

	it("is false for AltGr, which browsers report as Ctrl+Alt", () => {
		expect(
			hasBrowserShortcutModifier(
				press({ ctrlKey: true, altKey: true, altGraph: true }),
			),
		).toBe(false);
	});
});

describe("createHandledKeyTracker", () => {
	it("ignores a keyup whose keydown the player skipped (Ctrl released first)", () => {
		const keys = createHandledKeyTracker();
		expect(keys.up("arrowup")).toBe(false);
	});

	it("matches a keyup to the keydown the player handled, once", () => {
		const keys = createHandledKeyTracker();
		keys.down("arrowup");
		expect(keys.up("arrowup")).toBe(true);
		expect(keys.up("arrowup")).toBe(false);
	});
});
