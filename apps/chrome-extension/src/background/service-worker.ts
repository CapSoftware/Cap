import {
	ApiRequestError,
	createAuthStart,
	fetchBootstrap,
	parseAuthResponse,
	revokeAuth,
} from "../shared/api";
import {
	isRecordingStatusBroadcast,
	isServiceWorkerRequest,
} from "../shared/messages";
import { rememberRecordingMode } from "../shared/preferences";
import {
	clearAuth,
	clearAuthError,
	clearCachedBootstrap,
	clearPendingAuth,
	isOverlayTokenRegistered,
	loadAuth,
	loadAuthError,
	loadCachedBootstrap,
	loadPendingAuth,
	loadSettings,
	loadSharedRecordingState,
	loadSharedUiState,
	loadUploadProgressTabId,
	loadWebcamPreviewDismissed,
	registerOverlayToken,
	saveAuth,
	saveAuthError,
	saveCachedBootstrap,
	savePendingAuth,
	saveSettings,
	saveSharedRecordingState,
	saveUploadProgressTabId,
	saveWebcamPreviewDismissed,
	updateSharedUiState,
} from "../shared/storage";
import type {
	BootstrapData,
	CameraDevice,
	CameraPreviewErrorReason,
	CameraPreviewEventRelay,
	ExtensionAuth,
	ExtensionSettings,
	MicrophoneDevice,
	MicrophoneWarningVariant,
	OffscreenRequest,
	OffscreenResponse,
	OverlayMessage,
	RecordingCaptureSource,
	RecordingMode,
	RecordingStatus,
	RecordingStatusBroadcast,
	ServiceWorkerRequest,
	ServiceWorkerResponse,
} from "../shared/types";

const POPUP_URL = "popup.html";
const OFFSCREEN_URL = "offscreen.html";
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const OFFSCREEN_MESSAGE_ATTEMPTS = 3;
const OFFSCREEN_MESSAGE_RETRY_DELAY_MS = 75;
const OVERLAY_MESSAGE_ATTEMPTS = 10;
const OVERLAY_MESSAGE_RETRY_DELAY_MS = 100;
const START_PREVIEW_READY_TIMEOUT_MS = 8000;

let bootstrapCache: BootstrapData | null = null;
let recordingStatus: RecordingStatus = { phase: "idle" };
let cameraDevicesCache: CameraDevice[] = [];
let microphoneDevicesCache: MicrophoneDevice[] = [];
let uploadProgressTabId: number | null = null;
let activePreviewTabId: number | null = null;
let pendingPreviewTabId: number | null = null;
let readyPreviewTabId: number | null = null;
let offscreenDocumentCreation: Promise<void> | null = null;
let browserWindowFocused = true;
let externalCaptureAutoPipPending = false;

type TabWaiter = {
	resolve: () => void;
	reject: (error: Error) => void;
	timeoutId: ReturnType<typeof globalThis.setTimeout>;
};

const previewReadyWaiters = new Map<number, Set<TabWaiter>>();

// Content scripts read the webcam "dismissed" flag and the cached preview
// frame from chrome.storage.session, which is only exposed to trusted
// contexts unless the access level is widened. Without this every session
// storage call from a content script fails.
chrome.storage.session.setAccessLevel({
	accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
});

const getActiveTab = () =>
	new Promise<chrome.tabs.Tab | null>((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			resolve(tabs[0] ?? null);
		});
	});

const getLastFocusedTab = () =>
	new Promise<chrome.tabs.Tab | null>((resolve) => {
		chrome.windows.getLastFocused((focusedWindow) => {
			if (chrome.runtime.lastError || focusedWindow.id === undefined) {
				resolve(null);
				return;
			}
			chrome.tabs.query(
				{ active: true, windowId: focusedWindow.id },
				(tabs) => {
					resolve(tabs[0] ?? null);
				},
			);
		});
	});

const getTabs = () =>
	new Promise<chrome.tabs.Tab[]>((resolve) => {
		chrome.tabs.query({}, resolve);
	});

const getTab = (tabId: number) =>
	new Promise<chrome.tabs.Tab | null>((resolve) => {
		chrome.tabs.get(tabId, (tab) => {
			if (chrome.runtime.lastError) {
				resolve(null);
				return;
			}
			resolve(tab ?? null);
		});
	});

const createTab = (url: string) =>
	new Promise<chrome.tabs.Tab>((resolve, reject) => {
		chrome.tabs.create({ url, active: true }, (tab) => {
			if (chrome.runtime.lastError) {
				reject(
					new Error(chrome.runtime.lastError.message ?? "Failed to open tab"),
				);
				return;
			}
			resolve(tab);
		});
	});

const updateTab = (tabId: number, url: string) =>
	new Promise<chrome.tabs.Tab>((resolve, reject) => {
		chrome.tabs.update(tabId, { url, active: true }, (tab) => {
			if (chrome.runtime.lastError || !tab) {
				reject(
					new Error(
						chrome.runtime.lastError?.message ?? "Failed to update tab",
					),
				);
				return;
			}
			resolve(tab);
		});
	});

const activateTab = (tabId: number) =>
	new Promise<chrome.tabs.Tab | null>((resolve) => {
		chrome.tabs.update(tabId, { active: true }, (tab) => {
			if (chrome.runtime.lastError || !tab) {
				resolve(null);
				return;
			}
			resolve(tab);
		});
	});

const focusWindow = (windowId: number) =>
	new Promise<void>((resolve) => {
		chrome.windows.update(windowId, { focused: true }, () => {
			void chrome.runtime.lastError;
			resolve();
		});
	});

const focusTab = async (tabId: number) => {
	const tab = await getTab(tabId);
	if (tab?.windowId !== undefined) {
		await focusWindow(tab.windowId);
	}
	await activateTab(tabId);
};

const getOffscreenDocumentContexts = async () => {
	const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
	return new Promise<Array<{ documentUrl?: string }>>((resolve) => {
		chrome.runtime.getContexts(
			{
				contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
				documentUrls: [offscreenUrl],
			},
			(contexts) => resolve(contexts),
		);
	});
};

const hasOffscreenDocument = async () =>
	(await getOffscreenDocumentContexts()).length > 0;

const createOffscreenDocument = () =>
	new Promise<void>((resolve, reject) => {
		chrome.offscreen.createDocument(
			{
				url: OFFSCREEN_URL,
				reasons: ["USER_MEDIA", "DISPLAY_MEDIA", "BLOBS", "AUDIO_PLAYBACK"],
				justification: "Record and upload Cap videos from an extension page.",
			},
			() => {
				const error = chrome.runtime.lastError;
				if (!error) {
					resolve();
					return;
				}

				const message = error.message ?? "Failed to create offscreen document";
				if (message.toLowerCase().includes("single offscreen document")) {
					resolve();
					return;
				}

				reject(new Error(message));
			},
		);
	});

const ensureOffscreenDocument = async () => {
	const contexts = await getOffscreenDocumentContexts();
	if (contexts.length > 0) return;

	offscreenDocumentCreation ??= createOffscreenDocument().finally(() => {
		offscreenDocumentCreation = null;
	});
	await offscreenDocumentCreation;
};

const wait = (durationMs: number) =>
	new Promise<void>((resolve) => {
		globalThis.setTimeout(resolve, durationMs);
	});

