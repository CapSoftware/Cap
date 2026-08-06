// The recorder document (recorder.html) hosts capture, upload, device
// enumeration, the mic probe and the camera-preview relay. On Chrome it runs
// as an offscreen document; this module owns its lifecycle so the rest of the
// service worker never touches chrome.offscreen directly.
//
// On Firefox there is no offscreen document API; hasRecorderHost and
// ensureRecorderHost return early so the service worker can import this module
// on both targets without reaching Chrome-only APIs at runtime.
import { capabilities } from "../platform/capabilities";

export const RECORDER_URL = "recorder.html";

let recorderDocumentCreation: Promise<void> | null = null;

const getRecorderContexts = async () => {
	const recorderUrl = chrome.runtime.getURL(RECORDER_URL);
	return new Promise<Array<{ documentUrl?: string }>>((resolve) => {
		chrome.runtime.getContexts(
			{
				contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
				documentUrls: [recorderUrl],
			},
			(contexts) => resolve(contexts),
		);
	});
};

export const hasRecorderHost = async () => {
	if (!capabilities.supportsOffscreen) return false;
	return (await getRecorderContexts()).length > 0;
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

export const ensureRecorderHost = async () => {
	if (!capabilities.supportsOffscreen) return;
	const contexts = await getRecorderContexts();
	if (contexts.length > 0) return;

	recorderDocumentCreation ??= createOffscreenDocument().finally(() => {
		recorderDocumentCreation = null;
	});
	await recorderDocumentCreation;
};
