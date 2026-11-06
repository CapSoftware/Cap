// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useCapSelectionShortcuts } from "../../hooks/use-cap-selection-shortcuts";

let root: Root;
let container: HTMLDivElement;
const items = [{ id: "first" }, { id: "second" }];

function Host({ enabled = true, data = items }) {
	const [selected, setSelected] = useState<string[]>([]);
	useCapSelectionShortcuts({ enabled, items: data, setSelected });
	return createElement("output", null, selected.join(","));
}

function press(target: EventTarget, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", {
		key: "a",
		ctrlKey: true,
		bubbles: true,
		cancelable: true,
		...init,
	});
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

test.each([
	{ ctrlKey: true },
	{ ctrlKey: false, metaKey: true },
	{ key: "A", ctrlKey: true },
])(
	"selects the current page with platform Select All shortcuts: %j",
	(init) => {
		act(() => root.render(createElement(Host)));
		expect(press(document.body, init).defaultPrevented).toBe(true);
		expect(container.textContent).toBe("first,second");
	},
);

test.each([
	'<input value="draft" />',
	"<textarea>draft</textarea>",
	"<select><option>draft</option></select>",
	'<div contenteditable=""><span>draft</span></div>',
	'<div role="textbox">draft</div>',
	'<div role="combobox">draft</div>',
])("preserves native text selection in %s", (html) => {
	act(() => root.render(createElement(Host)));
	const field = document.createElement("div");
	field.innerHTML = html;
	document.body.append(field);
	const target = field.querySelector("span") ?? field.firstElementChild;
	if (!target) throw new Error("Missing input fixture");
	expect(press(target).defaultPrevented).toBe(false);
	expect(container.textContent).toBe("");
});

test("does not select Caps behind an open modal", () => {
	act(() => root.render(createElement(Host)));
	const dialog = document.createElement("div");
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("data-state", "open");
	document.body.append(dialog);
	expect(press(document.body).defaultPrevented).toBe(false);
	expect(container.textContent).toBe("");
});

test("leaves selection unavailable to viewers and empty collections", () => {
	act(() => root.render(createElement(Host, { enabled: false })));
	expect(press(document.body).defaultPrevented).toBe(false);
	act(() => root.render(createElement(Host, { data: [] })));
	expect(press(document.body).defaultPrevented).toBe(false);
	expect(container.textContent).toBe("");
});

test("uses the new page and removes the handler when management is disabled", () => {
	act(() => root.render(createElement(Host)));
	act(() => root.render(createElement(Host, { data: [{ id: "next-page" }] })));
	press(document.body);
	expect(container.textContent).toBe("next-page");
	act(() => root.render(createElement(Host, { enabled: false })));
	expect(press(document.body).defaultPrevented).toBe(false);
});

test.each([
	{ ctrlKey: false },
	{ altKey: true },
	{ shiftKey: true },
	{ isComposing: true },
	{ key: "Delete" },
])("does not change selection for other key events: %j", (init) => {
	act(() => root.render(createElement(Host)));
	expect(press(document.body, init).defaultPrevented).toBe(false);
	expect(container.textContent).toBe("");
});
