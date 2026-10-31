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

// A keyup can arrive without its modifier (Ctrl released first), so keyup only acts on keys the player handled on keydown.
export function createHandledKeyTracker() {
	let handled: string | null = null;
	return {
		down(key: string) {
			handled = key;
		},
		up(key: string) {
			const matches = handled === key;
			if (matches) handled = null;
			return matches;
		},
	};
}
