import { TARGET } from "../platform/target";
import {
	isOverlayMessage,
	isRecordingStatusBroadcast,
} from "../shared/messages";
import { sendServiceWorkerMessage } from "../shared/runtime";
import {
	RECORDING_STATE_KEY,
	SHARED_STATE_AREA,
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

const bootstrap = () => {
	const overlayModuleUrl = chrome.runtime.getURL("content/overlay.js");
	// Messages acknowledged while the overlay module is still being fetched.
	// init() hands them to the module, whose components replay them on mount,
	// so the panel toggle or webcam settings push that triggered the lazy
	// load is not dropped.
	const pendingMessages: unknown[] = [];
	let modulePromise: Promise<void> | null = null;
	let moduleStarted = false;

	const loadOverlayModule = (): Promise<OverlayModule> => {
		if (TARGET !== "firefox") {
			return import(/* @vite-ignore */ overlayModuleUrl);
		}
		// Firefox content scripts cannot dynamic-import extension modules
		// (bugzilla 1536094). The Firefox build ships the overlay as a classic
		// IIFE exposing CapOverlay; ask the service worker to executeScript it
		// into this same isolated world. This is the one message the bootstrap
		// sends, and only once a tab actually needs UI.
		return sendServiceWorkerMessage({
			target: "service-worker",
			type: "inject-overlay-module",
		}).then((response) => {
			const module = (globalThis as { CapOverlay?: OverlayModule }).CapOverlay;
			if (response.ok && module) return module;
			throw new Error(
				("error" in response ? response.error : undefined) ??
					"Overlay module injection failed",
			);
		});
	};

	const startOverlayModule = () => {
		modulePromise ??= loadOverlayModule()
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
			.catch((error: unknown) => {
				// Leave the trigger listeners armed so a later signal retries. The
				// failure is otherwise invisible ("clicking the icon does nothing"),
				// so leave a trace for debugging.
				console.error("[cap] overlay module load failed", error);
				modulePromise = null;
			});
		return modulePromise;
	};

	const handleStorageChange = (
		changes: Record<string, chrome.storage.StorageChange>,
		areaName: string,
	) => {
		if (areaName !== SHARED_STATE_AREA) return;
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

	if (isCapWebOrigin()) {
		document.documentElement.setAttribute(INSTALLED_ATTRIBUTE, "true");
		window.dispatchEvent(new CustomEvent(READY_EVENT));
		window.addEventListener(OPEN_EVENT, () => {
			chrome.runtime.sendMessage(
				{ target: "service-worker", type: "open-recorder-panel" },
				() => {
					void chrome.runtime.lastError;
				},
			);
		});
	}

	// One cheap storage read decides whether this page needs UI right away: a
	// recording in progress or the recorder panel open (the panel follows the
	// user across tabs). The shared state lives in storage.session on Chrome
	// and storage.local on Firefox (see SHARED_STATE_AREA).
	try {
		const sharedStateStorage =
			SHARED_STATE_AREA === "session"
				? chrome.storage.session
				: chrome.storage.local;
		sharedStateStorage.get(
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
