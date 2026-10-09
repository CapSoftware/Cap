type ShortcutKey = Pick<
	KeyboardEvent,
	"metaKey" | "ctrlKey" | "altKey" | "key"
>;

/**
 * Whether a key press belongs to the browser rather than the editor: reload,
 * hard reload, find, close or switch tab, the address bar, Alt+Left/Right back
 * and forward, or a function key. The web editor never cancels these, even
 * while it is still preparing and swallowing everything else, so Cmd+R and
 * Cmd+Shift+R always reload. The editor has no Alt keyboard shortcuts (Alt only
 * turns off snapping while dragging), so Alt costs it nothing.
 */
export const isBrowserShortcut = (event: ShortcutKey): boolean =>
	event.metaKey ||
	event.ctrlKey ||
	event.altKey ||
	/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key);
