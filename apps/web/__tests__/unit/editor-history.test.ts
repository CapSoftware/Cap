import { describe, expect, it } from "vitest";

interface HistoryState<T> {
	past: T[];
	present: T;
	future: T[];
}

function createHistoryState<T>(initial: T): HistoryState<T> {
	return {
		past: [],
		present: initial,
		future: [],
	};
}

function set<T>(
	state: HistoryState<T>,
	newPresent: T | ((prev: T) => T),
	maxHistory = 50,
): HistoryState<T> {
	const resolvedPresent =
		typeof newPresent === "function"
			? (newPresent as (prev: T) => T)(state.present)
			: newPresent;

	return {
		past: [...state.past.slice(-(maxHistory - 1)), state.present],
		present: resolvedPresent,
		future: [],
	};
}

function undo<T>(state: HistoryState<T>): HistoryState<T> {
	if (state.past.length === 0) return state;
	const previous = state.past[state.past.length - 1]!;
	const newPast = state.past.slice(0, -1);
	return {
		past: newPast,
		present: previous,
		future: [state.present, ...state.future],
	};
}

function redo<T>(state: HistoryState<T>): HistoryState<T> {
	if (state.future.length === 0) return state;
	const next = state.future[0]!;
	const newFuture = state.future.slice(1);
	return {
		past: [...state.past, state.present],
		present: next,
		future: newFuture,
	};
}

function canUndo<T>(state: HistoryState<T>): boolean {
	return state.past.length > 0;
}

function canRedo<T>(state: HistoryState<T>): boolean {
	return state.future.length > 0;
}

