import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeTouchToMouse } from "./touch-mouse-bridge";

class FakeElement extends EventTarget {
	parentElement: FakeElement | null = null;
	closest() {
		return null;
	}
}

class FakeMouseEvent extends Event {
	clientX = 0;
	clientY = 0;
	buttons = 0;
	ctrlKey = false;
	deltaX = 0;
	deltaY = 0;
	constructor(type: string, init: Record<string, unknown> = {}) {
		super(type, init as EventInit);
		// Event's own flags are read-only; the rest are plain fields here.
		for (const [key, value] of Object.entries(init))
			if (!(key in Event.prototype)) Object.assign(this, { [key]: value });
	}
}

const globals = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

function touchEvent(
	type: string,
	touches: { x: number; y: number }[],
	changed = touches,
) {
	const toTouch = (point: { x: number; y: number }, identifier: number) => ({
		identifier,
		clientX: point.x,
		clientY: point.y,
	});
	const event = new Event(type, { cancelable: true });
	Object.defineProperty(event, "touches", { value: touches.map(toTouch) });
	Object.defineProperty(event, "changedTouches", {
		value: changed.map(toTouch),
	});
	return event;
}

describe("bridgeTouchToMouse", () => {
	let element: FakeElement;
	let events: FakeMouseEvent[];

	beforeEach(() => {
		for (const key of [
			"window",
			"document",
			"MouseEvent",
			"WheelEvent",
			"Element",
		])
			saved[key] = globals[key];
		element = new FakeElement();
		events = [];
		for (const type of ["mousedown", "mousemove", "mouseup", "wheel"])
			element.addEventListener(type, (event) =>
				events.push(event as FakeMouseEvent),
			);
		globals.window = { screenX: 0, screenY: 0 };
		globals.document = { elementFromPoint: () => element };
		globals.MouseEvent = FakeMouseEvent;
		globals.WheelEvent = FakeMouseEvent;
		globals.Element = FakeElement;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) globals[key] = value;
	});

	it("replays a one-finger drag as a mouse drag from where it began", () => {
		bridgeTouchToMouse(element as unknown as HTMLElement);
		element.dispatchEvent(touchEvent("touchstart", [{ x: 10, y: 20 }]));
		const move = touchEvent("touchmove", [{ x: 60, y: 22 }]);
		element.dispatchEvent(move);
		element.dispatchEvent(touchEvent("touchend", [], [{ x: 60, y: 22 }]));

		expect(move.defaultPrevented).toBe(true);
		const down = events.find((event) => event.type === "mousedown");
		expect(down).toMatchObject({ clientX: 10, clientY: 20, buttons: 1 });
		expect(events.at(-2)).toMatchObject({ type: "mousemove", clientX: 60 });
		expect(events.at(-1)).toMatchObject({ type: "mouseup", clientX: 60 });
	});

	it("leaves a tap to the browser's own mouse events", () => {
		bridgeTouchToMouse(element as unknown as HTMLElement);
		element.dispatchEvent(touchEvent("touchstart", [{ x: 10, y: 20 }]));
		element.dispatchEvent(touchEvent("touchmove", [{ x: 11, y: 21 }]));
		element.dispatchEvent(touchEvent("touchend", [], [{ x: 11, y: 21 }]));
		expect(events).toEqual([]);
	});

	it("turns a two-finger spread into a ctrl+wheel zoom in", () => {
		bridgeTouchToMouse(element as unknown as HTMLElement, { pinch: true });
		element.dispatchEvent(
			touchEvent("touchstart", [
				{ x: 100, y: 50 },
				{ x: 140, y: 50 },
			]),
		);
		element.dispatchEvent(
			touchEvent("touchmove", [
				{ x: 80, y: 50 },
				{ x: 160, y: 50 },
			]),
		);
		const wheel = events.find((event) => event.type === "wheel");
		expect(wheel?.ctrlKey).toBe(true);
		// Zooming in shows fewer seconds: a negative pinch delta.
		expect(wheel?.deltaY).toBeLessThan(0);
		expect(events.some((event) => event.type === "mousedown")).toBe(false);
	});

	it("ignores two fingers where pinching is off", () => {
		bridgeTouchToMouse(element as unknown as HTMLElement);
		element.dispatchEvent(
			touchEvent("touchstart", [
				{ x: 100, y: 50 },
				{ x: 140, y: 50 },
			]),
		);
		element.dispatchEvent(
			touchEvent("touchmove", [
				{ x: 80, y: 50 },
				{ x: 160, y: 50 },
			]),
		);
		expect(events).toEqual([]);
	});
});
