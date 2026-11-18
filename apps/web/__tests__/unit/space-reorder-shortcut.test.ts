// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { reorderShortcutDirection } from "@/lib/space-video-order";

const press = (
	key: string,
	target: EventTarget | null,
	overrides: Partial<Parameters<typeof reorderShortcutDirection>[0]> = {},
) =>
	reorderShortcutDirection({
		key,
		altKey: true,
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		defaultPrevented: false,
		target,
		...overrides,
	});

describe("reorderShortcutDirection", () => {
	it("moves a focused card with Alt+Left and Alt+Right", () => {
		const card = document.createElement("div");
		card.tabIndex = 0;
		expect(press("ArrowLeft", card)).toBe("earlier");
		expect(press("ArrowRight", card)).toBe("later");
	});

	it("ignores other keys and modifier combinations", () => {
		const card = document.createElement("div");
		expect(press("ArrowUp", card)).toBeNull();
		expect(press("ArrowLeft", card, { altKey: false })).toBeNull();
		expect(press("ArrowLeft", card, { metaKey: true })).toBeNull();
		expect(press("ArrowLeft", card, { ctrlKey: true })).toBeNull();
		expect(press("ArrowLeft", card, { shiftKey: true })).toBeNull();
		expect(press("ArrowLeft", card, { defaultPrevented: true })).toBeNull();
	});

	it("leaves Alt+Arrow to the title and date editors", () => {
		const card = document.createElement("div");
		const title = document.createElement("textarea");
		const date = document.createElement("input");
		card.append(title, date);
		expect(press("ArrowLeft", title)).toBeNull();
		expect(press("ArrowRight", date)).toBeNull();
		expect(press("ArrowLeft", document.createElement("select"))).toBeNull();
	});

	it("leaves Alt+Arrow to contenteditable text and open menus", () => {
		const editable = document.createElement("div");
		editable.setAttribute("contenteditable", "true");
		const inner = document.createElement("span");
		editable.append(inner);
		document.body.append(editable);
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		const item = document.createElement("button");
		menu.append(item);
		expect(press("ArrowLeft", editable)).toBeNull();
		expect(press("ArrowLeft", item)).toBeNull();
		editable.remove();
	});
});