describe("Editor History (undo/redo)", () => {
	describe("initial state", () => {
		it("creates history with initial value", () => {
			const state = createHistoryState({ value: 1 });
			expect(state.present).toEqual({ value: 1 });
			expect(state.past).toEqual([]);
			expect(state.future).toEqual([]);
		});

		it("cannot undo on initial state", () => {
			const state = createHistoryState({ value: 1 });
			expect(canUndo(state)).toBe(false);
		});

		it("cannot redo on initial state", () => {
			const state = createHistoryState({ value: 1 });
			expect(canRedo(state)).toBe(false);
		});
	});

	describe("set operation", () => {
		it("updates present value", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			expect(state.present).toEqual({ value: 2 });
		});

		it("moves previous present to past", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			expect(state.past).toEqual([{ value: 1 }]);
		});

		it("clears future on new set", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = set(state, { value: 3 });
			state = undo(state);
			expect(state.future).toEqual([{ value: 3 }]);
			state = set(state, { value: 4 });
			expect(state.future).toEqual([]);
		});

		it("supports function updater", () => {
			let state = createHistoryState({ count: 0 });
			state = set(state, (prev) => ({ count: prev.count + 1 }));
			expect(state.present).toEqual({ count: 1 });
		});

		it("enables undo after set", () => {
			let state = createHistoryState({ value: 1 });
			expect(canUndo(state)).toBe(false);
			state = set(state, { value: 2 });
			expect(canUndo(state)).toBe(true);
		});
	});

	describe("undo operation", () => {
		it("restores previous value", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = undo(state);
			expect(state.present).toEqual({ value: 1 });
		});

		it("moves current to future", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = undo(state);
			expect(state.future).toEqual([{ value: 2 }]);
		});

		it("removes item from past", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			expect(state.past.length).toBe(1);
			state = undo(state);
			expect(state.past.length).toBe(0);
		});

		it("enables redo after undo", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			expect(canRedo(state)).toBe(false);
			state = undo(state);
			expect(canRedo(state)).toBe(true);
		});

		it("does nothing when no past exists", () => {
			const state = createHistoryState({ value: 1 });
			const newState = undo(state);
			expect(newState).toBe(state);
		});

		it("can undo multiple times", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = set(state, { value: 3 });
			state = set(state, { value: 4 });
			expect(state.present).toEqual({ value: 4 });
			state = undo(state);
			expect(state.present).toEqual({ value: 3 });
			state = undo(state);
			expect(state.present).toEqual({ value: 2 });
			state = undo(state);
			expect(state.present).toEqual({ value: 1 });
		});
	});

	describe("redo operation", () => {
		it("restores undone value", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = undo(state);
			state = redo(state);
			expect(state.present).toEqual({ value: 2 });
		});

		it("moves current to past", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = undo(state);
			state = redo(state);
			expect(state.past).toEqual([{ value: 1 }]);
		});

		it("removes item from future", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = undo(state);
			expect(state.future.length).toBe(1);
			state = redo(state);
			expect(state.future.length).toBe(0);
		});

		it("does nothing when no future exists", () => {
			const state = createHistoryState({ value: 1 });
			const newState = redo(state);
			expect(newState).toBe(state);
		});

		it("can redo multiple times", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = set(state, { value: 3 });
			state = set(state, { value: 4 });
			state = undo(state);
			state = undo(state);
			state = undo(state);
			expect(state.present).toEqual({ value: 1 });
			state = redo(state);
			expect(state.present).toEqual({ value: 2 });
			state = redo(state);
			expect(state.present).toEqual({ value: 3 });
			state = redo(state);
			expect(state.present).toEqual({ value: 4 });
		});
	});

	describe("undo/redo interleaving", () => {
		it("handles interleaved undo and redo", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = set(state, { value: 3 });
			state = undo(state);
			expect(state.present).toEqual({ value: 2 });
			state = redo(state);
			expect(state.present).toEqual({ value: 3 });
			state = undo(state);
			expect(state.present).toEqual({ value: 2 });
		});

		it("new set after undo clears redo stack", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });
			state = set(state, { value: 3 });
			state = undo(state);
			expect(canRedo(state)).toBe(true);
			state = set(state, { value: 4 });
			expect(canRedo(state)).toBe(false);
			expect(state.present).toEqual({ value: 4 });
		});
	});

	describe("history limit (maxHistory)", () => {
		it("respects maxHistory limit", () => {
			let state = createHistoryState(0);
			for (let i = 1; i <= 10; i++) {
				state = set(state, i, 5);
			}
			expect(state.past.length).toBe(5);
			expect(state.past).toEqual([5, 6, 7, 8, 9]);
		});

		it("keeps most recent history entries", () => {
			let state = createHistoryState("a");
			state = set(state, "b", 3);
			state = set(state, "c", 3);
			state = set(state, "d", 3);
			state = set(state, "e", 3);
			expect(state.past).toEqual(["b", "c", "d"]);
			expect(state.present).toBe("e");
		});

		it("default maxHistory is 50", () => {
			let state = createHistoryState(0);
			for (let i = 1; i <= 60; i++) {
				state = set(state, i);
			}
			expect(state.past.length).toBe(50);
		});
	});

	describe("complex state objects", () => {
		interface EditorConfig {
			background: { type: string; color: string };
			segments: Array<{ id: string; start: number; end: number }>;
		}

		it("handles nested objects", () => {
			const initial: EditorConfig = {
				background: { type: "solid", color: "#ffffff" },
				segments: [],
			};
			let state = createHistoryState(initial);
			state = set(state, {
				...state.present,
				background: { type: "solid", color: "#000000" },
			});
			expect(state.present.background.color).toBe("#000000");
			state = undo(state);
			expect(state.present.background.color).toBe("#ffffff");
		});

		it("handles array modifications", () => {
			const initial: EditorConfig = {
				background: { type: "solid", color: "#ffffff" },
				segments: [{ id: "1", start: 0, end: 10 }],
			};
			let state = createHistoryState(initial);
			state = set(state, {
				...state.present,
				segments: [...state.present.segments, { id: "2", start: 10, end: 20 }],
			});
			expect(state.present.segments.length).toBe(2);
			state = undo(state);
			expect(state.present.segments.length).toBe(1);
		});
	});

	describe("batch operations", () => {
		const batchStart: { value: number } | null = null;

		function startBatch<T>(state: HistoryState<T>): {
			state: HistoryState<T>;
			batchStart: T;
		} {
			return { state, batchStart: state.present };
		}

		function setWithoutHistory<T>(
			state: HistoryState<T>,
			newPresent: T | ((prev: T) => T),
		): HistoryState<T> {
			const resolvedPresent =
				typeof newPresent === "function"
					? (newPresent as (prev: T) => T)(state.present)
					: newPresent;

			return {
				past: state.past,
				present: resolvedPresent,
				future: state.future,
			};
		}

		function commitBatch<T>(
			state: HistoryState<T>,
			batchStart: T | null,
			maxHistory = 50,
		): HistoryState<T> {
			if (batchStart === null) return state;
			if (batchStart === state.present) return state;
			return {
				past: [...state.past.slice(-(maxHistory - 1)), batchStart],
				present: state.present,
				future: [],
			};
		}

		it("batch creates single history entry for multiple updates", () => {
			let state = createHistoryState({ value: 1 });
			const batch = startBatch(state);
			state = batch.state;
			const savedBatchStart = batch.batchStart;

			state = setWithoutHistory(state, { value: 2 });
			state = setWithoutHistory(state, { value: 3 });
			state = setWithoutHistory(state, { value: 4 });

			expect(state.past.length).toBe(0);
			expect(state.present).toEqual({ value: 4 });

			state = commitBatch(state, savedBatchStart);

			expect(state.past.length).toBe(1);
			expect(state.past[0]).toEqual({ value: 1 });
			expect(state.present).toEqual({ value: 4 });
		});

		it("undo after batch restores pre-batch state", () => {
			let state = createHistoryState({ value: 1 });
			const batch = startBatch(state);
			const savedBatchStart = batch.batchStart;

			state = setWithoutHistory(state, { value: 5 });
			state = setWithoutHistory(state, { value: 10 });
			state = commitBatch(state, savedBatchStart);

			expect(state.present).toEqual({ value: 10 });

			state = undo(state);
			expect(state.present).toEqual({ value: 1 });
		});

		it("commit without changes does not add history entry", () => {
			let state = createHistoryState({ value: 1 });
			const batch = startBatch(state);
			const savedBatchStart = batch.batchStart;

			state = commitBatch(state, savedBatchStart);

			expect(state.past.length).toBe(0);
		});

		it("commit with null batchStart does nothing", () => {
			let state = createHistoryState({ value: 1 });
			state = set(state, { value: 2 });

			const beforeCommit = { ...state };
			state = commitBatch(state, null);

			expect(state.past).toEqual(beforeCommit.past);
			expect(state.present).toEqual(beforeCommit.present);
		});

		it("batch can be used for drag operations", () => {
			let state = createHistoryState({ start: 0, end: 10 });
			const batch = startBatch(state);
			const savedBatchStart = batch.batchStart;

			state = setWithoutHistory(state, { start: 1, end: 10 });
			state = setWithoutHistory(state, { start: 2, end: 10 });
			state = setWithoutHistory(state, { start: 3, end: 10 });
			state = setWithoutHistory(state, { start: 4, end: 10 });

			state = commitBatch(state, savedBatchStart);

			expect(state.past.length).toBe(1);
			expect(state.past[0]).toEqual({ start: 0, end: 10 });
			expect(state.present).toEqual({ start: 4, end: 10 });

			state = undo(state);
			expect(state.present).toEqual({ start: 0, end: 10 });

			state = redo(state);
			expect(state.present).toEqual({ start: 4, end: 10 });
		});

		it("batch respects maxHistory limit", () => {
			let state = createHistoryState(0);
			for (let i = 1; i <= 5; i++) {
				state = set(state, i);
			}
			expect(state.past.length).toBe(5);

			const batch = startBatch(state);
			const savedBatchStart = batch.batchStart;

			state = setWithoutHistory(state, 100);
			state = commitBatch(state, savedBatchStart, 5);

			expect(state.past.length).toBe(5);
			expect(state.past).toEqual([1, 2, 3, 4, 5]);
			expect(state.present).toBe(100);
		});
	});

	describe("edge cases", () => {
		it("handles rapid undo/redo cycles", () => {
			let state = createHistoryState(0);
			for (let i = 1; i <= 5; i++) {
				state = set(state, i);
			}
			for (let i = 0; i < 10; i++) {
				if (canUndo(state)) state = undo(state);
				if (canRedo(state)) state = redo(state);
			}
			expect(state.present).toBeGreaterThanOrEqual(0);
			expect(state.present).toBeLessThanOrEqual(5);
		});

		it("handles undo at boundary", () => {
			let state = createHistoryState(0);
			state = set(state, 1);
			state = undo(state);
			const result = undo(state);
			expect(result).toBe(state);
		});

		it("handles redo at boundary", () => {
			let state = createHistoryState(0);
			state = set(state, 1);
			const result = redo(state);
			expect(result).toBe(state);
		});

		it("preserves referential equality when no-op", () => {
			const state = createHistoryState({ value: 1 });
			const afterUndo = undo(state);
			const afterRedo = redo(state);
			expect(afterUndo).toBe(state);
			expect(afterRedo).toBe(state);
		});
	});
});
