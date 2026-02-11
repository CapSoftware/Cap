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

async function captureLastFrame(tabId: number): Promise<string | null> {
	return new Promise((resolve) => {
		let done = false;

		const timeoutId = setTimeout(() => {
			if (done) return;
			done = true;
			resolve(null);
		}, 900);

		chrome.tabs.sendMessage(
			tabId,
			{ type: "CAPTURE_LAST_FRAME" },
			(response) => {
				if (done) return;
				done = true;
				clearTimeout(timeoutId);

				if (chrome.runtime.lastError) {
					resolve(null);
					return;
				}

				const res = response as { dataUrl?: unknown } | null;
				resolve(typeof res?.dataUrl === "string" ? res.dataUrl : null);
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
	const state = await getCameraState();
	if (!state) return;

	const currentTabId = await getCameraTabId();
	if (currentTabId === tabId) return;

	try {
		await injectContentScript(tabId);
	} catch {
		return;
	}

	const lastFrameDataUrl =
		currentTabId !== null ? await captureLastFrame(currentTabId) : null;

	if (currentTabId !== null) {
		sendToTab(currentTabId, { type: "REMOVE_CAMERA" });
	}

	await setCameraTabId(tabId);
	sendToTab(tabId, { type: "INJECT_CAMERA", state, lastFrameDataUrl });
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
	handleMoveCameraToTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status !== "complete") return;

	getCameraTabId().then((cameraTabId) => {
		if (cameraTabId !== tabId) return;
		getCameraState().then((state) => {
			if (!state) return;
			injectContentScript(tabId)
				.then(() => {
					sendToTab(tabId, { type: "INJECT_CAMERA", state });
				})
				.catch(() => {});
		});
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
