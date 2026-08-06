import { capabilities } from "../platform/capabilities";
import { wait } from "../shared/runtime";

// The recorder document (recorder.html) hosts capture, upload, device
// enumeration, the mic probe and the camera-preview relay. On Chrome it runs
// as an offscreen document; Firefox has no offscreen API, so it runs in a
// small popup window instead (minimized unless the user must interact with
// it — getDisplayMedia there requires transient user activation, which the
// page collects with an arm button). Either way the document closes itself
// once idle, so this module only ever has to create and find it.
export const RECORDER_URL = "recorder.html";

const RECORDER_WINDOW_WIDTH = 440;
const RECORDER_WINDOW_HEIGHT = 400;
const RECORDER_READY_TIMEOUT_MS = 10_000;
const RECORDER_READY_POLL_INTERVAL_MS = 100;

let recorderHostCreation: Promise<void> | null = null;

type RecorderContext = {
	documentUrl?: string;
	windowId?: number;
};

// Match by document URL only: Chrome reports the recorder as an
// OFFSCREEN_DOCUMENT context while Firefox's popup window may surface as TAB
// (or another type — the spec leaves extension pages in popup windows
// underspecified). Only the recorder document ever has this URL, so the URL
// filter alone is unambiguous on both browsers.
const getRecorderContexts = async (): Promise<RecorderContext[]> => {
	const recorderUrl = chrome.runtime.getURL(RECORDER_URL);
	return new Promise((resolve) => {
		chrome.runtime.getContexts({ documentUrls: [recorderUrl] }, (contexts) =>
			resolve(contexts ?? []),
		);
	});
};

export const hasRecorderHost = async () =>
	(await getRecorderContexts()).length > 0;

const recorderWindowIdFrom = (contexts: RecorderContext[]) => {
	for (const context of contexts) {
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

// Center the interactive recorder window over the browser window the user is
// looking at, so the arm dialog reads as part of the flow rather than a stray
// popup.
const getCenteredBounds = () =>
	new Promise<{ left?: number; top?: number }>((resolve) => {
		chrome.windows.getLastFocused((focusedWindow) => {
			if (
				chrome.runtime.lastError ||
				focusedWindow?.left === undefined ||
				focusedWindow.top === undefined ||
				!focusedWindow.width ||
				!focusedWindow.height
			) {
				resolve({});
				return;
			}
			resolve({
				left: Math.max(
					0,
					Math.round(
						focusedWindow.left +
							(focusedWindow.width - RECORDER_WINDOW_WIDTH) / 2,
					),
				),
				top: Math.max(
					0,
					Math.round(
						focusedWindow.top +
							(focusedWindow.height - RECORDER_WINDOW_HEIGHT) / 2,
					),
				),
			});
		});
	});

const createRecorderWindow = async (interactive: boolean) => {
	// state cannot be combined with bounds or focus in windows.create.
	const createData: chrome.windows.CreateData = interactive
		? {
				url: RECORDER_URL,
				type: "popup",
				focused: true,
				width: RECORDER_WINDOW_WIDTH,
				height: RECORDER_WINDOW_HEIGHT,
				...(await getCenteredBounds()),
			}
		: { url: RECORDER_URL, type: "popup", state: "minimized" };
	const windowId = await new Promise<number | undefined>((resolve, reject) => {
		chrome.windows.create(createData, (created) => {
			const error = chrome.runtime.lastError;
			if (error) {
				reject(new Error(error.message ?? "Failed to open the Cap recorder"));
				return;
			}
			resolve(created?.id);
		});
	});

	try {
		await waitForRecorderReady();
	} catch (error) {
		// Close the unresponsive window, or every later ensureRecorderHost call
		// would find its context, assume the host is healthy, and fail forever.
		if (windowId !== undefined) {
			await new Promise<void>((resolve) => {
				chrome.windows.remove(windowId, () => {
					void chrome.runtime.lastError;
					resolve();
				});
			});
		}
		throw error;
	}
};

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
		await wait(RECORDER_READY_POLL_INTERVAL_MS);
	}
	throw new Error("The Cap recorder window did not become ready in time");
};

const focusRecorderWindow = (windowId: number) =>
	new Promise<void>((resolve) => {
		chrome.windows.update(windowId, { focused: true, state: "normal" }, () => {
			void chrome.runtime.lastError;
			resolve();
		});
	});

// Ensures the recorder document exists; with `interactive` it also brings the
// Firefox recorder window forward so the user can click its arm button (and
// see permission prompts anchored to it). Chrome's offscreen document has no
// window, so `interactive` is a no-op there.
export const ensureRecorderHost = async (
	options: { interactive?: boolean } = {},
) => {
	const contexts = await getRecorderContexts();
	if (contexts.length > 0) {
		if (options.interactive === true && !capabilities.supportsOffscreen) {
			const windowId = recorderWindowIdFrom(contexts);
			if (windowId !== null) await focusRecorderWindow(windowId);
		}
		return;
	}

	recorderHostCreation ??= (
		capabilities.supportsOffscreen
			? createOffscreenDocument()
			: createRecorderWindow(options.interactive === true)
	).finally(() => {
		recorderHostCreation = null;
	});
	await recorderHostCreation;
};
