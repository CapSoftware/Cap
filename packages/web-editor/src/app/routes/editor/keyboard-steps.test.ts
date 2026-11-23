// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
	arrowStep,
	DRAG_ORIGIN,
	moveToolbarFocus,
	normalizeRotation,
	padPositionText,
	runSteppedDrag,
	stepFade,
	stepPadPosition,
	steppedDragPoint,
	stepRotation,
} from "./keyboard-steps";

const key = (
	name: string,
	modifiers: Partial<{
		shiftKey: boolean;
		altKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
	}> = {},
) => ({
	key: name,
	shiftKey: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	...modifiers,
});

describe("arrowStep", () => {
	it("moves one pixel per arrow and ten with Shift", () => {
		expect(arrowStep(key("ArrowLeft"))).toEqual({ x: -1, y: 0 });
		expect(arrowStep(key("ArrowRight"))).toEqual({ x: 1, y: 0 });
		expect(arrowStep(key("ArrowUp"))).toEqual({ x: 0, y: -1 });
		expect(arrowStep(key("ArrowDown", { shiftKey: true }))).toEqual({
			x: 0,
			y: 10,
		});
	});

	it("ignores other keys and modified arrows", () => {
		expect(arrowStep(key("Enter"))).toBeNull();
		expect(arrowStep(key("ArrowLeft", { metaKey: true }))).toBeNull();
		expect(arrowStep(key("ArrowLeft", { ctrlKey: true }))).toBeNull();
		expect(arrowStep(key("ArrowLeft", { altKey: true }))).toBeNull();
	});
});

describe("runSteppedDrag", () => {
	it("runs the drag update once with the step as pointer travel and no snapping", () => {
		const calls: unknown[] = [];
		const history: string[] = [];
		const ran = runSteppedDrag(
			{ x: 10, y: -1 },
			() => ({ start: 5 }),
			(point, value, origin) => {
				history.push("update");
				calls.push({ point, value, origin });
			},
			() => {
				history.push("pause");
				return () => history.push("resume");
			},
		);
		expect(ran).toBe(true);
		expect(history).toEqual(["pause", "update", "resume"]);
		expect(calls).toEqual([
			{
				point: { clientX: 10, clientY: -1, shiftKey: true },
				value: { start: 5 },
				origin: DRAG_ORIGIN,
			},
		]);
	});

	it("does nothing when the drag is not allowed", () => {
		const history: string[] = [];
		const ran = runSteppedDrag(
			{ x: 1, y: 0 },
			() => null,
			() => history.push("update"),
			() => {
				history.push("pause");
				return () => history.push("resume");
			},
		);
		expect(ran).toBe(false);
		expect(history).toEqual([]);
	});

	it("matches a pointer drag of the same distance", () => {
		const point = steppedDragPoint({ x: -10, y: 0 });
		expect(point.clientX - DRAG_ORIGIN.x).toBe(-10);
		expect(point.clientY - DRAG_ORIGIN.y).toBe(0);
	});
});

describe("stepFade", () => {
	it("grows a fade in with Right and shrinks it with Left", () => {
		expect(stepFade(key("ArrowRight"), "in", 1, 5)).toBeCloseTo(1.1);
		expect(stepFade(key("ArrowLeft"), "in", 1, 5)).toBeCloseTo(0.9);
		expect(stepFade(key("ArrowRight", { shiftKey: true }), "in", 1, 5)).toBe(2);
	});

	it("grows a fade out with Left, the direction its handle moves", () => {
		expect(stepFade(key("ArrowLeft"), "out", 1, 5)).toBeCloseTo(1.1);
		expect(stepFade(key("ArrowRight"), "out", 1, 5)).toBeCloseTo(0.9);
	});

	it("stays between zero and the room the other fade leaves", () => {
		expect(stepFade(key("ArrowLeft"), "in", 0.05, 5)).toBe(0);
		expect(stepFade(key("ArrowRight", { shiftKey: true }), "in", 4.5, 5)).toBe(
			5,
		);
		expect(stepFade(key("Home"), "in", 3, 5)).toBe(0);
		expect(stepFade(key("End"), "in", 3, 5)).toBe(5);
		expect(stepFade(key("End"), "in", 0, -1)).toBe(0);
	});

	it("leaves other keys alone", () => {
		expect(stepFade(key("Enter"), "in", 1, 5)).toBeNull();
		expect(stepFade(key("ArrowRight", { metaKey: true }), "in", 1, 5)).toBe(
			null,
		);
	});
});

describe("stepPadPosition", () => {
	it("moves the point one percent, or ten with Shift, inside the pad", () => {
		expect(stepPadPosition(key("ArrowRight"), { x: 0.5, y: 0.5 })).toEqual({
			x: 0.51,
			y: 0.5,
		});
		expect(
			stepPadPosition(key("ArrowUp", { shiftKey: true }), { x: 0.5, y: 0.05 }),
		).toEqual({ x: 0.5, y: 0 });
		expect(
			stepPadPosition(key("ArrowRight", { shiftKey: true }), {
				x: 0.95,
				y: 0.5,
			}),
		).toEqual({ x: 1, y: 0.5 });
		expect(stepPadPosition(key("Enter"), { x: 0.5, y: 0.5 })).toBeNull();
	});

	it("describes the point in words", () => {
		expect(padPositionText({ x: 0.25, y: 0.756 })).toBe("25% across, 76% down");
	});
});

describe("stepRotation", () => {
	it("turns a degree per arrow and fifteen with Shift", () => {
		expect(stepRotation(key("ArrowRight"), 10)).toBe(11);
		expect(stepRotation(key("ArrowLeft"), 10)).toBe(9);
		expect(stepRotation(key("ArrowUp", { shiftKey: true }), 10)).toBe(-5);
		expect(stepRotation(key("Enter"), 10)).toBeNull();
	});

	it("wraps past half a turn like a pointer rotation", () => {
		expect(stepRotation(key("ArrowRight", { shiftKey: true }), 175)).toBe(-170);
		expect(normalizeRotation(-190)).toBe(170);
	});
});

describe("moveToolbarFocus", () => {
	function toolbar() {
		const root = document.createElement("div");
		root.innerHTML =
			'<button type="button">One</button><button type="button" disabled>Off</button><button type="button">Two</button><button type="button">Three</button>';
		document.body.append(root);
		const [one, , two, three] = Array.from(root.querySelectorAll("button"));
		return { root, one, two, three };
	}

	function press(root: HTMLElement, name: string) {
		const event = new KeyboardEvent("keydown", {
			key: name,
			cancelable: true,
		});
		Object.defineProperty(event, "currentTarget", { value: root });
		moveToolbarFocus(event as KeyboardEvent & { currentTarget: HTMLElement });
		return event;
	}

	it("moves focus along the enabled buttons and wraps", () => {
		const { root, one, two, three } = toolbar();
		one?.focus();
		expect(press(root, "ArrowRight").defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(two);
		press(root, "ArrowRight");
		expect(document.activeElement).toBe(three);
		press(root, "ArrowRight");
		expect(document.activeElement).toBe(one);
		press(root, "ArrowLeft");
		expect(document.activeElement).toBe(three);
		root.remove();
	});

	it("leaves other keys to the buttons", () => {
		const { root, one } = toolbar();
		one?.focus();
		expect(press(root, "Enter").defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(one);
		root.remove();
	});
});
