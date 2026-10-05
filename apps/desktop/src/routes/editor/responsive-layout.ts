import { type Accessor, createRoot, createSignal } from "solid-js";

const isWebEditor = import.meta.env.VITE_CAP_WEB_EDITOR === "true";

// Keep these in step with web-layout.css, which keys off the attributes they
// set on <html> (popovers portal out of the editor, so the root is the one
// element everything shares).
//
// Below 1024px wide the settings sidebar becomes a sheet over the timeline.
const COMPACT_QUERY = "(max-width: 1023.98px)";
// Phones, held either way up: the player's toolbar folds into the sheet's bar
// and the timeline's track names fold to their icons.
const PHONE_QUERY =
	"(max-width: 639.98px), (max-width: 1023.98px) and (max-height: 499.98px)";

export type EditorLayout = {
	/** The web editor below 1024px wide. Always false in the desktop app. */
	compact: Accessor<boolean>;
	/** A phone-sized compact layout, either way up. */
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

/**
 * The web editor's layout size class, read from media queries rather than
 * measured, so it never waits on (or causes) a layout. The desktop app keeps
 * its one layout at every size.
 */
export function editorLayout(): EditorLayout {
	if (shared) return shared;
	if (!isWebEditor || typeof window === "undefined" || !window.matchMedia) {
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
