import { trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { createUndoHistory } from "@solid-primitives/history";
import { createEffect, createSignal } from "solid-js";
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
	// once every pressed pointer is released (or the release is found to have
	// been missed), and undo/redo flush any pause still held.
	const activePauses = new Set<symbol>();
	const pointerPauses = new Set<symbol>();
	const pressedPointers = new Set<number>();
	const [pauseCount, setPauseCount] = createSignal(0);
	const [changedWhilePaused, setChangedWhilePaused] = createSignal(false);

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

	createEffect(() => {
		if (pauseCount() === 0) {
			setChangedWhilePaused(false);
			return;
		}
		let initial = true;
		createEffect(() => {
			trackStore(state);
			if (initial) initial = false;
			else setChangedWhilePaused(true);
		});
	});

	const undo = () => {
		releasePauses(activePauses);
		history.undo();
	};
	const redo = () => {
		releasePauses(activePauses);
		history.redo();
	};

	const releaseAllPointers = () => {
		pressedPointers.clear();
		releasePauses(pointerPauses);
	};
	createEventListener(
		window,
		"pointerdown",
		(e) => {
			if (pressedPointers.size === 0) releasePauses(pointerPauses);
			pressedPointers.add(e.pointerId);
		},
		{ capture: true },
	);
	const endPointerPress = (e: PointerEvent) => {
		pressedPointers.delete(e.pointerId);
		if (pressedPointers.size > 0) return;
		setTimeout(() => {
			if (pressedPointers.size === 0) releasePauses(pointerPauses);
		}, 0);
	};
	createEventListener(window, "pointerup", endPointerPress, { capture: true });
	createEventListener(window, "pointercancel", endPointerPress, {
		capture: true,
	});
	// A press released outside the window never delivers pointerup; the next
	// buttonless move over the window, or losing focus, ends it instead.
	createEventListener(
		window,
		"pointermove",
		(e) => {
			if (e.buttons === 0 && pressedPointers.size > 0) releaseAllPointers();
		},
		{ capture: true },
	);
	createEventListener(window, "blur", releaseAllPointers);

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
		canUndo: () => changedWhilePaused() || history.canUndo(),
		undo,
		redo,
		pause() {
			const token = Symbol("history-pause");
			activePauses.add(token);
			if (pressedPointers.size > 0) pointerPauses.add(token);
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
