import {
	isOverlayMessage,
	isRecordingStatusBroadcast,
} from "../shared/messages";
import {
	RECORDING_STATE_KEY,
	SHARED_UI_STATE_KEY,
} from "../shared/storage-keys";

// The manifest injects only this bootstrap into every page: a few KB of
// vanilla code that decides whether the page actually needs the recorder UI.
// The full overlay/recording-bar bundle (React, icons, ~250KB) is an ES
// module listed in web_accessible_resources and is dynamically imported only
// once recording state or a service-worker message says this tab should show
// something. Plain page loads must stay cheap: reading chrome.storage does
// not wake the MV3 service worker, so the bootstrap never sends runtime
// messages of its own.

type OverlayModule = {
	init: (startupMessages: readonly unknown[]) => void;
};

// The phases for which the floating UI (recording bar, camera preview)
// renders. Every other phase needs no UI until a message or a storage change
// says otherwise: "error" reopens the recorder panel through the shared UI
// state's panelOpen flag, which is watched below.
const UI_PHASES = new Set(["creating", "recording", "paused"]);

const BOOTSTRAP_FLAG = "__capExtensionContentBootstrap";

const readPhase = (value: unknown): string | null => {
	if (!value || typeof value !== "object") return null;
	const status = (value as { status?: unknown }).status;
	if (!status || typeof status !== "object") return null;
	const phase = (status as { phase?: unknown }).phase;
	return typeof phase === "string" ? phase : null;
};

const isUiPhase = (value: unknown) => {
	const phase = readPhase(value);
	return phase !== null && UI_PHASES.has(phase);
};

const readPanelOpen = (value: unknown): boolean =>
	!!value &&
	typeof value === "object" &&
	(value as { panelOpen?: unknown }).panelOpen === true;

const bootstrap = () => {
	const overlayModuleUrl = chrome.runtime.getURL("content/overlay.js");
	// Messages acknowledged while the overlay module is still being fetched.
	// init() hands them to the module, whose components replay them on mount,
	// so the panel toggle or webcam settings push that triggered the lazy
	// load is not dropped.
	const pendingMessages: unknown[] = [];
	let modulePromise: Promise<void> | null = null;
	let moduleStarted = false;

	const startOverlayModule = () => {
		modulePromise ??= import(/* @vite-ignore */ overlayModuleUrl)
			.then((module: OverlayModule) => {
				moduleStarted = true;
				// The module registers its own runtime and storage listeners;
				// from here the bootstrap goes dormant. Messages arriving in the
				// brief window before the module's listeners mount are covered by
				// the service worker's send retries and the storage mirror.
				chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
				chrome.storage.onChanged.removeListener(handleStorageChange);
				module.init(pendingMessages);
			})
			.catch(() => {
				// Leave the trigger listeners armed so a later signal retries.
				modulePromise = null;
			});
		return modulePromise;
	};

	const handleStorageChange = (
		changes: Record<string, chrome.storage.StorageChange>,
		areaName: string,
	) => {
		if (areaName !== "session") return;
		if (
			isUiPhase(changes[RECORDING_STATE_KEY]?.newValue) ||
			readPanelOpen(changes[SHARED_UI_STATE_KEY]?.newValue)
		) {
			void startOverlayModule();
		}
	};

	const handleRuntimeMessage = (
		message: unknown,
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void,
	) => {
		if (moduleStarted) return false;

		if (isOverlayMessage(message)) {
			// Acknowledge like the full overlay does so the service worker's
			// delivery check (and its inject-and-retry fallback) sees this tab
			// as alive.
			sendResponse({ ok: true });
			if (
				message.type === "overlay-hide" ||
				message.type === "overlay-enter-auto-pip" ||
				message.type === "overlay-exit-auto-pip"
			) {
				// Nothing is mounted, so there is nothing to hide or to move
				// into Picture in Picture; loading the UI just to no-op is waste.
				return false;
			}
			pendingMessages.push(message);
			void startOverlayModule();
			return false;
		}

		if (
			isRecordingStatusBroadcast(message) &&
			UI_PHASES.has(message.status.phase)
		) {
			pendingMessages.push(message);
			void startOverlayModule();
		}

		return false;
	};

	chrome.runtime.onMessage.addListener(handleRuntimeMessage);
	chrome.storage.onChanged.addListener(handleStorageChange);

	// One cheap session-storage read decides whether this page needs UI right
	// away: a recording in progress or the recorder panel open (the panel
	// follows the user across tabs).
	try {
		chrome.storage.session.get(
			[RECORDING_STATE_KEY, SHARED_UI_STATE_KEY],
			(items) => {
				if (chrome.runtime.lastError || !items) return;
				if (
					isUiPhase(items[RECORDING_STATE_KEY]) ||
					readPanelOpen(items[SHARED_UI_STATE_KEY])
				) {
					void startOverlayModule();
				}
			},
		);
	} catch {
		// Session storage access is widened by the service worker on startup;
		// until that has happened there is no recording state to show either.
	}
};

// chrome.scripting.executeScript re-runs this file in the same isolated
// world (the service worker injects it before messaging tabs that predate
// the extension), so a second execution must not stack duplicate listeners
// or reload the overlay module.
const globalScope = globalThis as Record<string, unknown>;
if (globalScope[BOOTSTRAP_FLAG] !== true) {
	globalScope[BOOTSTRAP_FLAG] = true;
	bootstrap();
}
