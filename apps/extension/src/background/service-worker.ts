import type {
	BackgroundToContentMessage,
	CameraState,
	PopupMessage,
} from "../lib/messages";

const CAMERA_STATE_KEY = "cap_camera_state";
const CAMERA_TAB_KEY = "cap_camera_tab";

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

function sendToTab(tabId: number, message: BackgroundToContentMessage): void {
	chrome.tabs.sendMessage(tabId, message);
}

async function getActiveTabId(): Promise<number | null> {
	return new Promise((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const tab = tabs[0];
			resolve(tab?.id ?? null);
		});
	});
}

async function injectContentScript(tabId: number): Promise<void> {
	return new Promise((resolve) => {
		chrome.scripting.executeScript(
			{
				target: { tabId },
				files: ["content-script.js"],
			},
			() => {
				resolve();
			},
		);
	});
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
	await injectContentScript(tabId);

	setTimeout(() => {
		sendToTab(tabId, { type: "INJECT_CAMERA", state });
	}, 100);
}

async function handleHideCamera(): Promise<void> {
	const tabId = await getCameraTabId();
	if (tabId !== null) {
		sendToTab(tabId, { type: "REMOVE_CAMERA" });
	}
	await setCameraState(null);
}

async function handleUpdateCamera(
	partial: Partial<CameraState>,
): Promise<void> {
	const current = await getCameraState();
	if (!current) return;

	const updated = { ...current, ...partial };
	await setCameraState(updated);

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
			setCameraState(null);
		}
	});
});
