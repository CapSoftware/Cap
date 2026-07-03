import { capabilities } from "../platform/capabilities";

// The recorder document (recorder.html) hosts capture, upload, device
// enumeration, the mic probe and the camera-preview relay. On Chrome it runs
// as an offscreen document; Firefox has no offscreen API, so it runs in a
// small popup window instead (minimized unless the user must interact with
// it — getDisplayMedia there requires transient user activation, which the
// page collects with an arm button). Either way the document closes itself
// once idle, so this module only ever has to create and find it.
export const RECORDER_URL = "recorder.html";

const RECORDER_WINDOW_WIDTH = 400;
const RECORDER_WINDOW_HEIGHT = 360;
const RECORDER_READY_TIMEOUT_MS = 10_000;
const RECORDER_READY_POLL_INTERVAL_MS = 100;

let recorderHostCreation: Promise<void> | null = null;

type RecorderContext = {
	documentUrl?: string;
	windowId?: number;
};

const getRecorderContexts = async (): Promise<RecorderContext[]> => {
	const recorderUrl = chrome.runtime.getURL(RECORDER_URL);
	// String literals rather than the chrome.runtime.ContextType enum object,
	// which Firefox does not guarantee to expose.
	const contextType = (
		capabilities.supportsOffscreen ? "OFFSCREEN_DOCUMENT" : "TAB"
	) as chrome.runtime.ContextType;
	return new Promise((resolve) => {
		chrome.runtime.getContexts(
			{
				contextTypes: [contextType],
				documentUrls: [recorderUrl],
			},
			(contexts) => resolve(contexts ?? []),
		);
	});
};

export const hasRecorderHost = async () =>
	(await getRecorderContexts()).length > 0;

const getRecorderWindowId = async () => {
	for (const context of await getRecorderContexts()) {
		if (typeof context.windowId === "number" && context.windowId >= 0) {
			return context.windowId;
		}
	}
	return null;
};

const createOffscreenDocument = () =>
	new Promise<void>((resolve, reject) => {
		chrome.offscreen.createDocument(
			{
				url: RECORDER_URL,
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

const createRecorderWindow = (interactive: boolean) =>
	new Promise<void>((resolve, reject) => {
		// state cannot be combined with bounds or focus in windows.create.
		const createData: chrome.windows.CreateData = interactive
			? {
					url: RECORDER_URL,
					type: "popup",
					focused: true,
					width: RECORDER_WINDOW_WIDTH,
					height: RECORDER_WINDOW_HEIGHT,
				}
			: { url: RECORDER_URL, type: "popup", state: "minimized" };
		chrome.windows.create(createData, () => {
			const error = chrome.runtime.lastError;
			if (error) {
				reject(new Error(error.message ?? "Failed to open the Cap recorder"));
				return;
			}
			resolve();
		});
	});

const pingRecorder = () =>
	new Promise<boolean>((resolve) => {
		chrome.runtime.sendMessage(
			{ target: "offscreen", type: "get-recording-status" },
			(response) => {
				resolve(!chrome.runtime.lastError && Boolean(response));
			},
		);
	});

// chrome.offscreen.createDocument resolves only once the document has loaded,
// but windows.create resolves as soon as the window exists, well before the
// recorder script runs — so the Firefox path waits until the document
// actually answers before callers start sending it real messages.
const waitForRecorderReady = async () => {
	const deadline = Date.now() + RECORDER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await pingRecorder()) return;
		await new Promise((resolve) => {
			globalThis.setTimeout(resolve, RECORDER_READY_POLL_INTERVAL_MS);
		});
	}
	throw new Error("The Cap recorder window did not become ready in time");
};

export const ensureRecorderHost = async (
	options: { interactive?: boolean } = {},
) => {
	const contexts = await getRecorderContexts();
	if (contexts.length > 0) return;

	recorderHostCreation ??= (
		capabilities.supportsOffscreen
			? createOffscreenDocument()
			: createRecorderWindow(options.interactive === true).then(
					waitForRecorderReady,
				)
	).finally(() => {
		recorderHostCreation = null;
	});
	await recorderHostCreation;
};

// Brings the Firefox recorder window forward so the user can click its arm
// button (and see any permission prompts anchored to it). No-op on Chrome.
export const focusRecorderHost = async () => {
	if (capabilities.supportsOffscreen) return;
	const windowId = await getRecorderWindowId();
	if (windowId === null) return;
	await new Promise<void>((resolve) => {
		chrome.windows.update(windowId, { focused: true, state: "normal" }, () => {
			void chrome.runtime.lastError;
			resolve();
		});
	});
};