const isTransientOffscreenMessageError = (error: unknown) => {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes("receiving end does not exist") ||
		message.includes("could not establish connection")
	);
};

const sendOffscreenRuntimeMessage = (message: OffscreenRequest) =>
	new Promise<OffscreenResponse>((resolve, reject) => {
		chrome.runtime.sendMessage(message, (response) => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message ?? "Message failed"));
				return;
			}
			resolve(response as OffscreenResponse);
		});
	});

const sendOffscreen = async (
	message: OffscreenRequest,
	options: { createIfMissing?: boolean } = {},
) => {
	if (options.createIfMissing === false) {
		const hasDocument = await hasOffscreenDocument();
		if (!hasDocument) {
			return { ok: true, status: recordingStatus } satisfies OffscreenResponse;
		}
	} else {
		await ensureOffscreenDocument();
	}

	let lastError: unknown;
	for (let attempt = 1; attempt <= OFFSCREEN_MESSAGE_ATTEMPTS; attempt += 1) {
		try {
			return await sendOffscreenRuntimeMessage(message);
		} catch (error) {
			lastError = error;
			if (
				options.createIfMissing === false ||
				attempt === OFFSCREEN_MESSAGE_ATTEMPTS ||
				!isTransientOffscreenMessageError(error)
			) {
				break;
			}
			await wait(OFFSCREEN_MESSAGE_RETRY_DELAY_MS);
			await ensureOffscreenDocument();
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const getTabStreamId = (tabId: number) =>
	new Promise<string>((resolve, reject) => {
		chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
			if (chrome.runtime.lastError) {
				reject(
					new Error(
						chrome.runtime.lastError.message ?? "Failed to capture tab",
					),
				);
				return;
			}
			resolve(streamId);
		});
	});

const sendOverlayMessage = (tabId: number, message: OverlayMessage) =>
	new Promise<boolean>((resolve) => {
		chrome.tabs.sendMessage(tabId, message, () => {
			resolve(!chrome.runtime.lastError);
		});
	});

const sendOverlayMessageWithRetries = async (
	tabId: number,
	message: OverlayMessage,
) => {
	for (let attempt = 1; attempt <= OVERLAY_MESSAGE_ATTEMPTS; attempt += 1) {
		if (await sendOverlayMessage(tabId, message)) return true;
		if (attempt < OVERLAY_MESSAGE_ATTEMPTS) {
			await wait(OVERLAY_MESSAGE_RETRY_DELAY_MS);
		}
	}

	return false;
};

const sendOverlay = async (
	tabId: number,
	message: OverlayMessage,
	injectIfMissing = true,
) => {
	const delivered = await sendOverlayMessage(tabId, message);
	if (delivered) return true;
	if (!injectIfMissing) return false;

	const injected = await new Promise<boolean>((resolve) => {
		chrome.scripting.executeScript(
			{ target: { tabId }, files: ["assets/content-bootstrap.js"] },
			() => resolve(!chrome.runtime.lastError),
		);
	});

	if (!injected) return false;

	return sendOverlayMessageWithRetries(tabId, message);
};

const removeTabWaiter = (
	waiters: Map<number, Set<TabWaiter>>,
	tabId: number,
	waiter: TabWaiter,
) => {
	const tabWaiters = waiters.get(tabId);
	if (!tabWaiters) return;
	tabWaiters.delete(waiter);
	if (tabWaiters.size === 0) {
		waiters.delete(tabId);
	}
};

const waitForTabSignal = (
	waiters: Map<number, Set<TabWaiter>>,
	tabId: number,
	timeoutMs: number,
	timeoutMessage: string,
) =>
	new Promise<void>((resolve, reject) => {
		let waiter: TabWaiter;
		const timeoutId = globalThis.setTimeout(() => {
			removeTabWaiter(waiters, tabId, waiter);
			reject(new Error(timeoutMessage));
		}, timeoutMs);

		waiter = {
			resolve: () => {
				globalThis.clearTimeout(timeoutId);
				resolve();
			},
			reject: (error) => {
				globalThis.clearTimeout(timeoutId);
				reject(error);
			},
			timeoutId,
		};

		const tabWaiters = waiters.get(tabId) ?? new Set<TabWaiter>();
		tabWaiters.add(waiter);
		waiters.set(tabId, tabWaiters);
	});

const settleTabWaiters = (
	waiters: Map<number, Set<TabWaiter>>,
	tabId: number,
	error?: Error,
) => {
	const tabWaiters = waiters.get(tabId);
	if (!tabWaiters) return;
	waiters.delete(tabId);
	for (const waiter of tabWaiters) {
		if (error) {
			waiter.reject(error);
		} else {
			waiter.resolve();
		}
	}
};

const canInjectIntoTab = (tab: chrome.tabs.Tab) => {
	if (tab.id === undefined) return false;
	if (!tab.url) return true;
	try {
		const protocol = new URL(tab.url).protocol;
		return (
			protocol === "http:" || protocol === "https:" || protocol === "file:"
		);
	} catch {
		return false;
	}
};

const isWebPageSender = (sender: chrome.runtime.MessageSender) => {
	if (!sender.tab) return false;
	const senderUrl = sender.url ?? "";
	return !senderUrl.startsWith("chrome-extension:");
};

// camera-preview.html is web accessible, so any site can load it in an
// iframe. Only honour camera requests carrying a token that one of our
// content scripts registered: web pages cannot send runtime messages, so a
// registered token proves the frame was embedded by the extension overlay.
const isCameraPreviewRequestAllowed = async (
	sender: chrome.runtime.MessageSender,
	sessionId: string,
) => {
	const token = sessionId.split(":")[0] ?? "";
	if (!(await isOverlayTokenRegistered(token))) return false;

	const senderUrl = sender.url ?? "";
	if (senderUrl.startsWith("chrome-extension:")) {
		// The camera preview document is the only extension page that drives
		// the camera.
		try {
			return new URL(senderUrl).pathname === "/camera-preview.html";
		} catch {
			return false;
		}
	}

	// Otherwise the sender is a content script (the parent PiP fallback).
	return Boolean(sender.tab);
};

// Preview events (webcam frames, drag, errors) may only originate from the
// camera-preview document itself, and only one whose URL-hash token a content
// script registered. They are then relayed to the embedding tab's content
// script over chrome.tabs.sendMessage — never window.postMessage, which the
// recorded page could listen to.
const isCameraPreviewEventAllowed = async (
	sender: chrome.runtime.MessageSender,
	token: string,
) => {
	if (!token || !(await isOverlayTokenRegistered(token))) return false;
	const senderUrl = sender.url ?? "";
	if (!senderUrl.startsWith("chrome-extension:")) return false;
	try {
		return new URL(senderUrl).pathname === "/camera-preview.html";
	} catch {
		return false;
	}
};

const isActiveRecordingStatus = (status: RecordingStatus) =>
	status.phase === "recording" ||
	status.phase === "paused" ||
	status.phase === "uploading";

const isCapturingRecordingStatus = (status: RecordingStatus) =>
	status.phase === "recording" || status.phase === "paused";

const isRecordingPreviewStatus = (status: RecordingStatus) =>
	status.phase === "creating" ||
	status.phase === "recording" ||
	status.phase === "paused";

const normalizeComparableText = (value: string) =>
	value.toLowerCase().replace(/\s+/g, " ").trim();

const getComparableCaptureLabel = (label: string) =>
	normalizeComparableText(label)
		.replace(
			/^(chrome tab|browser tab|tab|window|application|screen|display)\s*[:|-]\s*/,
			"",
		)
		.replace(
			/\s+-\s+(google chrome|chrome|chromium|microsoft edge|edge|brave|arc|opera|vivaldi).*$/,
			"",
		)
		.trim();

const getCapturedTabScore = (tab: chrome.tabs.Tab, label: string) => {
	if (!tab.title) return 0;
	const rawLabel = normalizeComparableText(label);
	const comparableLabel = getComparableCaptureLabel(label);
	const title = normalizeComparableText(tab.title);
	if (!title || !comparableLabel) return 0;
	if (title === comparableLabel || title === rawLabel) return 1000;
	if (rawLabel.includes(title)) return 900 + title.length;
	if (comparableLabel.includes(title)) return 800 + title.length;
	if (title.includes(comparableLabel) && comparableLabel.length >= 8) {
		return 700 + comparableLabel.length;
	}
	return 0;
};

const findCapturedBrowserTabId = async (source: RecordingCaptureSource) => {
	if (source.tabId !== undefined) return source.tabId;
	if (!source.label) return null;
	const tabs = await getTabs();
	let bestTabId: number | null = null;
	let bestScore = 0;
	for (const tab of tabs) {
		if (tab.id === undefined) continue;
		const score = getCapturedTabScore(tab, source.label);
		if (score > bestScore) {
			bestScore = score;
			bestTabId = tab.id;
		}
	}
	return bestScore > 0 ? bestTabId : null;
};

const isBrowserCaptureSource = (source: RecordingCaptureSource) =>
	source.detectedMode === "tab" ||
	source.displaySurface === "browser" ||
	source.displaySurface === "tab";

const isWindowCaptureSource = (source: RecordingCaptureSource) =>
	source.detectedMode === "window" ||
	source.displaySurface === "window" ||
	source.displaySurface === "application";

const isLikelyBrowserWindow = (source: RecordingCaptureSource) => {
	if (!source.label) return false;
	return /\b(google chrome|chrome|chromium|microsoft edge|edge|brave|arc|opera|vivaldi)\b/i.test(
		source.label,
	);
};

const shouldAutoPipCaptureSource = (source: RecordingCaptureSource) =>
	isWindowCaptureSource(source) && !isLikelyBrowserWindow(source);

const isWebcamPreviewEnabled = (settings: ExtensionSettings) =>
	settings.webcam.enabled && Boolean(settings.webcam.deviceId);

const shouldShowWebcamPreview = async (settings: ExtensionSettings) =>
	isWebcamPreviewEnabled(settings) && !(await loadWebcamPreviewDismissed());

const setActionPopup = (popup: string) =>
	new Promise<void>((resolve) => {
		chrome.action.setPopup({ popup }, () => resolve());
	});

const setActionBadgeText = (text: string) =>
	new Promise<void>((resolve) => {
		chrome.action.setBadgeText({ text }, () => resolve());
	});

const setActionTitle = (title: string) =>
	new Promise<void>((resolve) => {
		chrome.action.setTitle({ title }, () => resolve());
	});

const updateActionForStatus = (nextStatus: RecordingStatus) => {
	const isCapturing = isCapturingRecordingStatus(nextStatus);
	return Promise.all([
		// The recorder renders inside the page, so the action never opens a popup.
		setActionPopup(""),
		setActionBadgeText(isCapturing ? "REC" : ""),
		setActionTitle(
			isCapturing ? "Stop Cap recording" : "Record your screen with Cap",
		),
	]).then(() => undefined);
};

let lastSharedRecordingStateJson: string | null = null;

const setRecordingStatus = (nextStatus: RecordingStatus) => {
	recordingStatus = nextStatus;
	void updateActionForStatus(nextStatus);
	// Session storage is the cross-tab source of truth: every tab's floating
	// bar subscribes to this key, so switching tabs never shows stale state.
	// Skip identical writes — each write fans a storage.onChanged event out to
	// every open tab, and status polls would otherwise rewrite an unchanged
	// status several times per second.
	const sharedState = {
		status: nextStatus,
		plan: bootstrapCache?.plan ?? null,
	};
	const sharedStateJson = JSON.stringify(sharedState);
	if (sharedStateJson === lastSharedRecordingStateJson) return;
	lastSharedRecordingStateJson = sharedStateJson;
	void saveSharedRecordingState({
		...sharedState,
		updatedAt: Date.now(),
	}).catch(() => undefined);
};

const syncPanelForStatus = (status: RecordingStatus) => {
	if (status.phase === "error") {
		// Reopen the panel everywhere so the failure is actually visible; only
		// the tab on screen renders it.
		void updateSharedUiState((current) => ({
			...current,
			panelOpen: true,
			readyBarDismissed: false,
			updatedAt: Date.now(),
		})).catch(() => undefined);
		return;
	}
	if (status.phase !== "idle") {
		void updateSharedUiState((current) =>
			current.panelOpen
				? { ...current, panelOpen: false, updatedAt: Date.now() }
				: current,
		).catch(() => undefined);
	}
};

const hidePreviewTab = async (tabId: number) => {
	await sendOverlay(tabId, { type: "overlay-hide" }, false).catch(
		() => undefined,
	);
	if (activePreviewTabId === tabId) {
		activePreviewTabId = null;
	}
	if (pendingPreviewTabId === tabId) {
		pendingPreviewTabId = null;
	}
	if (readyPreviewTabId === tabId) {
		readyPreviewTabId = null;
	}
};

const hidePreviewTabsExcept = async (activeTabId: number) => {
	const tabs = await getTabs();
	await Promise.all(
		tabs.map((tab) => {
			if (
				tab.id === undefined ||
				tab.id === activeTabId ||
				!canInjectIntoTab(tab)
			) {
				return undefined;
			}
			return sendOverlay(tab.id, { type: "overlay-hide" }, false).catch(
				() => undefined,
			);
		}),
	);
};

const showOverlayInActiveTab = async (
	settings: ExtensionSettings,
	recording: boolean,
) => {
	if (!(await shouldShowWebcamPreview(settings))) {
		if (activePreviewTabId !== null) {
			await hidePreviewTab(activePreviewTabId);
		}
		if (pendingPreviewTabId !== null) {
			await hidePreviewTab(pendingPreviewTabId);
		}
		return false;
	}

	const tab = await getActiveTab();
	return showOverlayInTab(tab, settings, recording);
};

const showOverlayInTab = async (
	tab: chrome.tabs.Tab | null,
	settings: ExtensionSettings,
	recording: boolean,
) => {
	if (!(await shouldShowWebcamPreview(settings))) {
		if (activePreviewTabId !== null) {
			await hidePreviewTab(activePreviewTabId);
		}
		if (pendingPreviewTabId !== null) {
			await hidePreviewTab(pendingPreviewTabId);
		}
		return false;
	}

	if (!tab || !canInjectIntoTab(tab) || tab.id === undefined) return false;
	const delivered = await sendOverlay(tab.id, {
		type: "overlay-settings",
		settings: settings.webcam,
		recording,
	});
	if (!delivered) return false;

	if (activePreviewTabId === null || activePreviewTabId === tab.id) {
		activePreviewTabId = tab.id;
		pendingPreviewTabId = null;
		await hidePreviewTabsExcept(tab.id);
	} else {
		pendingPreviewTabId = tab.id;
	}

	return true;
};

const closeAllExtensionUi = async () => {
	await saveWebcamPreviewDismissed(true);
	// Closing the recorder acknowledges a surfaced failure; otherwise the
	// error keeps reappearing every time the panel opens.
	if (recordingStatus.phase === "error") {
		setRecordingStatus({ phase: "idle" });
		await sendOffscreen(
			{ target: "offscreen", type: "acknowledge-error" },
			{ createIfMissing: false },
		).catch(() => undefined);
	}
	await Promise.all([
		broadcastOverlayHide(),
		updateSharedUiState((current) => ({
			...current,
			panelOpen: false,
			updatedAt: Date.now(),
		})).then(() => undefined),
	]);
};

const showPreviewForRecorderOpen = async (
	tab: chrome.tabs.Tab,
	status: RecordingStatus,
) => {
	const [settings, auth] = await Promise.all([loadSettings(), loadAuth()]);
	if (!auth || !isWebcamPreviewEnabled(settings)) return;
	await saveWebcamPreviewDismissed(false);
	await showOverlayInTab(tab, settings, isRecordingPreviewStatus(status));
};

type InjectableTab = chrome.tabs.Tab & { id: number };

const getRecorderPanelTabs = async (actionTab?: chrome.tabs.Tab) => {
	const candidates = [
		actionTab ?? null,
		await getActiveTab(),
		await getLastFocusedTab(),
	];
	const seen = new Set<number>();

	return candidates.filter((tab): tab is InjectableTab => {
		if (!tab || tab.id === undefined || !canInjectIntoTab(tab)) return false;
		if (seen.has(tab.id)) return false;
		seen.add(tab.id);
		return true;
	});
};

const openRecorderPanel = async (actionTab?: chrome.tabs.Tab) => {
	// Clicking the action toggles the recorder UI. When it is already open,
	// close it through the same path as the panel's own close button so the
	// camera preview is torn down too — a blind panel-toggle would hide the
	// panel and recording bar but leave the camera window stranded.
	const sharedUi = await loadSharedUiState().catch(() => null);
	if (sharedUi?.panelOpen) {
		await closeAllExtensionUi();
		return;
	}

	const currentStatus = await syncRecordingStatus().catch(
		() => recordingStatus,
	);
	for (const tab of await getRecorderPanelTabs(actionTab)) {
		const delivered = await sendOverlay(tab.id, {
			type: "overlay-panel-toggle",
		});
		if (delivered) {
			await focusTab(tab.id);
			void showPreviewForRecorderOpen(tab, currentStatus).catch(
				() => undefined,
			);
			return;
		}
	}

	// Pages we cannot inject into (chrome://, the Web Store, etc.) still get a
	// recorder via a standalone popup window.
	chrome.windows.create({
		url: chrome.runtime.getURL(POPUP_URL),
		type: "popup",
		width: 332,
		height: 600,
	});
};

const getPreviewTabIdForPip = async () => {
	const settings = await loadSettings();
	if (!(await shouldShowWebcamPreview(settings))) return null;
	if (activePreviewTabId !== null) return activePreviewTabId;
	const tab = await getLastFocusedTab();
	if (!tab || !canInjectIntoTab(tab) || tab.id === undefined) return null;
	activePreviewTabId = tab.id;
	return tab.id;
};

const enterActivePreviewAutoPip = async () => {
	const tabId = await getPreviewTabIdForPip();
	if (tabId === null) return false;
	return sendOverlay(tabId, { type: "overlay-enter-auto-pip" }, false).catch(
		() => false,
	);
};

const exitActivePreviewAutoPip = async () => {
	const tabId = await getPreviewTabIdForPip();
	if (tabId === null) return false;
	return sendOverlay(tabId, { type: "overlay-exit-auto-pip" }, false).catch(
		() => false,
	);
};

const waitForWebcamPreviewReady = (tabId: number) => {
	if (readyPreviewTabId === tabId) return Promise.resolve();
	return waitForTabSignal(
		previewReadyWaiters,
		tabId,
		START_PREVIEW_READY_TIMEOUT_MS,
		"Camera preview did not become ready before recording started.",
	);
};

const disconnectAllCameraPreviews = async () => {
	const response = await sendOffscreen(
		{ target: "offscreen", type: "disconnect-camera-previews" },
		{ createIfMissing: false },
	);
	return response.ok;
};

const broadcastOverlayHide = async () => {
	await disconnectAllCameraPreviews().catch(() => undefined);
	const tabs = await getTabs();
	await Promise.all(
		tabs.map((tab) => {
			if (!canInjectIntoTab(tab) || tab.id === undefined) {
				return undefined;
			}
			return sendOverlay(tab.id, { type: "overlay-hide" }, false).catch(
				() => undefined,
			);
		}),
	);
	activePreviewTabId = null;
	pendingPreviewTabId = null;
	readyPreviewTabId = null;
};

const broadcastRecordingStatusToTabs = async (status: RecordingStatus) => {
	const message: RecordingStatusBroadcast = {
		target: "recording-status",
		type: "recording-status-changed",
		status,
	};
	const tabs = await getTabs();
	await Promise.all(
		tabs.map((tab) => {
			if (!canInjectIntoTab(tab) || tab.id === undefined) {
				return undefined;
			}
			const tabId = tab.id;
			return new Promise<void>((resolve) => {
				chrome.tabs.sendMessage(tabId, message, () => {
					void chrome.runtime.lastError;
					resolve();
				});
			});
		}),
	);
};

const setRecordingStatusAndBroadcast = (nextStatus: RecordingStatus) => {
	// Progress ticks arrive from the offscreen recorder every 500ms; fanning
	// each one out with a tabs.query plus a per-tab sendMessage multiplies a
	// sustained 2/sec storm by the tab count. The session-storage mirror
	// written by setRecordingStatus (deduped against identical states) is the
	// per-tick fan-out; per-tab messages are reserved for phase transitions,
	// which consumers use as low-frequency "something changed" wake-ups.
	const phaseChanged = nextStatus.phase !== recordingStatus.phase;
	setRecordingStatus(nextStatus);
	if (phaseChanged) {
		void broadcastRecordingStatusToTabs(nextStatus);
	}
	syncPanelForStatus(nextStatus);
};

const injectOverlayIntoOpenTabs = async () => {
	const tabs = await getTabs();
	await Promise.all(
		tabs.map((tab) => {
			if (!canInjectIntoTab(tab) || tab.id === undefined) {
				return undefined;
			}
			const tabId = tab.id;
			return new Promise<void>((resolve) => {
				chrome.scripting.executeScript(
					{ target: { tabId }, files: ["assets/content-bootstrap.js"] },
					() => {
						void chrome.runtime.lastError;
						resolve();
					},
				);
			});
		}),
	);
};

const broadcastCameraDevices = (devices: CameraDevice[]) => {
	chrome.runtime.sendMessage(
		{
			type: "camera-devices-changed",
			devices,
		},
		() => undefined,
	);
};

// The recorder panel is a cross-origin iframe, so its own enumerateDevices()
// returns no labelled devices even when the grant exists. Enumerate in the
// offscreen document instead (a top-level extension page that keeps the grant)
// and cache the result. Empty results never overwrite a populated cache: a
// transient enumeration that loses labels must not wipe known devices.
const refreshMediaDevicesFromOffscreen = async () => {
	try {
		const response = await sendOffscreen({
			target: "offscreen",
			type: "enumerate-devices",
		});
		if (response.ok && response.devices) {
			if (response.devices.cameras.length > 0) {
				cameraDevicesCache = response.devices.cameras;
				broadcastCameraDevices(cameraDevicesCache);
			}
			if (response.devices.microphones.length > 0) {
				microphoneDevicesCache = response.devices.microphones;
			}
		}
	} catch {
		// Fall back to whatever is already cached.
	}
};

const getUploadProgressUrl = (videoId: string) => {
	const url = new URL(chrome.runtime.getURL("uploading.html"));
	url.searchParams.set("videoId", videoId);
	return url.toString();
};

// Module state dies whenever the MV3 service worker is recycled, so the
// uploading-tab id is mirrored into session storage; a restarted worker
// rehydrates it before deciding to open another tab.
const setUploadProgressTabId = (tabId: number | null) => {
	uploadProgressTabId = tabId;
	void saveUploadProgressTabId(tabId).catch(() => undefined);
};

const getUploadProgressTabId = async () => {
	if (uploadProgressTabId !== null) return uploadProgressTabId;
	const persisted = await loadUploadProgressTabId().catch(() => null);
	if (persisted === null) return null;
	const tab = await getTab(persisted);
	if (!tab) {
		void saveUploadProgressTabId(null).catch(() => undefined);
		return null;
	}
	uploadProgressTabId = persisted;
	return persisted;
};

const openRecordingDestinationInner = async (status: RecordingStatus) => {
	if (status.phase === "completed") {
		await createTab(status.shareUrl);
		return;
	}

	if (status.phase !== "uploading" || !status.videoId) return;

	const url = getUploadProgressUrl(status.videoId);
	const existingTabId = await getUploadProgressTabId();
	if (existingTabId !== null) {
		const updated = await updateTab(existingTabId, url).then(
			() => true,
			() => false,
		);
		if (updated) return;
		setUploadProgressTabId(null);
	}

	const tab = await createTab(url);
	setUploadProgressTabId(tab.id ?? null);
};

// Serialised: concurrent callers (the free-plan auto-stop tick re-sends
// stop-recording until finalize starts) could otherwise both read a null
// upload-tab id before either persists one and open duplicate tabs.
let openRecordingDestinationQueue: Promise<void> = Promise.resolve();

const openRecordingDestination = (status: RecordingStatus) => {
	const run = openRecordingDestinationQueue.then(() =>
		openRecordingDestinationInner(status),
	);
	openRecordingDestinationQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
};

let bootstrapRefreshInFlight = false;

const refreshBootstrapInBackground = (
	settings: ExtensionSettings,
	auth: ExtensionAuth,
) => {
	if (bootstrapRefreshInFlight) return;
	bootstrapRefreshInFlight = true;
	fetchBootstrap(settings, auth)
		.then((bootstrap) => {
			bootstrapCache = bootstrap;
			return saveCachedBootstrap(bootstrap);
		})
		.catch(() => undefined)
		.finally(() => {
			bootstrapRefreshInFlight = false;
		});
};

const loadSignedInState = async () => {
	const [settings, auth, pendingAuth, authError] = await Promise.all([
		loadSettings(),
		loadAuth(),
		loadPendingAuth(),
		loadAuthError(),
	]);
	const authPending =
		!!pendingAuth && Date.now() - pendingAuth.startedAt < AUTH_TIMEOUT_MS;
	if (pendingAuth && !authPending) {
		await clearPendingAuth();
	}
	if (!auth) {
		return { settings, auth: null, bootstrap: null, authPending, authError };
	}

	if (!bootstrapCache) {
		bootstrapCache = await loadCachedBootstrap();
	}

	// Serve the cached bootstrap immediately so the popup opens without waiting
	// on the network, and refresh it in the background.
	if (bootstrapCache) {
		refreshBootstrapInBackground(settings, auth);
		return {
			settings,
			auth,
			bootstrap: bootstrapCache,
			authPending: false,
			authError: null,
		};
	}

	bootstrapCache = await fetchBootstrap(settings, auth);
	await saveCachedBootstrap(bootstrapCache);
	return {
		settings,
		auth,
		bootstrap: bootstrapCache,
		authPending: false,
		authError: null,
	};
};

const requireSignedInState = async () => {
	const state = await loadSignedInState();
	if (!state.auth || !state.bootstrap) {
		throw new Error("Sign in to Cap first");
	}
	return state as {
		settings: ExtensionSettings;
		auth: ExtensionAuth;
		bootstrap: BootstrapData;
	};
};

// Pending floating-confirm prompts keyed by requestId; the recorded tab's
// overlay resolves them via a "confirm-result" request. Falls back to cancel
// after the timeout so a start never hangs forever on a prompt the user walked
// away from.
const recordingConfirmWaiters = new Map<string, (confirmed: boolean) => void>();
const CONFIRM_DECISION_TIMEOUT_MS = 2 * 60 * 1000;

const resolveRecordingConfirmation = (
	requestId: string,
	confirmed: boolean,
) => {
	const waiter = recordingConfirmWaiters.get(requestId);
	if (!waiter) return;
	recordingConfirmWaiters.delete(requestId);
	waiter(confirmed);
};

// Shows the floating confirm prompt on the recorded tab and waits for the
// user's decision. If the prompt cannot be shown (no tab, restricted page),
// the recording proceeds rather than being blocked by UI that never appeared.
const requestRecordingConfirmation = async (
	tabId: number | undefined,
	variant: MicrophoneWarningVariant,
): Promise<boolean> => {
	if (tabId === undefined) return true;

	const requestId = crypto.randomUUID();
	let settle: (confirmed: boolean) => void = () => undefined;
	const decision = new Promise<boolean>((resolve) => {
		settle = resolve;
	});
	const timer = globalThis.setTimeout(() => {
		recordingConfirmWaiters.delete(requestId);
		settle(false);
	}, CONFIRM_DECISION_TIMEOUT_MS);
	// Register before sending so a fast click cannot resolve before the waiter
	// exists.
	recordingConfirmWaiters.set(requestId, (confirmed) => {
		globalThis.clearTimeout(timer);
		settle(confirmed);
	});

	const delivered = await sendOverlay(tabId, {
		type: "overlay-confirm",
		requestId,
		variant,
	});
	if (!delivered) {
		globalThis.clearTimeout(timer);
		recordingConfirmWaiters.delete(requestId);
		return true;
	}
	return decision;
};

// Decides whether a recording start needs a mic warning. The silence check
// runs in the offscreen document, which has reliable mic access.
const resolveMicWarning = async (
	settings: ExtensionSettings,
): Promise<MicrophoneWarningVariant | null> => {
	if (!settings.microphoneWarning.enabled) return null;
	if (!settings.microphone.enabled) return "no-mic";
	const response = await sendOffscreen({
		target: "offscreen",
		type: "probe-microphone",
		microphone: settings.microphone,
	}).catch(() => null);
	if (
		response?.ok &&
		response.micProbe?.available &&
		!response.micProbe.hasSound
	) {
		return "no-sound";
	}
	return null;
};

const startRecording = async (mode: RecordingMode) => {
	const { settings, auth, bootstrap } = await requireSignedInState();
	externalCaptureAutoPipPending = false;
	const recordingSettings =
		settings.capture.recordingMode === mode
			? settings
			: rememberRecordingMode(settings, mode);
	if (recordingSettings !== settings) {
		await saveSettings(recordingSettings);
	}
	if (mode === "camera" && !recordingSettings.webcam.deviceId) {
		throw new Error("Select a camera before recording.");
	}
	if (isWebcamPreviewEnabled(recordingSettings)) {
		await saveWebcamPreviewDismissed(false);
	}
	const tab = await getActiveTab();
	const tabId = tab?.id;

	// Shared mic gate: every start path (panel button and the floating bar)
	// funnels through here, so the warning is consistent. Run it before any
	// capture setup so declining leaves nothing to tear down.
	const micWarning = await resolveMicWarning(recordingSettings);
	if (micWarning) {
		const confirmed = await requestRecordingConfirmation(tabId, micWarning);
		if (!confirmed) {
			externalCaptureAutoPipPending = false;
			return {
				ok: false,
				canceled: true,
				error: "Recording canceled",
			} satisfies OffscreenResponse;
		}
	}

	const tabStreamId =
		mode === "tab" && tabId !== undefined
			? await getTabStreamId(tabId)
			: undefined;
	const overlayShown = await showOverlayInTab(
		tab ?? null,
		recordingSettings,
		true,
	);
	const readyWaits: Array<Promise<void>> = [];
	if (overlayShown && tabId !== undefined) {
		if (isWebcamPreviewEnabled(recordingSettings)) {
			// The preview is a nice-to-have: never abort the recording because it
			// did not come up in time.
			readyWaits.push(waitForWebcamPreviewReady(tabId).catch(() => undefined));
		}
	}

	const creatingStatus = { phase: "creating" } satisfies RecordingStatus;
	setRecordingStatusAndBroadcast(creatingStatus);
	// The manifest injects the bootstrap content script into every page at
	// document_idle and onInstalled covers tabs that predate the extension, so
	// no blanket re-injection is needed here; sendOverlay still injects
	// per-tab on demand and the bootstrap lazy-loads the overlay UI.
	if (overlayShown) {
		await showOverlayInTab(tab ?? null, recordingSettings, true);
	}

	try {
		await Promise.all(readyWaits);
		return await sendOffscreen({
			target: "offscreen",
			type: "start-recording",
			mode,
			settings: recordingSettings,
			auth,
			bootstrap,
			tabId,
			tabStreamId,
		});
	} catch (error) {
		// The recorder panel closes as soon as the status leaves "idle", so a
		// silent reset would leave the user with no feedback at all. Broadcast
		// the failure so the panel reopens and shows it.
		setRecordingStatusAndBroadcast({
			phase: "error",
			message: error instanceof Error ? error.message : String(error),
		});
		externalCaptureAutoPipPending = false;
		throw error;
	}
};

const forwardToOffscreen = (type: OffscreenRequest["type"]) =>
	sendOffscreen({ target: "offscreen", type } as OffscreenRequest);

const syncRecordingStatus = async () => {
	const hasDocument = await hasOffscreenDocument();
	if (!hasDocument) {
		if (isActiveRecordingStatus(recordingStatus)) {
			setRecordingStatusAndBroadcast({ phase: "idle" });
		} else {
			// A restarted service worker boots as "idle" while session storage may
			// still hold the previous life's status; rewrite it so no tab keeps
			// rendering a recording bar for a recorder that no longer exists.
			void loadSharedRecordingState()
				.then((state) => {
					if (state && state.status.phase !== recordingStatus.phase) {
						setRecordingStatus(recordingStatus);
					}
				})
				.catch(() => undefined);
		}
		return recordingStatus;
	}
	const response = await sendOffscreen(
		{ target: "offscreen", type: "get-recording-status" },
		{ createIfMissing: false },
	);
	if (response.ok && response.status) {
		if (
			recordingStatus.phase === "creating" &&
			response.status.phase === "idle"
		) {
			return recordingStatus;
		}
		// A restarted service worker boots as "idle" even while the offscreen
		// document is still recording. Broadcast phase changes so open tabs
		// (the floating bar in particular) catch back up.
		if (response.status.phase !== recordingStatus.phase) {
			setRecordingStatusAndBroadcast(response.status);
		} else {
			setRecordingStatus(response.status);
		}
	}
	return recordingStatus;
};

const stopRecordingAndOpenDestination = async () => {
	const response = await forwardToOffscreen("stop-recording");
	if (response.ok && response.status) {
		setRecordingStatus(response.status);
		if (!isCapturingRecordingStatus(response.status)) {
			externalCaptureAutoPipPending = false;
			await saveWebcamPreviewDismissed(true);
			void broadcastOverlayHide();
		}
		void openRecordingDestination(response.status).catch(() => undefined);
	}
	return response;
};

const syncActivePreview = async (tabId?: number) => {
	const currentStatus = await syncRecordingStatus().catch(
		() => recordingStatus,
	);
	const settings = await loadSettings();
	const recording = isRecordingPreviewStatus(currentStatus);
	if (tabId !== undefined) {
		const shown = await showOverlayInTab(
			await getTab(tabId),
			settings,
			recording,
		);
		if (!shown && (await shouldShowWebcamPreview(settings))) {
			await enterActivePreviewAutoPip();
		}
		return;
	}
	const shown = await showOverlayInActiveTab(settings, recording);
	if (!shown && (await shouldShowWebcamPreview(settings))) {
		await enterActivePreviewAutoPip();
	}
};

const launchWebAuthFlow = (url: string) =>
	new Promise<string>((resolve, reject) => {
		chrome.identity.launchWebAuthFlow(
			{ url, interactive: true },
			(responseUrl) => {
				if (chrome.runtime.lastError || !responseUrl) {
					reject(
						new Error(
							chrome.runtime.lastError?.message ??
								"The sign-in window was closed",
						),
					);
					return;
				}
				resolve(responseUrl);
			},
		);
	});

// Chrome rejects a second interactive auth flow while one is open, so a
// repeat click must not relaunch; the open window stays authoritative.
let authFlowInFlight = false;

const beginAuthFlow = async (settings: ExtensionSettings) => {
	if (authFlowInFlight) return;
	// Claimed synchronously: the guard sits before several awaits (storage,
	// the createAuthStart round trip), so a second click in that window would
	// otherwise launch a duplicate interactive flow that Chrome rejects.
	authFlowInFlight = true;

	let authStart: Awaited<ReturnType<typeof createAuthStart>>;
	try {
		await clearAuthError();
		await clearPendingAuth();
		authStart = await createAuthStart(settings);
		await savePendingAuth({
			state: authStart.state,
			redirectUri: authStart.redirectUri,
			startedAt: Date.now(),
		});
	} catch (error) {
		authFlowInFlight = false;
		throw error;
	}
	// launchWebAuthFlow keeps the whole exchange inside an isolated auth
	// window: the minted key only travels in the intercepted redirect, never
	// through a regular tab's URL bar, browser history, or the tabs API that
	// co-installed extensions can observe.
	void launchWebAuthFlow(authStart.url)
		.then(async (responseUrl) => {
			const auth = parseAuthResponse(responseUrl, authStart.state);
			// Server-minted keys never expire, so a re-auth would otherwise leave
			// the previous key live in auth_api_keys forever; revoke it
			// best-effort before it is forgotten locally.
			const previousAuth = await loadAuth().catch(() => null);
			if (previousAuth && previousAuth.authApiKey !== auth.authApiKey) {
				await revokeAuth(settings, previousAuth).catch(() => undefined);
			}
			await saveAuth(auth);
			bootstrapCache = null;
			refreshBootstrapInBackground(settings, auth);
		})
		.catch(async (error: unknown) => {
			// This rejection has no open message channel to land in; persist it
			// so the popup's pending-auth poll can show the failure instead of
			// silently snapping back to the sign-in button.
			await saveAuthError(
				error instanceof Error ? error.message : String(error),
			).catch(() => undefined);
		})
		.finally(() => {
			authFlowInFlight = false;
			void clearPendingAuth();
		});
};

const handlePreviewReady = async (tabId?: number) => {
	if (tabId === undefined) return;
	if (pendingPreviewTabId !== null && pendingPreviewTabId !== tabId) return;
	activePreviewTabId = tabId;
	pendingPreviewTabId = null;
	readyPreviewTabId = tabId;
	settleTabWaiters(previewReadyWaiters, tabId);
	await hidePreviewTabsExcept(tabId);
	if (!browserWindowFocused || externalCaptureAutoPipPending) {
		await enterActivePreviewAutoPip();
	}
};

const handlePreviewError = async (
	tabId: number | undefined,
	reason: CameraPreviewErrorReason,
) => {
	if (tabId === undefined) return;
	if (pendingPreviewTabId === tabId) {
		pendingPreviewTabId = null;
	}
	if (readyPreviewTabId === tabId) {
		readyPreviewTabId = null;
	}
	settleTabWaiters(
		previewReadyWaiters,
		tabId,
		new Error("Camera preview did not become ready."),
	);

	const fallbackTabId =
		activePreviewTabId !== null && activePreviewTabId !== tabId
			? activePreviewTabId
			: null;

	if (reason === "permissions-policy" && fallbackTabId !== null) {
		await hidePreviewTab(tabId);
		await enterActivePreviewAutoPip();
	}
};

const handleCaptureSource = async (source: RecordingCaptureSource) => {
	if (isBrowserCaptureSource(source)) {
		externalCaptureAutoPipPending = false;
		const tabId = await findCapturedBrowserTabId(source);
		if (tabId !== null) {
			await focusTab(tabId);
			await syncActivePreview(tabId);
		}
		await exitActivePreviewAutoPip();
		return;
	}

	if (!shouldAutoPipCaptureSource(source)) {
		externalCaptureAutoPipPending = false;
		return;
	}

	externalCaptureAutoPipPending = true;
	await enterActivePreviewAutoPip();
};

const handleRequest = async (
	message: ServiceWorkerRequest,
	sender: chrome.runtime.MessageSender,
): Promise<ServiceWorkerResponse> => {
	if (message.type === "auth-start") {
		const settings = await loadSettings();
		await beginAuthFlow(settings);
		return { ok: true, auth: null, authPending: true, settings };
	}

	if (message.type === "auth-revoke") {
		const settings = await loadSettings();
		const auth = await loadAuth();
		if (auth) {
			try {
				await revokeAuth(settings, auth);
			} catch (error) {
				// A definitive 4xx means the server saw the request and the key
				// is unusable or already gone, so clearing local state is right.
				// Anything else (network failure, timeout, 5xx) leaves a live
				// key on the server; keep the session and surface the failure
				// instead of pretending the sign-out worked.
				const status = error instanceof ApiRequestError ? error.status : null;
				if (status === null || status >= 500) {
					throw new Error(
						"Could not reach Cap to revoke this sign-in. Check your connection and try again.",
					);
				}
			}
		}
		await clearAuth();
		await clearPendingAuth();
		await clearCachedBootstrap();
		bootstrapCache = null;
		return { ok: true, auth: null, settings };
	}

	if (message.type === "bootstrap") {
		const state = await loadSignedInState();
		await saveWebcamPreviewDismissed(false);
		await syncRecordingStatus().catch(() => recordingStatus);
		if (state.auth) {
			void showOverlayInActiveTab(
				state.settings,
				isRecordingPreviewStatus(recordingStatus),
			).catch(() => undefined);
		}
		return {
			ok: true,
			auth: state.auth,
			authPending: state.authPending,
			authError: state.authError,
			bootstrap: state.bootstrap ?? undefined,
			cameraDevices: cameraDevicesCache,
			microphoneDevices: microphoneDevicesCache,
			settings: state.settings,
			status: recordingStatus,
		};
	}

	if (message.type === "get-overlay-settings") {
		const [settings, currentStatus] = await Promise.all([
			loadSettings(),
			syncRecordingStatus().catch(() => recordingStatus),
		]);
		return { ok: true, settings, status: currentStatus };
	}

	if (message.type === "get-camera-devices") {
		return { ok: true, cameraDevices: cameraDevicesCache };
	}

	if (message.type === "get-media-devices") {
		await refreshMediaDevicesFromOffscreen();
		return {
			ok: true,
			cameraDevices: cameraDevicesCache,
			microphoneDevices: microphoneDevicesCache,
		};
	}

	if (message.type === "camera-devices-updated") {
		// Pages that enumerate from a context without device labels (the camera
		// preview iframe) publish an empty list; let it through only when nothing
		// is cached yet so it cannot wipe a populated list.
		if (message.devices.length > 0 || cameraDevicesCache.length === 0) {
			cameraDevicesCache = message.devices;
			broadcastCameraDevices(cameraDevicesCache);
		}
		return { ok: true, cameraDevices: cameraDevicesCache };
	}

	if (message.type === "start-recording") {
		const response = await startRecording(message.mode);
		if (response.ok && response.status) {
			setRecordingStatusAndBroadcast(response.status);
			if (isRecordingPreviewStatus(response.status)) {
				const settings = await loadSettings();
				if (isWebcamPreviewEnabled(settings)) {
					await saveWebcamPreviewDismissed(false);
					await showOverlayInActiveTab(settings, true);
				}
			}
		} else if (!response.ok && !response.canceled) {
			// Surface real failures: the panel already closed on "creating", so
			// this broadcast is what reopens it with the error message.
			setRecordingStatusAndBroadcast({
				phase: "error",
				message: response.error,
			});
		} else {
			// The user dismissed the capture picker; quietly return to idle.
			setRecordingStatusAndBroadcast({ phase: "idle" });
		}
		return response.ok
			? { ok: true, status: response.status }
			: { ok: false, error: response.error, canceled: response.canceled };
	}

	if (message.type === "stop-recording") {
		const response = await stopRecordingAndOpenDestination();
		return response.ok
			? { ok: true, status: response.status }
			: { ok: false, error: response.error };
	}

	if (message.type === "retry-upload") {
		const response = await sendOffscreen({
			target: "offscreen",
			type: "retry-upload",
			videoId: message.videoId,
		});
		if (response.ok && response.status) {
			setRecordingStatusAndBroadcast(response.status);
		}
		return response.ok
			? { ok: true, status: response.status }
			: { ok: false, error: response.error };
	}

	if (message.type === "get-recording-status") {
		const currentStatus = await syncRecordingStatus().catch(
			() => recordingStatus,
		);
		if (!bootstrapCache) {
			bootstrapCache = await loadCachedBootstrap();
		}
		return {
			ok: true,
			status: currentStatus,
			plan: bootstrapCache?.plan,
		};
	}

	if (
		message.type === "pause-recording" ||
		message.type === "resume-recording"
	) {
		const response = await forwardToOffscreen(message.type);
		if (response.ok && response.status) {
			setRecordingStatusAndBroadcast(response.status);
		}
		return response.ok
			? { ok: true, status: response.status }
			: { ok: false, error: response.error };
	}

	if (message.type === "open-options") {
		chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
		return { ok: true };
	}

	if (message.type === "open-how-it-works") {
		chrome.tabs.create({ url: chrome.runtime.getURL("how-it-works.html") });
		return { ok: true };
	}

	if (message.type === "close-extension-ui") {
		await closeAllExtensionUi();
		return { ok: true };
	}

	if (message.type === "settings-updated") {
		await saveSettings(message.settings);
		if (isWebcamPreviewEnabled(message.settings)) {
			await saveWebcamPreviewDismissed(false);
			await showOverlayInActiveTab(
				message.settings,
				isRecordingPreviewStatus(recordingStatus),
			);
		} else {
			await broadcastOverlayHide();
		}
		return { ok: true, settings: message.settings };
	}

	if (message.type === "close-webcam-preview") {
		const settings = await loadSettings();
		await saveWebcamPreviewDismissed(true);
		await broadcastOverlayHide();
		return { ok: true, settings };
	}

	if (message.type === "register-overlay-token") {
		// Tokens may only come from content scripts. Extension pages are
		// excluded so a web-accessible page embedded by a hostile site cannot
		// authorise itself.
		if (!isWebPageSender(sender)) {
			return { ok: false, error: "Unauthorized" };
		}
		await registerOverlayToken(message.token);
		return { ok: true };
	}

	if (message.type === "validate-overlay-token") {
		return { ok: true, valid: await isOverlayTokenRegistered(message.token) };
	}

	if (message.type === "connect-camera-preview") {
		const allowed = await isCameraPreviewRequestAllowed(
			sender,
			message.sessionId,
		);
		if (!allowed) {
			return { ok: false, error: "Camera preview is not authorized." };
		}
		const response = await sendOffscreen({
			target: "offscreen",
			type: "connect-camera-preview",
			sessionId: message.sessionId,
			settings: message.settings,
			offer: message.offer,
		});
		return response.ok
			? { ok: true, answer: response.answer }
			: { ok: false, error: response.error };
	}

	if (message.type === "disconnect-camera-preview") {
		const response = await sendOffscreen(
			{
				target: "offscreen",
				type: "disconnect-camera-preview",
				sessionId: message.sessionId,
			},
			{ createIfMissing: false },
		);
		return response.ok ? { ok: true } : { ok: false, error: response.error };
	}

	if (message.type === "camera-preview-event") {
		const tabId = sender.tab?.id;
		if (
			tabId === undefined ||
			!(await isCameraPreviewEventAllowed(sender, message.token))
		) {
			return { ok: false, error: "Unauthorized" };
		}
		chrome.tabs.sendMessage(
			tabId,
			{
				source: "cap-extension-camera-preview",
				token: message.token,
				event: message.event,
			} satisfies CameraPreviewEventRelay,
			() => {
				void chrome.runtime.lastError;
			},
		);
		return { ok: true };
	}

	if (message.type === "webcam-preview-ready") {
		await handlePreviewReady(sender.tab?.id);
		return { ok: true };
	}

	if (message.type === "confirm-result") {
		resolveRecordingConfirmation(message.requestId, message.confirmed);
		return { ok: true };
	}

	if (message.type === "show-countdown") {
		// Relay the offscreen recorder's countdown to the recorded tab. Inject
		// the overlay if it is not there yet; a tab that cannot host it (e.g. a
		// chrome:// page) just shows nothing while the recorder waits out the
		// same countdown, so the count is still kept out of the capture.
		if (message.tabId !== undefined) {
			void sendOverlay(message.tabId, {
				type: "overlay-countdown",
				seconds: message.seconds,
				durationMs: message.durationMs,
			}).catch(() => undefined);
		}
		return { ok: true };
	}

	if (message.type === "recording-capture-source") {
		await handleCaptureSource(message.source);
		return { ok: true };
	}

	if (message.type === "webcam-preview-error") {
		await handlePreviewError(sender.tab?.id, message.reason);
		return { ok: true };
	}

	return { ok: false, error: "Unknown request" };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (isRecordingStatusBroadcast(message)) {
		setRecordingStatusAndBroadcast(message.status);
		if (!isCapturingRecordingStatus(message.status)) {
			externalCaptureAutoPipPending = false;
			void saveWebcamPreviewDismissed(true)
				.then(() => broadcastOverlayHide())
				.catch(() => undefined);
		}
		if (message.status.phase === "completed") {
			const shareUrl = message.status.shareUrl;
			void getUploadProgressTabId()
				.then((tabId) => {
					if (tabId === null) return undefined;
					setUploadProgressTabId(null);
					return updateTab(tabId, shareUrl);
				})
				.catch(() => undefined);
		}
		return false;
	}

	if (!isServiceWorkerRequest(message)) return false;

	handleRequest(message, _sender)
		.then(sendResponse)
		.catch((error: unknown) => {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			} satisfies ServiceWorkerResponse);
		});

	return true;
});

