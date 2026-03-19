import { createEventListener } from "@solid-primitives/event-listener";

export type ShortcutBinding = {
	combo: string; // e.g. "Mod+=", "Mod+-", "Space", "S", "C"
	handler: (e: KeyboardEvent) => void | Promise<void>;
	preventDefault?: boolean; // default: true
	when?: () => boolean; // optional enablement gate
};

const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey; // treat Cmd/Ctrl as Mod

function normalizeCombo(e: KeyboardEvent): string {
	const parts: string[] = [];
	if (isMod(e)) parts.push("Mod");

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
		// Basic guards
		if (!getScopeActive()) return;
		if (e.repeat) return;

		const binding = map.get(normalizeCombo(e));
		if (!binding) return;
		if (binding.when && !binding.when()) return;

		if (binding.preventDefault !== false) e.preventDefault();

		await binding.handler(e);
	});
}
