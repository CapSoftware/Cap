type ModifierEvent = Pick<
	KeyboardEvent,
	"metaKey" | "ctrlKey" | "altKey" | "getModifierState"
>;

// AltGr is reported as Ctrl+Alt, and some layouts type `<` and `>` with it.
export function hasBrowserShortcutModifier(event: ModifierEvent) {
	return (
		(event.metaKey || event.ctrlKey || event.altKey) &&
		!event.getModifierState("AltGraph")
	);
}
