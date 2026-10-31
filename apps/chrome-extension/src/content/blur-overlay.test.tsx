// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlurOverlay } from "./blur-overlay";

let root: Root;
let host: HTMLDivElement;
let target: HTMLDivElement;
const onDone = vi.fn();

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	target = document.createElement("div");
	document.body.append(host, target);
	Object.defineProperty(document, "elementFromPoint", {
		configurable: true,
		value: vi.fn(() => target),
	});
	root = createRoot(host);
	act(() => root.render(<BlurOverlay active onDone={onDone} />));
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	target.remove();
	Reflect.deleteProperty(document, "elementFromPoint");
	vi.unstubAllGlobals();
});

const clickTarget = () => {
	const event = new MouseEvent("click", { bubbles: true, cancelable: true });
	act(() => target.dispatchEvent(event));
	return event;
};

describe("blur style restoration", () => {
	it.each([
		{
			filter: "contrast(2)",
			filterPriority: "important",
			select: "text",
			selectPriority: "important",
		},
		{
			filter: "grayscale(1)",
			filterPriority: "",
			select: "all",
			selectPriority: "",
		},
		{
			filter: "",
			filterPriority: "",
			select: "none",
			selectPriority: "important",
		},
	])(
		"restores the original inline values and priorities: $select/$filter",
		(styles) => {
			target.style.setProperty("filter", styles.filter, styles.filterPriority);
			target.style.setProperty(
				"user-select",
				styles.select,
				styles.selectPriority,
			);
			target.style.setProperty("color", "red", "important");
			for (let cycle = 0; cycle < 2; cycle++) {
				expect(clickTarget().defaultPrevented).toBe(true);
				expect(target.style.getPropertyValue("filter")).toBe("blur(12px)");
				expect(target.style.getPropertyPriority("filter")).toBe("important");
				expect(target.style.getPropertyValue("user-select")).toBe("none");
				expect(target.style.getPropertyPriority("user-select")).toBe(
					"important",
				);
				clickTarget();
				expect(target.style.getPropertyValue("filter")).toBe(styles.filter);
				expect(target.style.getPropertyPriority("filter")).toBe(
					styles.filterPriority,
				);
				expect(target.style.getPropertyValue("user-select")).toBe(
					styles.select,
				);
				expect(target.style.getPropertyPriority("user-select")).toBe(
					styles.selectPriority,
				);
				expect(target.style.getPropertyValue("color")).toBe("red");
				expect(target.style.getPropertyPriority("color")).toBe("important");
				expect(Object.keys(target.dataset)).toEqual([]);
			}
		},
	);

	it("removes temporary styles when the target had no inline declarations", () => {
		clickTarget();
		clickTarget();
		expect(target.style.getPropertyValue("filter")).toBe("");
		expect(target.style.getPropertyValue("user-select")).toBe("");
		expect(Object.keys(target.dataset)).toEqual([]);
	});

	it("retains saved styles when the blur tool closes and reopens", () => {
		target.style.setProperty("user-select", "text", "important");
		clickTarget();
		act(() => root.render(<BlurOverlay active={false} onDone={onDone} />));
		expect(clickTarget().defaultPrevented).toBe(false);
		expect(target.style.getPropertyValue("filter")).toBe("blur(12px)");
		act(() => root.render(<BlurOverlay active onDone={onDone} />));
		clickTarget();
		expect(target.style.getPropertyValue("user-select")).toBe("text");
		expect(target.style.getPropertyPriority("user-select")).toBe("important");
		expect(Object.keys(target.dataset)).toEqual([]);
	});

	it("ignores extension controls", () => {
		target.id = "cap-extension-recorder-overlay";
		target.style.setProperty("user-select", "text", "important");
		expect(clickTarget().defaultPrevented).toBe(false);
		expect(target.style.getPropertyValue("user-select")).toBe("text");
		expect(target.style.getPropertyPriority("user-select")).toBe("important");
		expect(Object.keys(target.dataset)).toEqual([]);
	});
});
