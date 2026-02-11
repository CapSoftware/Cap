import type {
	BackgroundToContentMessage,
	CameraState,
	PopupMessage,
} from "../lib/messages";
import type { OffscreenMessage } from "../lib/offscreen-messages";

const CAMERA_STATE_KEY = "cap_camera_state";
const CAMERA_TAB_KEY = "cap_camera_tab";
const LAST_FRAME_KEY = "cap_camera_last_frame";

function getCameraState(): Promise<CameraState | null> {
	return new Promise((resolve) => {
		chrome.storage.session.get(
			[CAMERA_STATE_KEY],
			(items: Record<string, unknown>) => {
				const state = items[CAMERA_STATE_KEY];
				if (state && typeof state === "object") {
					resolve(state as CameraState);
				} else {
					resolve(null);
				}
			},
		);
	});
}

function setCameraState(state: CameraState | null): Promise<void> {
	return new Promise((resolve) => {
		if (!state) {
			chrome.storage.session.remove([CAMERA_STATE_KEY, CAMERA_TAB_KEY], () =>
				resolve(),
			);
			return;
		}
		chrome.storage.session.set({ [CAMERA_STATE_KEY]: state }, () => resolve());
	});
}

function getCameraTabId(): Promise<number | null> {
	return new Promise((resolve) => {
		chrome.storage.session.get(
			[CAMERA_TAB_KEY],
			(items: Record<string, unknown>) => {
				const tabId = items[CAMERA_TAB_KEY];
				resolve(typeof tabId === "number" ? tabId : null);
			},
		);
	});
}

function setCameraTabId(tabId: number | null): Promise<void> {
	return new Promise((resolve) => {
		if (tabId === null) {
			chrome.storage.session.remove([CAMERA_TAB_KEY], () => resolve());
			return;
		}
		chrome.storage.session.set({ [CAMERA_TAB_KEY]: tabId }, () => resolve());
	});
}

function getLastFrame(): Promise<string | null> {
	return new Promise((resolve) => {
		chrome.storage.session.get(
			[LAST_FRAME_KEY],
			(items: Record<string, unknown>) => {
				const frame = items[LAST_FRAME_KEY];
				resolve(typeof frame === "string" ? frame : null);
			},
		);
	});
}

function setLastFrame(dataUrl: string | null): Promise<void> {
	return new Promise((resolve) => {
		if (!dataUrl) {
			chrome.storage.session.remove([LAST_FRAME_KEY], () => resolve());
			return;
		}
		chrome.storage.session.set({ [LAST_FRAME_KEY]: dataUrl }, () => resolve());
	});
}

function sendToTab(tabId: number, message: BackgroundToContentMessage): void {
	chrome.tabs.sendMessage(tabId, message);
}

let injectVersion = 0;

async function getActiveTabId(): Promise<number | null> {
	return new Promise((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const tab = tabs[0];
			resolve(tab?.id ?? null);
		});
	});
}

async function injectContentScript(tabId: number): Promise<void> {
	return new Promise((resolve, reject) => {
		chrome.scripting.executeScript(
			{
				target: { tabId },
				files: ["content-script.js"],
			},
			() => {
				if (chrome.runtime.lastError) {
					reject(new Error(chrome.runtime.lastError.message));
					return;
				}
				resolve();
			},
		);
	});
}

const OFFSCREEN_URL = "offscreen.html";

async function hasOffscreenDocument(): Promise<boolean> {
	const contexts = await chrome.runtime.getContexts({
		contextTypes: ["OFFSCREEN_DOCUMENT"],
	});
	return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
	if (await hasOffscreenDocument()) return;

	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: ["USER_MEDIA"],
		justification: "Persistent camera stream for WebRTC relay",
	});
}

async function closeOffscreenDocument(): Promise<void> {
	if (!(await hasOffscreenDocument())) return;
	await chrome.offscreen.closeDocument();
}

function sendToOffscreen(message: OffscreenMessage): Promise<unknown> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(message, (response) => {
			resolve(response);
		});
	});
}

async function captureLastFrame(mirrored: boolean): Promise<string | null> {
	if (!(await hasOffscreenDocument())) return null;

	const response = (await sendToOffscreen({
		type: "OFFSCREEN_CAPTURE_FRAME",
		mirrored,
	})) as { dataUrl?: unknown } | null;

	return typeof response?.dataUrl === "string" ? response.dataUrl : null;
}

async function handleShowCamera(state: CameraState): Promise<void> {
	const existingTabId = await getCameraTabId();
	if (existingTabId !== null) {
		sendToTab(existingTabId, { type: "REMOVE_CAMERA" });
	}

	const tabId = await getActiveTabId();
	if (tabId === null) return;

	await setCameraState(state);
	await setCameraTabId(tabId);
	await setLastFrame(null);

	await ensureOffscreenDocument();
	await sendToOffscreen({
		type: "OFFSCREEN_START_CAMERA",
		deviceId: state.deviceId,
	});

	try {
		await injectContentScript(tabId);
	} catch {
		return;
	}

	setTimeout(() => {
		sendToTab(tabId, { type: "INJECT_CAMERA", state });
	}, 100);
}

