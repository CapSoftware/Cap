import { trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { createUndoHistory } from "@solid-primitives/history";
import { createSignal } from "solid-js";
import { type createStore, reconcile, unwrap } from "solid-js/store";
import type { EditorProjectConfiguration } from "./context";

export function createStoreHistory<T extends Static>(
	state: T,
	setState: ReturnType<typeof createStore<T>>[1],
	onRestore?: () => void,
) {
	// not working properly yet
	// const getDelta = captureStoreUpdates(state);

	const [pauseCount, setPauseCount] = createSignal(0);
	let recorded: unknown;

	const history = createUndoHistory(() => {
		if (pauseCount() > 0) return;

		trackStore(state);

		const copy = structuredClone(unwrap(state));
		// Resuming after a pause re-runs this even when nothing changed, which
		// would leave an undo step that restores the same state.
		if (recorded !== undefined && sameValue(recorded, copy)) return;
		recorded = copy;

		return () => {
			onRestore?.();
			setState(reconcile(copy));
		};
	});

	createEventListener(window, "keydown", (e) => {
		switch (e.code) {
			case "KeyZ": {
				if (!(e.ctrlKey || e.metaKey)) return;
				if (e.shiftKey) history.redo();
				else history.undo();
				break;
			}
			case "KeyY": {
				if (!(e.ctrlKey || e.metaKey)) return;
				history.redo();
				break;
			}
			default: {
				return;
			}
		}

		e.preventDefault();
		e.stopPropagation();
	});

	return Object.assign(history, {
		pause() {
			setPauseCount(pauseCount() + 1);

			return () => {
				setPauseCount(pauseCount() - 1);
			};
		},
		isPaused: () => pauseCount() > 0,
	});
}

function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null ||
		Array.isArray(a) !== Array.isArray(b)
	) {
		return false;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return (
			a.length === b.length &&
			a.every((value, index) => sameValue(value, b[index]))
		);
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]),
		)
	);
}

type Static<T = unknown> =
	| {
			[K in number | string]: T;
	  }
	| T[];

/// Fills in the timeline the editor needs before the store (and its undo
/// history) exists, so opening a never-edited project records no edit.
export function withEditorTimeline(
	project: EditorProjectConfiguration,
	recordingDuration: number,
): EditorProjectConfiguration {
	const timeline = project.timeline ?? {
		segments: [{ timescale: 1, start: 0, end: recordingDuration }],
		zoomSegments: [],
		sceneSegments: [],
		maskSegments: [],
		textSegments: [],
		styleSegments: [],
		imageSegments: [],
		captionSegments: [],
		keyboardSegments: [],
		camera3dSegments: [],
		transitions: [],
	};
	return {
		...project,
		timeline: {
			...timeline,
			zoomSegments: timeline.zoomSegments ?? [],
			sceneSegments: timeline.sceneSegments ?? [],
			maskSegments: timeline.maskSegments ?? [],
			textSegments: timeline.textSegments ?? [],
			styleSegments: timeline.styleSegments ?? [],
			imageSegments: timeline.imageSegments ?? [],
			captionSegments: timeline.captionSegments ?? [],
			keyboardSegments: timeline.keyboardSegments ?? [],
			camera3dSegments: timeline.camera3dSegments ?? [],
		},
	};
}
