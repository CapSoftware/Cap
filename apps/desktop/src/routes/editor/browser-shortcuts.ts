type ShortcutKey = Pick<
	KeyboardEvent,
	"metaKey" | "ctrlKey" | "altKey" | "key"
>;

/**
 * Whether a key press belongs to the browser rather than the editor: reload,
 * hard reload, find, close or switch tab, the address bar, or a function key.
 * The web editor never cancels these, even while it is still preparing and
 * swallowing everything else, so Cmd+R and Cmd+Shift+R always reload.
 */
export const isBrowserShortcut = (event: ShortcutKey): boolean =>
	event.metaKey || event.ctrlKey || /^F([1-9]|1[0-9]|2[0-4])$/.test(event.key);
