import { trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { createUndoHistory } from "@solid-primitives/history";
import { createSignal } from "solid-js";
import { type createStore, reconcile, unwrap } from "solid-js/store";

export function createStoreHistory<T extends Static>(
	state: T,
	setState: ReturnType<typeof createStore<T>>[1],
	onRestore?: () => void,
) {
	// not working properly yet
	// const getDelta = captureStoreUpdates(state);

	// Pauses are tokens rather than a bare counter: a caller that never resumes
	// (a slider whose change-end event never fires, a drag whose mouseup lands
	// outside the window) used to freeze history, so the next undo discarded
	// every edit since the leak. Pauses taken during a pointer press now end
	// with that press, and undo/redo flush any pause still held.
	const activePauses = new Set<symbol>();
	const pointerPauses = new Set<symbol>();
	let pointerPressed = false;
	const [pauseCount, setPauseCount] = createSignal(0);

	const releasePauses = (tokens: Iterable<symbol>) => {
		let released = false;
		for (const token of [...tokens]) {
			if (activePauses.delete(token)) released = true;
			pointerPauses.delete(token);
		}
		if (released) setPauseCount(activePauses.size);
	};

	const history = createUndoHistory(() => {
		if (pauseCount() > 0) return;

		trackStore(state);

		const copy = structuredClone(unwrap(state));

		return () => {
			onRestore?.();
			setState(reconcile(copy));
		};
	});

	const undo = () => {
		releasePauses(activePauses);
		history.undo();
	};
	const redo = () => {
		releasePauses(activePauses);
		history.redo();
	};

	createEventListener(
		window,
		"pointerdown",
		() => {
			releasePauses(pointerPauses);
			pointerPressed = true;
		},
		{ capture: true },
	);
	const endPointerPress = () => {
		pointerPressed = false;
		setTimeout(() => releasePauses(pointerPauses), 0);
	};
	createEventListener(window, "pointerup", endPointerPress, { capture: true });
	createEventListener(window, "pointercancel", endPointerPress, {
		capture: true,
	});

	createEventListener(window, "keydown", (e) => {
		switch (e.code) {
			case "KeyZ": {
				if (!(e.ctrlKey || e.metaKey)) return;
				if (e.shiftKey) redo();
				else undo();
				break;
			}
			case "KeyY": {
				if (!(e.ctrlKey || e.metaKey)) return;
				redo();
				break;
			}
			default: {
				return;
			}
		}

		e.preventDefault();
		e.stopPropagation();
	});

	return {
		canRedo: history.canRedo,
		canUndo: () => pauseCount() > 0 || history.canUndo(),
		undo,
		redo,
		pause() {
			const token = Symbol("history-pause");
			activePauses.add(token);
			if (pointerPressed) pointerPauses.add(token);
			setPauseCount(activePauses.size);

			return () => releasePauses([token]);
		},
		isPaused: () => pauseCount() > 0,
	};
}

type Static<T = unknown> =
	| {
			[K in number | string]: T;
	  }
	| T[];
