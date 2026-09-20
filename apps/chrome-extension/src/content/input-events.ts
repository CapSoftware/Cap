import {
	type CapturedTabInputEvent,
	isSafeTabKeyboardEvent,
} from "../shared/input-events";
import { RECORDING_STATE_KEY } from "../shared/storage-keys";

const MOVE_INTERVAL_MS = 16;
const BATCH_INTERVAL_MS = 250;
const MAX_BATCH_EVENTS = 128;
const MAX_PENDING_BATCHES = 8;
const OVERLAY_ROOT_ID = "cap-extension-recorder-overlay";
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);
const SENSITIVE_CONTROL_NAME =
	/\b(?:password|passcode|pin|otp|one[- ]time(?:[- ]code)?|cvv|cvc|credit card|card number|security code|secret)\b/i;
const SENSITIVE_FORM_FIELDS = `input[type="password"], input[autocomplete*="cc-"], input[autocomplete*="one-time-code"], input[name*="password" i], input[name="pin" i], input[name$="-pin" i], input[name$="_pin" i], input[name*="cvv" i], input[name*="cvc" i]`;
const ALLOWED_CURSORS = new Set([
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

export const createTabInputCollectorId = () => {
	const secureRandom = globalThis.crypto;
	if (typeof secureRandom?.randomUUID === "function") {
		return secureRandom.randomUUID();
	}
	if (typeof secureRandom?.getRandomValues !== "function") {
		throw new Error("Secure random source is unavailable");
	}
	const bytes = secureRandom.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const modifiersOf = (event: MouseEvent | KeyboardEvent) => {
	const modifiers: string[] = [];
	if (event.metaKey) modifiers.push("Meta");
	if (event.ctrlKey) modifiers.push("LControl");
	if (event.altKey) modifiers.push("LAlt");
	if (event.shiftKey) modifiers.push("LShift");
	return modifiers;
};

const isEditableTarget = (event: Event) =>
	event.composedPath().some((target) => {
		if (!(target instanceof HTMLElement)) return false;
		return (
			target.isContentEditable ||
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target instanceof HTMLSelectElement ||
			EDITABLE_ROLES.has(target.getAttribute("role") ?? "") ||
			target.hasAttribute("aria-multiline")
		);
	});

const isSensitivePointerTarget = (event: PointerEvent) =>
	isEditableTarget(event) ||
	event.composedPath().some((target) => {
		if (!(target instanceof HTMLElement)) return false;
		if (
			target instanceof HTMLIFrameElement ||
			target.hasAttribute("data-private") ||
			target.hasAttribute("data-sensitive") ||
			SENSITIVE_CONTROL_NAME.test(
				`${target.getAttribute("aria-label") ?? ""} ${target.getAttribute("title") ?? ""} ${target.getAttribute("name") ?? ""}`,
			)
		)
			return true;
		if (target instanceof HTMLLabelElement && target.control) {
			return (
				target.control instanceof HTMLInputElement ||
				target.control instanceof HTMLTextAreaElement ||
				target.control instanceof HTMLSelectElement
			);
		}
		return (
			target instanceof HTMLFormElement &&
			target.querySelector(SENSITIVE_FORM_FIELDS) !== null
		);
	});

const isExtensionUiEvent = (event: Event) =>
	event
		.composedPath()
		.some(
			(target) => target instanceof Element && target.id === OVERLAY_ROOT_ID,
		);

export function initTabInputCapture() {
	let recordingId: string | null = null;
	let batch: CapturedTabInputEvent[] = [];
	let pendingBatches = 0;
	let sendChain: Promise<void> = Promise.resolve();
	let sendFailed: Error | null = null;
	let sequence = 0;
	let collectorId = "";
	let timer: number | null = null;
	let lastMoveAt = -Infinity;
	let lastTarget: EventTarget | null = null;
	let lastCursor = "default";
	let viewportWidth = window.innerWidth;
	let viewportHeight = window.innerHeight;

	const stopListeners = () => {
		recordingId = null;
		if (timer !== null) window.clearInterval(timer);
		timer = null;
		document.removeEventListener("pointermove", onMove, true);
		document.removeEventListener("pointerdown", onDown, true);
		document.removeEventListener("pointerup", onUp, true);
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("keyup", onKeyUp, true);
	};

	const stop = async () => {
		flush();
		stopListeners();
		await sendChain;
		return sendFailed ? { ok: false, error: sendFailed.message } : { ok: true };
	};

	const flush = () => {
		if (!recordingId || batch.length === 0 || sendFailed) return;
		if (pendingBatches >= MAX_PENDING_BATCHES) {
			sendFailed = new Error("Tab input event queue exceeded its limit");
			stopListeners();
			return;
		}
		const events = batch;
		batch = [];
		pendingBatches += 1;
		const message = {
			target: "offscreen",
			type: "input-events-batch",
			recordingId,
			collectorId,
			sequence: sequence++,
			platform: navigator.platform,
			viewportWidth,
			viewportHeight,
			events,
		};
		const pending = sendChain.then(() => {
			if (sendFailed) throw sendFailed;
			return new Promise<void>((resolve, reject) => {
				chrome.runtime.sendMessage(message, (response: unknown) => {
					const error = chrome.runtime.lastError;
					if (error) {
						reject(new Error(error.message ?? "Tab input upload failed"));
						return;
					}
					if (
						!response ||
						typeof response !== "object" ||
						!("ok" in response) ||
						response.ok !== true
					) {
						reject(new Error("Tab input batch was not accepted"));
						return;
					}
					resolve();
				});
			});
		});
		sendChain = pending.then(
			() => {
				pendingBatches -= 1;
			},
			(error: unknown) => {
				pendingBatches -= 1;
				sendFailed = error instanceof Error ? error : new Error(String(error));
				stopListeners();
			},
		);
	};

	const push = (event: CapturedTabInputEvent) => {
		if (!recordingId) return;
		if (
			window.innerWidth !== viewportWidth ||
			window.innerHeight !== viewportHeight
		) {
			flush();
			viewportWidth = window.innerWidth;
			viewportHeight = window.innerHeight;
		}
		batch.push(event);
		if (batch.length >= MAX_BATCH_EVENTS) flush();
	};

	const pointer = (
		kind: "move" | "down" | "up",
		event: PointerEvent,
		forceMove = false,
	) => {
		if (
			!recordingId ||
			!event.isTrusted ||
			isExtensionUiEvent(event) ||
			isSensitivePointerTarget(event) ||
			window.innerWidth <= 0 ||
			window.innerHeight <= 0
		)
			return;
		const epochMs = performance.timeOrigin + event.timeStamp;
		if (
			kind === "move" &&
			!forceMove &&
			epochMs - lastMoveAt < MOVE_INTERVAL_MS
		)
			return;
		if (kind === "move") lastMoveAt = epochMs;
		if (event.target !== lastTarget) {
			lastTarget = event.target;
			const cursor =
				event.target instanceof Element
					? getComputedStyle(event.target).cursor
					: "default";
			lastCursor = ALLOWED_CURSORS.has(cursor) ? cursor : "default";
		}
		push({
			kind,
			epochMs,
			x: event.clientX / window.innerWidth,
			y: event.clientY / window.innerHeight,
			cursor: lastCursor,
			button: event.button < 0 ? 0 : event.button,
			modifiers: modifiersOf(event),
		});
	};
	const onMove = (event: PointerEvent) => pointer("move", event);
	const onDown = (event: PointerEvent) => {
		pointer("move", event, true);
		pointer("down", event);
	};
	const onUp = (event: PointerEvent) => pointer("up", event);
	const key = (kind: "keyDown" | "keyUp", event: KeyboardEvent) => {
		if (
			!recordingId ||
			!event.isTrusted ||
			isExtensionUiEvent(event) ||
			isEditableTarget(event) ||
			!isSafeTabKeyboardEvent(event.key, event.code)
		)
			return;
		push({
			kind,
			epochMs: performance.timeOrigin + event.timeStamp,
			key: event.key,
			code: event.code,
			modifiers: modifiersOf(event),
		});
	};
	const onKeyDown = (event: KeyboardEvent) => key("keyDown", event);
	const onKeyUp = (event: KeyboardEvent) => key("keyUp", event);

	const start = async (nextRecordingId: string) => {
		if (recordingId === nextRecordingId) return { ok: true };
		if (recordingId) await stop();
		recordingId = nextRecordingId;
		collectorId = createTabInputCollectorId();
		batch = [];
		pendingBatches = 0;
		sendChain = Promise.resolve();
		sendFailed = null;
		sequence = 0;
		lastMoveAt = -Infinity;
		lastTarget = null;
		viewportWidth = window.innerWidth;
		viewportHeight = window.innerHeight;
		document.addEventListener("pointermove", onMove, {
			capture: true,
			passive: true,
		});
		document.addEventListener("pointerdown", onDown, {
			capture: true,
			passive: true,
		});
		document.addEventListener("pointerup", onUp, {
			capture: true,
			passive: true,
		});
		document.addEventListener("keydown", onKeyDown, {
			capture: true,
			passive: true,
		});
		document.addEventListener("keyup", onKeyUp, {
			capture: true,
			passive: true,
		});
		timer = window.setInterval(flush, BATCH_INTERVAL_MS);
		return { ok: true };
	};

	chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
		if (!message || typeof message !== "object" || !("type" in message))
			return false;
		if (
			message.type === "input-capture-start" &&
			"recordingId" in message &&
			typeof message.recordingId === "string"
		) {
			void start(message.recordingId).then(respond);
		} else if (message.type === "input-capture-stop") {
			void stop().then(respond);
		} else {
			return false;
		}
		return true;
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "session" || !recordingId) return;
		const state = changes[RECORDING_STATE_KEY]?.newValue;
		if (!state || typeof state !== "object" || !("status" in state)) return;
		const status = state.status;
		if (!status || typeof status !== "object" || !("phase" in status)) return;
		if (status.phase !== "recording" && status.phase !== "paused") void stop();
	});
	window.addEventListener("pagehide", () => void stop());
}
