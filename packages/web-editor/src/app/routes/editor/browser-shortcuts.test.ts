import { describe, expect, it } from "vitest";
import { isBrowserShortcut } from "./browser-shortcuts";

const key = (
	key: string,
	modifiers: Partial<{
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
	}> = {},
) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });

describe("isBrowserShortcut", () => {
	it("passes reload, hard reload and find with Cmd or Ctrl", () => {
		expect(isBrowserShortcut(key("r", { metaKey: true }))).toBe(true);
		expect(isBrowserShortcut(key("R", { metaKey: true }))).toBe(true);
		expect(isBrowserShortcut(key("r", { ctrlKey: true }))).toBe(true);
		expect(isBrowserShortcut(key("R", { ctrlKey: true }))).toBe(true);
		expect(isBrowserShortcut(key("f", { metaKey: true }))).toBe(true);
		expect(isBrowserShortcut(key("l", { ctrlKey: true }))).toBe(true);
		expect(isBrowserShortcut(key("w", { metaKey: true }))).toBe(true);
	});

	it("passes Alt+Left and Alt+Right history navigation", () => {
		expect(isBrowserShortcut(key("ArrowLeft", { altKey: true }))).toBe(true);
		expect(isBrowserShortcut(key("ArrowRight", { altKey: true }))).toBe(true);
		expect(isBrowserShortcut(key("Home", { altKey: true }))).toBe(true);
	});

	it("passes function keys, including F5 reload", () => {
		expect(isBrowserShortcut(key("F5"))).toBe(true);
		expect(isBrowserShortcut(key("F12"))).toBe(true);
		expect(isBrowserShortcut(key("F4", { altKey: true }))).toBe(true);
	});

	it("leaves the editor's own keys to the editor", () => {
		expect(isBrowserShortcut(key("r"))).toBe(false);
		expect(isBrowserShortcut(key(" "))).toBe(false);
		expect(isBrowserShortcut(key("f"))).toBe(false);
		expect(isBrowserShortcut(key("F"))).toBe(false);
		expect(isBrowserShortcut(key("Escape"))).toBe(false);
		expect(isBrowserShortcut(key("ArrowLeft"))).toBe(false);
	});
});
