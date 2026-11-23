type ShortcutKey = Pick<
	KeyboardEvent,
	"metaKey" | "ctrlKey" | "altKey" | "key"
>;

export const isBrowserShortcut = (event: ShortcutKey): boolean =>
	event.metaKey ||
	event.ctrlKey ||
	event.altKey ||
	/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key);