async function handleMoveCameraToTab(tabId: number): Promise<void> {
	const version = ++injectVersion;

	const state = await getCameraState();
	if (!state || version !== injectVersion) return;

	const currentTabId = await getCameraTabId();
	if (currentTabId === tabId) return;
	if (version !== injectVersion) return;

	let lastFrameDataUrl: string | null = null;
	if (currentTabId !== null) {
		lastFrameDataUrl = await captureLastFrame(state.mirrored);
		if (version !== injectVersion) return;
		sendToTab(currentTabId, { type: "REMOVE_CAMERA" });
	}

	if (lastFrameDataUrl) {
		await setLastFrame(lastFrameDataUrl);
	} else {
		lastFrameDataUrl = await getLastFrame();
	}
	if (version !== injectVersion) return;

	await setCameraTabId(tabId);
	if (version !== injectVersion) return;

	try {
		await injectContentScript(tabId);
	} catch {
		return;
	}
	if (version !== injectVersion) return;

	setTimeout(() => {
		if (version !== injectVersion) return;
		sendToTab(tabId, { type: "INJECT_CAMERA", state, lastFrameDataUrl });
	}, 100);
}

async function handleHideCamera(): Promise<void> {
	const tabId = await getCameraTabId();
	if (tabId !== null) {
		sendToTab(tabId, { type: "REMOVE_CAMERA" });
	}

	if (await hasOffscreenDocument()) {
		await sendToOffscreen({ type: "OFFSCREEN_STOP_CAMERA" });
		await closeOffscreenDocument();
	}

	await setCameraState(null);
	await setLastFrame(null);
}

async function handleUpdateCamera(
	partial: Partial<CameraState>,
): Promise<void> {
	const current = await getCameraState();
	if (!current) return;

	const updated = { ...current, ...partial };
	await setCameraState(updated);

	if (partial.deviceId && partial.deviceId !== current.deviceId) {
		if (await hasOffscreenDocument()) {
			await sendToOffscreen({
				type: "OFFSCREEN_SWITCH_CAMERA",
				deviceId: partial.deviceId,
			});
		}
	}

	const tabId = await getCameraTabId();
	if (tabId !== null) {
		sendToTab(tabId, { type: "UPDATE_CAMERA_CONTENT", state: partial });
	}
}

chrome.runtime.onMessage.addListener(
	(
		message: unknown,
		_sender: ChromeMessageSender,
		sendResponse: ChromeMessageResponse,
	) => {
		const msg = message as PopupMessage;

		if (msg.type === "SHOW_CAMERA") {
			handleShowCamera(msg.state).then(() => sendResponse({ ok: true }));
			return true;
		}

		if (msg.type === "HIDE_CAMERA") {
			handleHideCamera().then(() => sendResponse({ ok: true }));
			return true;
		}

		if (msg.type === "UPDATE_CAMERA") {
			handleUpdateCamera(msg.state).then(() => sendResponse({ ok: true }));
			return true;
		}

		if (msg.type === "GET_CAMERA_STATE") {
			getCameraState().then((state) => sendResponse({ state }));
			return true;
		}

		return false;
	},
);

chrome.tabs.onRemoved.addListener((tabId: number) => {
	getCameraTabId().then((cameraTabId) => {
		if (cameraTabId === tabId) {
			setCameraTabId(null);
		}
	});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
	handleMoveCameraToTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status !== "complete") return;

	getCameraTabId().then(async (cameraTabId) => {
		if (cameraTabId !== tabId) return;

		const version = ++injectVersion;

		const state = await getCameraState();
		if (!state || version !== injectVersion) return;

		let lastFrameDataUrl = await captureLastFrame(state.mirrored);
		if (version !== injectVersion) return;

		if (lastFrameDataUrl) {
			await setLastFrame(lastFrameDataUrl);
		} else {
			lastFrameDataUrl = await getLastFrame();
		}
		if (version !== injectVersion) return;

		try {
			await injectContentScript(tabId);
		} catch {
			return;
		}
		if (version !== injectVersion) return;

		setTimeout(() => {
			if (version !== injectVersion) return;
			sendToTab(tabId, {
				type: "INJECT_CAMERA",
				state,
				lastFrameDataUrl,
			});
		}, 100);
	});
});

chrome.windows.onFocusChanged.addListener((windowId) => {
	getCameraTabId().then((tabId) => {
		if (tabId === null) return;
		if (windowId === chrome.windows.WINDOW_ID_NONE) {
			sendToTab(tabId, { type: "ENTER_CAMERA_PIP" });
		} else {
			sendToTab(tabId, { type: "EXIT_CAMERA_PIP" });
		}
	});
});
