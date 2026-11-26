export type SpaceVideoOrder = "newest" | "oldest" | "custom";

export const SPACE_VIDEO_ORDER_OPTIONS: ReadonlyArray<{
	value: SpaceVideoOrder;
	label: string;
}> = [
	{ value: "newest", label: "Newest first" },
	{ value: "oldest", label: "Oldest first" },
	{ value: "custom", label: "Custom order" },
];

export const DEFAULT_SPACE_VIDEO_ORDER: SpaceVideoOrder = "newest";

export const MAX_REORDER_ITEMS = 500;

export function isSpaceVideoOrder(value: unknown): value is SpaceVideoOrder {
	return value === "newest" || value === "oldest" || value === "custom";
}

export function spaceVideoOrderFromSettings(
	settings: { videoOrder?: unknown } | null | undefined,
): SpaceVideoOrder {
	return isSpaceVideoOrder(settings?.videoOrder)
		? settings.videoOrder
		: DEFAULT_SPACE_VIDEO_ORDER;
}

export type ReorderPlacement =
	| { type: "before"; targetId: string }
	| { type: "after"; targetId: string }
	| { type: "start" }
	| { type: "end" }
	| { type: "earlier" }
	| { type: "later" };

// Moves `movedIds` as one block, keeping their current relative order, to the
// placement. Ids that are not in the list are ignored; a target that is itself
// being moved resolves to the block's current slot.
export function reorderIds(
	orderedIds: readonly string[],
	movedIds: readonly string[],
	placement: ReorderPlacement,
): string[] {
	const moving = new Set(movedIds.filter((id) => orderedIds.includes(id)));
	if (moving.size === 0) return [...orderedIds];

	const block = orderedIds.filter((id) => moving.has(id));
	const rest = orderedIds.filter((id) => !moving.has(id));

	const firstMoved = orderedIds.findIndex((id) => moving.has(id));
	const blockStart = orderedIds
		.slice(0, firstMoved)
		.filter((id) => !moving.has(id)).length;

	let insertAt: number;
	if (placement.type === "earlier") insertAt = Math.max(0, blockStart - 1);
	else if (placement.type === "later")
		insertAt = Math.min(rest.length, blockStart + 1);
	else if (placement.type === "start") insertAt = 0;
	else if (placement.type === "end") insertAt = rest.length;
	else if (moving.has(placement.targetId)) insertAt = blockStart;
	else {
		const targetIndex = rest.indexOf(placement.targetId);
		if (targetIndex === -1) return [...orderedIds];
		insertAt = placement.type === "before" ? targetIndex : targetIndex + 1;
	}

	return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
}

// Positions are dense (0..n-1) in the new order. Only rows whose stored value
// differs are returned, so a move near the top of a large space rewrites a
// short range instead of the whole list.
export function positionChanges(
	current: ReadonlyArray<{ id: string; position: number | null }>,
	nextOrder: readonly string[],
): Array<{ id: string; position: number }> {
	const stored = new Map(current.map((row) => [row.id, row.position]));
	const changes: Array<{ id: string; position: number }> = [];
	nextOrder.forEach((id, position) => {
		if (stored.get(id) !== position) changes.push({ id, position });
	});
	return changes;
}

export function nextInOrder(
	orderedIds: readonly string[],
	currentId: string,
): string | null {
	const index = orderedIds.indexOf(currentId);
	if (index === -1) return null;
	return orderedIds[index + 1] ?? null;
}

// Alt+Left / Alt+Right on a focused card moves it one slot. Keys typed into a
// field inside the card (title and date editors, where Option+Arrow moves by
// word on macOS), inside a menu or dialog opened from it, or already handled
// never reorder.
export function reorderShortcutDirection(event: {
	key: string;
	altKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	defaultPrevented: boolean;
	target: EventTarget | null;
}): "earlier" | "later" | null {
	if (
		event.defaultPrevented ||
		!event.altKey ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey
	)
		return null;
	const direction =
		event.key === "ArrowLeft"
			? "earlier"
			: event.key === "ArrowRight"
				? "later"
				: null;
	if (!direction) return null;
	const target = event.target;
	if (typeof Element !== "undefined" && target instanceof Element) {
		if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return null;
		if (target instanceof HTMLElement && target.isContentEditable) return null;
		if (
			target.closest(
				'[contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
			)
		)
			return null;
	}
	return direction;
}
