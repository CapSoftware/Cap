// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawingOverlay } from "./drawing-overlay";

class MockPointerEvent extends MouseEvent {
	pointerId: number;
	constructor(type: string, init?: PointerEventInit & { pointerId?: number }) {
		super(type, init);
		this.pointerId = init?.pointerId ?? 0;
	}
}

// Polyfill PointerEvent for jsdom
(window as unknown as { PointerEvent: unknown }).PointerEvent = MockPointerEvent;
(globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MockPointerEvent;

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();

let rafCallbacks: Array<(time: number) => void> = [];
let nextRafId = 1;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	rafCallbacks = [];
	nextRafId = 1;

	Element.prototype.setPointerCapture = vi.fn();
	Element.prototype.releasePointerCapture = vi.fn();

	// Mock requestAnimationFrame to control ticks and count iterations
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
		const id = nextRafId++;
		rafCallbacks.push(cb);
		return id;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
		rafCallbacks = [];
	});

	// Mock canvas 2D context
	const mockContext = {
		setTransform: vi.fn(),
		clearRect: vi.fn(),
		beginPath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		quadraticCurveTo: vi.fn(),
		arc: vi.fn(),
		fill: vi.fn(),
		stroke: vi.fn(),
		globalAlpha: 1,
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		lineCap: "",
		lineJoin: "",
	};

	HTMLCanvasElement.prototype.getContext = vi.fn(() => mockContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const flushRaf = (time = performance.now()) => {
	const current = [...rafCallbacks];
	rafCallbacks = [];
	for (const cb of current) {
		cb(time);
	}
};

describe("DrawingOverlay CPU & memory optimization", () => {
	it("renders canvas and goes dormant without infinite rAF when idle", () => {
		act(() => {
			root.render(<DrawingOverlay active onClose={onClose} />);
		});

		const canvas = host.querySelector("canvas");
		expect(canvas).not.toBeNull();
		expect(rafCallbacks.length).toBe(1);

		act(() => {
			flushRaf();
		});

		expect(rafCallbacks.length).toBe(0);
	});

	it("activates render loop when drawing and halts when completed strokes finish", () => {
		act(() => {
			root.render(<DrawingOverlay active onClose={onClose} />);
		});
		act(() => flushRaf());
		expect(rafCallbacks.length).toBe(0);

		const canvas = host.querySelector("canvas")!;

		act(() => {
			canvas.dispatchEvent(
				new PointerEvent("pointerdown", {
					clientX: 100,
					clientY: 100,
					pointerId: 1,
					bubbles: true,
				}),
			);
		});

		expect(rafCallbacks.length).toBe(1);

		act(() => {
			canvas.dispatchEvent(
				new PointerEvent("pointermove", {
					clientX: 120,
					clientY: 130,
					pointerId: 1,
					bubbles: true,
				}),
			);
		});

		act(() => {
			flushRaf(1000);
		});
		expect(rafCallbacks.length).toBe(1);

		act(() => {
			canvas.dispatchEvent(
				new PointerEvent("pointerup", {
					clientX: 120,
					clientY: 130,
					pointerId: 1,
					bubbles: true,
				}),
			);
		});

		act(() => {
			flushRaf(performance.now() + 10000);
		});

		expect(rafCallbacks.length).toBe(0);
	});

	it("clears canvas and cancels active animation frames on clear", () => {
		act(() => {
			root.render(<DrawingOverlay active onClose={onClose} />);
		});
		act(() => flushRaf());

		const canvas = host.querySelector("canvas")!;
		act(() => {
			canvas.dispatchEvent(
				new PointerEvent("pointerdown", {
					clientX: 50,
					clientY: 50,
					pointerId: 1,
					bubbles: true,
				}),
			);
		});

		expect(rafCallbacks.length).toBe(1);

		const clearBtn = host.querySelector("button[title='Clear drawing']") as HTMLButtonElement;
		expect(clearBtn).not.toBeNull();

		act(() => {
			clearBtn.click();
		});

		expect(rafCallbacks.length).toBe(0);
	});
});