chrome.runtime.onInstalled.addListener((details) => {
	void updateActionForStatus(recordingStatus);
	void injectOverlayIntoOpenTabs();
	if (details.reason === "install") {
		void createTab(chrome.runtime.getURL("welcome.html")).catch(
			() => undefined,
		);
	}
});

chrome.action.onClicked.addListener((tab) => {
	void syncRecordingStatus()
		.catch(() => recordingStatus)
		.then((currentStatus) => {
			if (isCapturingRecordingStatus(currentStatus)) {
				return stopRecordingAndOpenDestination().then(() => undefined);
			}
			return openRecorderPanel(tab);
		})
		.catch(() => undefined);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
	void syncActivePreview(tabId).catch(() => undefined);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
	if (windowId === chrome.windows.WINDOW_ID_NONE) {
		browserWindowFocused = false;
		void enterActivePreviewAutoPip();
		return;
	}
	browserWindowFocused = true;
	externalCaptureAutoPipPending = false;
	void exitActivePreviewAutoPip()
		.then(() => syncActivePreview())
		.catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status === "complete" && tab.active) {
		void syncActivePreview(tabId).catch(() => undefined);
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	if (uploadProgressTabId === tabId) {
		setUploadProgressTabId(null);
	} else if (uploadProgressTabId === null) {
		// A restarted worker may only hold the id in session storage.
		void loadUploadProgressTabId()
			.then((persisted) =>
				persisted === tabId ? saveUploadProgressTabId(null) : undefined,
			)
			.catch(() => undefined);
	}
	if (activePreviewTabId === tabId) {
		activePreviewTabId = null;
	}
	if (pendingPreviewTabId === tabId) {
		pendingPreviewTabId = null;
	}
	if (readyPreviewTabId === tabId) {
		readyPreviewTabId = null;
	}
});
