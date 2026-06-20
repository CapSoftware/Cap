// Messages the bootstrap content script acknowledged while the overlay module
// was still being fetched. Each message-handling component replays them once on
// mount so the signal that triggered the lazy load (a panel toggle, a webcam
// settings push, a confirm prompt) is not dropped.
let startupMessages: readonly unknown[] = [];

export const setStartupMessages = (messages: readonly unknown[]) => {
	startupMessages = messages;
};

export const replayStartupMessages = (
	handleMessage: (
		message: unknown,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void,
	) => boolean | undefined,
) => {
	for (const message of startupMessages) {
		handleMessage(message, {} as chrome.runtime.MessageSender, () => undefined);
	}
};
