export type CapturedTabInputEvent =
	| {
			kind: "move" | "down" | "up";
			epochMs: number;
			x: number;
			y: number;
			cursor: string;
			button: number;
			modifiers: string[];
	  }
	| {
			kind: "keyDown" | "keyUp";
			epochMs: number;
			key: string;
			code: string;
			modifiers: string[];
	  };

export type CapturedTabInputBatch = {
	target: "offscreen";
	type: "input-events-batch";
	recordingId: string;
	collectorId: string;
	sequence: number;
	platform: string;
	viewportWidth: number;
	viewportHeight: number;
	events: CapturedTabInputEvent[];
};

const CURSORS = new Set([
	"auto",
	"default",
	"pointer",
	"text",
	"crosshair",
	"grab",
	"grabbing",
	"not-allowed",
	"ew-resize",
	"ns-resize",
]);
const MODIFIERS = new Set(["Meta", "LControl", "LAlt", "LShift"]);
const SAFE_KEY_CODES: Record<string, readonly string[]> = {
	Escape: ["Escape"],
	Enter: ["Enter", "NumpadEnter"],
	Tab: ["Tab"],
	Backspace: ["Backspace"],
	Delete: ["Delete"],
	ArrowUp: ["ArrowUp"],
	ArrowDown: ["ArrowDown"],
	ArrowLeft: ["ArrowLeft"],
	ArrowRight: ["ArrowRight"],
	Home: ["Home"],
	End: ["End"],
	PageUp: ["PageUp"],
	PageDown: ["PageDown"],
	Shift: ["ShiftLeft", "ShiftRight"],
	Control: ["ControlLeft", "ControlRight"],
	Alt: ["AltLeft", "AltRight"],
	Meta: ["MetaLeft", "MetaRight"],
};

export function isSafeTabKeyboardEvent(key: string, code: string) {
	const codes = SAFE_KEY_CODES[key];
	return codes
		? codes.includes(code)
		: key === code && /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validModifiers(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 4 &&
		value.every((modifier) =>
			typeof modifier === "string" ? MODIFIERS.has(modifier) : false,
		)
	);
}

function validEvent(value: unknown): value is CapturedTabInputEvent {
	if (!isRecord(value) || !Number.isFinite(value.epochMs)) return false;
	if (!validModifiers(value.modifiers)) return false;
	if (value.kind === "move" || value.kind === "down" || value.kind === "up") {
		return (
			Number.isFinite(value.x) &&
			Number.isFinite(value.y) &&
			Number(value.x) >= -1 &&
			Number(value.x) <= 2 &&
			Number(value.y) >= -1 &&
			Number(value.y) <= 2 &&
			typeof value.cursor === "string" &&
			CURSORS.has(value.cursor) &&
			Number.isInteger(value.button) &&
			Number(value.button) >= 0 &&
			Number(value.button) <= 4
		);
	}
	return (
		(value.kind === "keyDown" || value.kind === "keyUp") &&
		typeof value.key === "string" &&
		value.key.length <= 64 &&
		typeof value.code === "string" &&
		value.code.length <= 64 &&
		isSafeTabKeyboardEvent(value.key, value.code)
	);
}

export function parseCapturedTabInputBatch(
	value: unknown,
): CapturedTabInputBatch | null {
	if (!isRecord(value)) return null;
	if (
		value.target !== "offscreen" ||
		value.type !== "input-events-batch" ||
		typeof value.recordingId !== "string" ||
		value.recordingId.length < 1 ||
		value.recordingId.length > 100 ||
		typeof value.collectorId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			value.collectorId,
		) ||
		!Number.isSafeInteger(value.sequence) ||
		Number(value.sequence) < 0 ||
		typeof value.platform !== "string" ||
		value.platform.length < 1 ||
		value.platform.length > 64 ||
		!Number.isSafeInteger(value.viewportWidth) ||
		Number(value.viewportWidth) < 1 ||
		Number(value.viewportWidth) > 100_000 ||
		!Number.isSafeInteger(value.viewportHeight) ||
		Number(value.viewportHeight) < 1 ||
		Number(value.viewportHeight) > 100_000 ||
		!Array.isArray(value.events) ||
		value.events.length < 1 ||
		value.events.length > 128 ||
		!value.events.every(validEvent)
	) {
		return null;
	}
	return value as CapturedTabInputBatch;
}
