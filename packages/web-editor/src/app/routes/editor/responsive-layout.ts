import { type Accessor, createRoot, createSignal } from "solid-js";

// Keep in step with web-layout.css. The attributes go on <html> because
// popovers portal out of the editor's own root.
const COMPACT_QUERY = "(max-width: 1023.98px)";
const PHONE_QUERY =
	"(max-width: 639.98px), (max-width: 1023.98px) and (max-height: 499.98px)";

export type EditorLayout = {
	compact: Accessor<boolean>;
	phone: Accessor<boolean>;
};

let shared: EditorLayout | undefined;

function mediaSignal(query: string, attribute: string): Accessor<boolean> {
	const list = window.matchMedia(query);
	const [matches, setMatches] = createSignal(list.matches);
	const root = document.documentElement;
	const apply = (value: boolean) => {
		if (value) root.setAttribute(attribute, "");
		else root.removeAttribute(attribute);
		setMatches(value);
	};
	apply(list.matches);
	list.addEventListener("change", (event) => apply(event.matches));
	return matches;
}

export function editorLayout(): EditorLayout {
	if (shared) return shared;
	if (typeof window === "undefined" || !window.matchMedia) {
		shared = { compact: () => false, phone: () => false };
		return shared;
	}
	document.documentElement.setAttribute("data-web-editor", "");
	shared = createRoot(() => ({
		compact: mediaSignal(COMPACT_QUERY, "data-editor-compact"),
		phone: mediaSignal(PHONE_QUERY, "data-editor-phone"),
	}));
	return shared;
}

const TAP_SLOP_PX = 6;

export function tapOpensSheet(tap: {
	selectionBefore: string;
	selectionAfter: string;
	distance: number;
	onTrackLane: boolean;
}) {
	if (!tap.selectionAfter || tap.distance > TAP_SLOP_PX) return false;
	return tap.selectionAfter !== tap.selectionBefore || tap.onTrackLane;
}
