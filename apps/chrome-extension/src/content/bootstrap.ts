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
const INSTALLED_ATTRIBUTE = "data-cap-chrome-extension-installed";
const READY_EVENT = "cap-chrome-extension-ready";
const OPEN_EVENT = "cap-chrome-extension-open";
// Mirrors of the overlay module's own constants (the bootstrap must stay a
// few KB, so it cannot import them): the root the overlay mounts under and
// the DOM event that makes a previous generation unmount cleanly.
const OVERLAY_ROOT_ID = "cap-extension-recorder-overlay";
const OVERLAY_TEARDOWN_EVENT = "cap-extension-overlay-teardown";

const isCapWebOrigin = () => {
	const { hostname, protocol } = window.location;
	if (protocol !== "http:" && protocol !== "https:") return false;

	return (
		hostname === "cap.so" ||
		hostname.endsWith(".cap.so") ||
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1"
	);
};

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

const bootstrap = (isCurrent: () => boolean) => {
	// The query string forces a fresh module per injection: after a takeover,
	// importing the bare URL would return the cached orphan copy, whose
	// `initialized` guard makes init() a silent no-op — the tab would keep
	// acknowledging messages while never mounting UI again. A fresh copy's
	// mountOverlay already tears down any previous tree via the DOM-level
	// teardown event, so generations hand over cleanly.
	const overlayModuleUrl = `${chrome.runtime.getURL(
		"content/overlay.js",
	)}?instance=${Date.now().toString(36)}`;
	// Messages acknowledged while the overlay module is still being fetched.
	// init() hands them to the module, whose components replay them on mount,
	// so the panel toggle or webcam settings push that triggered the lazy
	// load is not dropped.
	const pendingMessages: unknown[] = [];
	let modulePromise: Promise<void> | null = null;
	let moduleStarted = false;

	const detachListeners = () => {
		try {
			chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
			chrome.storage.onChanged.removeListener(handleStorageChange);
		} catch {
			// An orphaned instance has no extension context left to detach from.
		}
	};

	const startOverlayModule = () => {
		if (!isCurrent()) return Promise.resolve();
		modulePromise ??= import(/* @vite-ignore */ overlayModuleUrl)
			.then((module: OverlayModule) => {
				if (!isCurrent()) return;
				moduleStarted = true;
				// The module registers its own runtime and storage listeners;
				// from here the bootstrap goes dormant. Messages arriving in the
				// brief window before the module's listeners mount are covered by
				// the service worker's send retries and the storage mirror.
				detachListeners();
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
		if (!isCurrent()) {
			detachListeners();
			return;
		}
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
		if (!isCurrent()) {
			// A newer injection owns this tab; go silent so only it acknowledges.
			detachListeners();
			return false;
		}
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

	// A previous generation's UI may still be in the DOM: its embedded
	// extension iframes died with the old instance (a black camera bubble, a
	// dead panel), the extension reload wiped the session state that would
	// have triggered a fresh mount, and the old watcher sees a revived
	// chrome object so it never self-destructs. Sweep it here — the wake
	// checks below remount fresh UI whenever current state warrants it.
	const staleRoot = document.getElementById(OVERLAY_ROOT_ID);
	if (staleRoot) {
		staleRoot.dispatchEvent(new Event(OVERLAY_TEARDOWN_EVENT));
		staleRoot.remove();
	}

	if (isCapWebOrigin()) {
		document.documentElement.setAttribute(INSTALLED_ATTRIBUTE, "true");
		window.dispatchEvent(new CustomEvent(READY_EVENT));
		window.addEventListener(OPEN_EVENT, () => {
			// DOM listeners outlive the extension context that registered them:
			// after a takeover the current copy answers this event, and an
			// orphan with no successor must fail silently rather than throw
			// "Extension context invalidated" into the page console.
			if (!isCurrent()) return;
			try {
				chrome.runtime.sendMessage(
					{ target: "service-worker", type: "open-recorder-panel" },
					() => {
						void chrome.runtime.lastError;
					},
				);
			} catch {
				// Orphaned context; the event is lost until re-injection.
			}
		});
	}

	// One cheap session-storage read decides whether this page needs UI right
	// away: a recording in progress or the recorder panel open (the panel
	// follows the user across tabs).
	try {
		chrome.storage.session.get(
			[RECORDING_STATE_KEY, SHARED_UI_STATE_KEY],
			(items) => {
				if (!isCurrent()) return;
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
// world: before messaging tabs that predate the extension, and again after
// an extension reload or update orphans the previous copy (its chrome.*
// listeners die, but its flag and DOM listeners survive). Deferring to a
// boolean flag therefore left such tabs permanently unable to answer the
// service worker. Instead every run claims the tab with a fresh token and
// earlier instances detect the takeover and go silent — the token check
// needs no extension context, which is exactly what orphans have lost.
const globalScope = globalThis as Record<string, unknown>;
const instanceToken: object = {};
globalScope[BOOTSTRAP_FLAG] = instanceToken;
bootstrap(() => globalScope[BOOTSTRAP_FLAG] === instanceToken);
