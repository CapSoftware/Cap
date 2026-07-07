import { TARGET } from "../platform/target";

const ARM_CANCEL_POLL_INTERVAL_MS = 150;

// Firefox requires transient user activation for getDisplayMedia, and this
// document is opened by the service worker without one; a click on the arm
// button inside this window is what carries the activation into capture.
// Chrome's offscreen document is exempt, so this resolves immediately there.
// The click is required for every mode (getUserMedia does not need it, but
// one uniform path keeps the permission prompts anchored to a focused,
// visible window).
export const awaitCaptureGesture = async (throwIfCanceled: () => void) => {
	if (TARGET !== "firefox") return;
	const container = document.getElementById("arm-capture");
	const button = document.getElementById("arm-capture-button");
	const idleState = document.getElementById("idle-state");
	if (
		!(container instanceof HTMLElement) ||
		!(button instanceof HTMLButtonElement)
	) {
		return;
	}

	if (idleState) idleState.hidden = true;
	container.hidden = false;
	// Belt and braces: if any code path brought this document up minimized
	// (e.g. a host created for device enumeration), surface it — a hidden arm
	// button would otherwise wait forever for a click no one can make.
	chrome.windows.getCurrent((currentWindow) => {
		if (chrome.runtime.lastError || currentWindow?.id === undefined) return;
		chrome.windows.update(
			currentWindow.id,
			{ state: "normal", focused: true },
			() => {
				void chrome.runtime.lastError;
			},
		);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const onClick = () => {
				window.clearInterval(intervalId);
				resolve();
			};
			const intervalId = window.setInterval(() => {
				try {
					throwIfCanceled();
				} catch (error) {
					window.clearInterval(intervalId);
					button.removeEventListener("click", onClick);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			}, ARM_CANCEL_POLL_INTERVAL_MS);
			button.addEventListener("click", onClick, { once: true });
		});
	} finally {
		container.hidden = true;
		if (idleState) idleState.hidden = false;
	}
};

// Once every capture prompt has been answered this window has no further
// business on screen; get it out of the shot (and out of the picker's way)
// before the countdown runs. Cosmetic, so callers fire-and-forget it.
export const minimizeRecorderWindow = async () => {
	if (TARGET !== "firefox") return;
	await new Promise<void>((resolve) => {
		chrome.windows.getCurrent((currentWindow) => {
			if (chrome.runtime.lastError || currentWindow?.id === undefined) {
				resolve();
				return;
			}
			chrome.windows.update(currentWindow.id, { state: "minimized" }, () => {
				void chrome.runtime.lastError;
				resolve();
			});
		});
	});
};
