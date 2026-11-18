export type SelectionToggleInput<T> = {
	orderedIds: readonly T[];
	selected: readonly T[];
	anchorId: T | null;
	targetId: T;
	shiftKey: boolean;
};

export type SelectionToggleResult<T> = {
	selected: T[];
	anchorId: T;
};

// Shift-click follows the mail-client convention: the clicked item flips, and
// every item between it and the last plain click takes the same new state.
export function toggleSelection<T>({
	orderedIds,
	selected,
	anchorId,
	targetId,
	shiftKey,
}: SelectionToggleInput<T>): SelectionToggleResult<T> {
	const current = new Set(selected);
	const nextState = !current.has(targetId);
	const targetIndex = orderedIds.indexOf(targetId);
	const anchorIndex = anchorId === null ? -1 : orderedIds.indexOf(anchorId);

	const range =
		shiftKey && anchorIndex !== -1 && targetIndex !== -1
			? orderedIds.slice(
					Math.min(anchorIndex, targetIndex),
					Math.max(anchorIndex, targetIndex) + 1,
				)
			: [targetId];

	for (const id of range) {
		if (nextState) current.add(id);
		else current.delete(id);
	}

	const ordered = orderedIds.filter((id) => current.has(id));
	const offPage = selected.filter(
		(id) => current.has(id) && !orderedIds.includes(id),
	);

	return {
		selected: [...offPage, ...ordered],
		anchorId: targetId,
	};
}

export type PageSelectionState = "none" | "some" | "all";

export function pageSelectionState<T>(
	pageIds: readonly T[],
	selected: readonly T[],
): PageSelectionState {
	if (pageIds.length === 0) return "none";
	const current = new Set(selected);
	let count = 0;
	for (const id of pageIds) if (current.has(id)) count++;
	if (count === 0) return "none";
	return count === pageIds.length ? "all" : "some";
}

export function selectPage<T>(
	pageIds: readonly T[],
	selected: readonly T[],
): T[] {
	const current = new Set(selected);
	return [...selected, ...pageIds.filter((id) => !current.has(id))];
}

export function deselectPage<T>(
	pageIds: readonly T[],
	selected: readonly T[],
): T[] {
	const page = new Set(pageIds);
	return selected.filter((id) => !page.has(id));
}

export function isSelectionShortcutTarget(target: EventTarget | null) {
	if (!(target instanceof Element)) return true;
	if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return false;
	if (target instanceof HTMLElement && target.isContentEditable) return false;
	return !target.closest(
		'[role="dialog"], [role="alertdialog"], [role="menu"]',
	);
}
