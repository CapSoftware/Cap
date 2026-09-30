import { describe, expect, it, vi } from "vitest";
import { startPointerDrag } from "./animated-gradient-drag";

type GradientState = {
	stops: number[];
};

function createHistory(initial: GradientState) {
	let state = structuredClone(initial);
	let pauseDepth = 0;
	const snapshots = [structuredClone(state)];
	const commit = () => {
		if (
			JSON.stringify(snapshots[snapshots.length - 1]) !== JSON.stringify(state)
		)
			snapshots.push(structuredClone(state));
	};

	return {
		get state() {
			return state;
		},
		get snapshotCount() {
			return snapshots.length;
		},
		get paused() {
			return pauseDepth > 0;
		},
		mutate(update: (value: GradientState) => void) {
			update(state);
			if (pauseDepth === 0) commit();
		},
		pause() {
			pauseDepth += 1;
			let resumed = false;
			return () => {
				if (resumed) return;
				resumed = true;
				pauseDepth -= 1;
				if (pauseDepth === 0) commit();
			};
		},
		undo() {
			if (snapshots.length > 1) snapshots.pop();
			state = structuredClone(snapshots[snapshots.length - 1]);
		},
	};
}

function createTarget() {
	const target = new EventTarget() as EventTarget & {
		setPointerCapture: ReturnType<typeof vi.fn>;
	};
	target.setPointerCapture = vi.fn();
	return target;
}

function pointerEvent(type: string, clientX = 0, pointerId = 7) {
	const event = new Event(type);
	Object.defineProperties(event, {
		clientX: { value: clientX },
		pointerId: { value: pointerId },
	});
	return event;
}

function asElement(target: EventTarget) {
	return target as unknown as HTMLElement;
}

describe("startPointerDrag", () => {
	it("groups adding and dragging a stop into one undo entry", () => {
		const target = createTarget();
		const history = createHistory({ stops: [0, 100] });
		let stopIndex = -1;
		startPointerDrag({
			target: asElement(target),
			pointerId: 7,
			pauseHistory: history.pause,
			pauseImmediately: true,
			onStart: () =>
				history.mutate((state) => {
					stopIndex = 1;
					state.stops.splice(stopIndex, 0, 30);
				}),
			onMove: (event) =>
				history.mutate((state) => {
					state.stops[stopIndex] = event.clientX;
				}),
		});

		target.dispatchEvent(pointerEvent("pointermove", 40));
		target.dispatchEvent(pointerEvent("pointerup", 40));

		expect(history.state.stops).toEqual([0, 40, 100]);
		expect(history.snapshotCount).toBe(2);
		history.undo();
		expect(history.state.stops).toEqual([0, 100]);
	});

	it("groups dragging an existing stop into one undo entry", () => {
		const target = createTarget();
		const history = createHistory({ stops: [0, 30, 100] });
		startPointerDrag({
			target: asElement(target),
			pointerId: 7,
			pauseHistory: history.pause,
			onMove: (event) =>
				history.mutate((state) => {
					state.stops[1] = event.clientX;
				}),
		});

		target.dispatchEvent(pointerEvent("pointermove", 40));
		target.dispatchEvent(pointerEvent("pointermove", 50));
		target.dispatchEvent(pointerEvent("pointerup", 50));

		expect(history.snapshotCount).toBe(2);
		history.undo();
		expect(history.state.stops).toEqual([0, 30, 100]);
	});

	it("keeps a click without movement atomic", () => {
		const addTarget = createTarget();
		const addHistory = createHistory({ stops: [0, 100] });
		startPointerDrag({
			target: asElement(addTarget),
			pointerId: 7,
			pauseHistory: addHistory.pause,
			pauseImmediately: true,
			onStart: () => addHistory.mutate((state) => state.stops.splice(1, 0, 30)),
			onMove: () => undefined,
		});
		addTarget.dispatchEvent(pointerEvent("pointerup", 30));

		expect(addHistory.snapshotCount).toBe(2);
		addHistory.undo();
		expect(addHistory.state.stops).toEqual([0, 100]);

		const existingTarget = createTarget();
		const existingHistory = createHistory({ stops: [0, 30, 100] });
		startPointerDrag({
			target: asElement(existingTarget),
			pointerId: 7,
			pauseHistory: existingHistory.pause,
			onMove: () => undefined,
		});
		existingTarget.dispatchEvent(pointerEvent("pointerup", 30));
		expect(existingHistory.snapshotCount).toBe(1);
	});

	it.each(["pointercancel", "lostpointercapture"])(
		"resumes history and removes listeners on %s",
		(endEvent) => {
			const target = createTarget();
			const history = createHistory({ stops: [0, 30, 100] });
			startPointerDrag({
				target: asElement(target),
				pointerId: 7,
				pauseHistory: history.pause,
				onMove: (event) =>
					history.mutate((state) => {
						state.stops[1] = event.clientX;
					}),
			});

			target.dispatchEvent(pointerEvent("pointermove", 40));
			target.dispatchEvent(pointerEvent(endEvent, 40));
			target.dispatchEvent(pointerEvent("pointermove", 50));

			expect(history.paused).toBe(false);
			expect(history.state.stops).toEqual([0, 40, 100]);
		},
	);

	it("resumes history and removes listeners on unmount cleanup", () => {
		const target = createTarget();
		const history = createHistory({ stops: [0, 30, 100] });
		const session = startPointerDrag({
			target: asElement(target),
			pointerId: 7,
			pauseHistory: history.pause,
			onMove: (event) =>
				history.mutate((state) => {
					state.stops[1] = event.clientX;
				}),
		});

		target.dispatchEvent(pointerEvent("pointermove", 40));
		session.cleanup();
		session.cleanup();
		target.dispatchEvent(pointerEvent("pointermove", 50));

		expect(history.paused).toBe(false);
		expect(history.state.stops).toEqual([0, 40, 100]);
	});
});
