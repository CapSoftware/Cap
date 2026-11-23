export type IndexedSelectionType =
	| "style"
	| "image"
	| "waveform"
	| "zoom"
	| "clip"
	| "scene"
	| "mask"
	| "caption"
	| "keyboard"
	| "text"
	| "audio"
	| "3d";

export type SegmentSelection =
	| null
	| { type: "transition"; index: number }
	| { type: IndexedSelectionType; indices: number[] };

export type SegmentSelectModifiers = {
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
};

export function nextSegmentSelection(
	current: SegmentSelection,
	target: { type: IndexedSelectionType; index: number },
	modifiers: SegmentSelectModifiers,
): SegmentSelection {
	const same = current && current.type === target.type ? current : null;
	const existing = same && "indices" in same ? same.indices : null;

	if (modifiers.shiftKey && existing && existing.length > 0) {
		const last = existing[existing.length - 1] ?? target.index;
		const start = Math.min(last, target.index);
		const end = Math.max(last, target.index);
		const indices: number[] = [];
		for (let index = start; index <= end; index++) indices.push(index);
		return { type: target.type, indices };
	}

	if ((modifiers.ctrlKey || modifiers.metaKey) && existing) {
		const indices = existing.includes(target.index)
			? existing.filter((index) => index !== target.index)
			: [...existing, target.index];
		return indices.length > 0 ? { type: target.type, indices } : null;
	}

	return { type: target.type, indices: [target.index] };
}
