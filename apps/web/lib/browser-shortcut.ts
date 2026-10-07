type ShortcutKey = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">;

/**
 * A key press with Cmd, Ctrl or Alt held belongs to the browser or the OS:
 * reload and hard reload, find, the address bar, tab switching, history. Page
 * shortcuts are single keys and must let every one of these through untouched.
 */
export const isBrowserShortcut = (event: ShortcutKey): boolean =>
	event.metaKey || event.ctrlKey || event.altKey;
