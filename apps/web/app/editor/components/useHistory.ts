import { useCallback, useRef, useState } from "react";

interface HistoryState<T> {
	past: T[];
	present: T;
	future: T[];
}

export function useHistory<T>(initialState: T, maxHistory = 50) {
	const [state, setState] = useState<HistoryState<T>>({
		past: [],
		present: initialState,
		future: [],
	});
	const batchStartRef = useRef<T | null>(null);

	const set = useCallback(
		(newPresent: T | ((prev: T) => T)) => {
			setState(({ past, present }) => {
				const resolvedPresent =
					typeof newPresent === "function"
						? (newPresent as (prev: T) => T)(present)
						: newPresent;

				return {
					past: [...past.slice(-(maxHistory - 1)), present],
					present: resolvedPresent,
					future: [],
				};
			});
		},
		[maxHistory],
	);

	const setWithoutHistory = useCallback((newPresent: T | ((prev: T) => T)) => {
		setState(({ past, present, future }) => {
			const resolvedPresent =
				typeof newPresent === "function"
					? (newPresent as (prev: T) => T)(present)
					: newPresent;

			return {
				past,
				present: resolvedPresent,
				future,
			};
		});
	}, []);

	const undo = useCallback(() => {
		setState(({ past, present, future }) => {
			if (past.length === 0) return { past, present, future };
			const previous = past[past.length - 1]!;
			const newPast = past.slice(0, -1);
			return {
				past: newPast,
				present: previous,
				future: [present, ...future],
			};
		});
	}, []);

	const redo = useCallback(() => {
		setState(({ past, present, future }) => {
			if (future.length === 0) return { past, present, future };
			const next = future[0]!;
			const newFuture = future.slice(1);
			return {
				past: [...past, present],
				present: next,
				future: newFuture,
			};
		});
	}, []);

	const startBatch = useCallback(() => {
		setState((currentState) => {
			batchStartRef.current = currentState.present;
			return currentState;
		});
	}, []);

	const commitBatch = useCallback(() => {
		const batchStart = batchStartRef.current;
		if (batchStart === null) return;

		batchStartRef.current = null;
		setState(({ past, present, future }) => {
			if (batchStart === present) {
				return { past, present, future };
			}
			return {
				past: [...past.slice(-(maxHistory - 1)), batchStart],
				present,
				future: [],
			};
		});
	}, [maxHistory]);

	const cancelBatch = useCallback(() => {
		batchStartRef.current = null;
	}, []);

	const canUndo = state.past.length > 0;
	const canRedo = state.future.length > 0;

	return {
		state: state.present,
		set,
		setWithoutHistory,
		undo,
		redo,
		canUndo,
		canRedo,
		startBatch,
		commitBatch,
		cancelBatch,
	};
}
