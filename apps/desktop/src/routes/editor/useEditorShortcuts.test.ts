import { describe, expect, it } from "vitest";
import { normalizeCombo } from "./useEditorShortcuts";

function createKeyboardEvent(
	code: string,
	options: { metaKey?: boolean; ctrlKey?: boolean } = {},
): KeyboardEvent {
	return {
		code,
		metaKey: options.metaKey ?? false,
		ctrlKey: options.ctrlKey ?? false,
	} as KeyboardEvent;
}

describe("useEditorShortcuts: normalizeCombo", () => {
	it("normalizes navigation and boundary keys without modifiers", () => {
		expect(normalizeCombo(createKeyboardEvent("ArrowUp"))).toBe("ArrowUp");
		expect(normalizeCombo(createKeyboardEvent("ArrowDown"))).toBe("ArrowDown");
		expect(normalizeCombo(createKeyboardEvent("Home"))).toBe("Home");
		expect(normalizeCombo(createKeyboardEvent("End"))).toBe("End");
		expect(normalizeCombo(createKeyboardEvent("Space"))).toBe("Space");
	});

	it("strips Key prefix for standard letters", () => {
		expect(normalizeCombo(createKeyboardEvent("KeyS"))).toBe("S");
		expect(normalizeCombo(createKeyboardEvent("KeyC"))).toBe("C");
	});

	it("normalizes Mod modifier and special symbols", () => {
		expect(normalizeCombo(createKeyboardEvent("Equal", { metaKey: true }))).toBe("Mod+=");
		expect(normalizeCombo(createKeyboardEvent("Minus", { ctrlKey: true }))).toBe("Mod+-");
		expect(normalizeCombo(createKeyboardEvent("KeyS", { metaKey: true }))).toBe("Mod+S");
	});
});
