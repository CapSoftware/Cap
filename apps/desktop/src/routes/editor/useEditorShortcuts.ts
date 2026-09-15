import { createEventListener } from "@solid-primitives/event-listener";

export type ShortcutBinding = {
	combo: string;
	handler: (e: KeyboardEvent) => void | Promise<void>;
	preventDefault?: boolean;
	when?: () => boolean;
};

const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

export function normalizeCombo(e: KeyboardEvent): string {
	const parts: string[] = [];
	if (isMod(e)) parts.push("Mod");
	if (e.altKey) parts.push("Alt");
	if (e.shiftKey) parts.push("Shift");

	let key: string;
	switch (e.code) {
		case "Equal":
			key = "=";
			break;
		case "Minus":
			key = "-";
			break;
		default:
			key = e.code.startsWith("Key") ? e.code.slice(3) : e.code;
	}

	parts.push(key);
	return parts.join("+");
}

export function useEditorShortcuts(
	getScopeActive: () => boolean,
	bindings: ShortcutBinding[],
) {
	const map = new Map<string, ShortcutBinding>(
		bindings.map((b) => [b.combo, b]),
	);

	createEventListener(document, "keydown", async (e: KeyboardEvent) => {
		if (!getScopeActive()) return;
		if (e.repeat) return;

		const binding = map.get(normalizeCombo(e));
		if (!binding) return;
		if (binding.when && !binding.when()) return;

		if (binding.preventDefault !== false) e.preventDefault();

		await binding.handler(e);
	});
}
