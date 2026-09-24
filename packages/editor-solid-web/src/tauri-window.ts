import { emitEditorEvent, listenEditorEvent } from "./tauri-bridge";

type CloseRequestedHandler = (event: {
	preventDefault: () => void;
}) => void | Promise<void>;

const closeRequestedHandlers = new Set<CloseRequestedHandler>();
let closeInProgress = false;

export const ProgressBarStatus = {
	None: "none",
	Normal: "normal",
	Indeterminate: "indeterminate",
	Paused: "paused",
	Error: "error",
} as const;

export const Effect = {
	HudWindow: "hudWindow",
	WindowBackground: "windowBackground",
} as const;

export const EffectState = {
	FollowsWindowActiveState: "followsWindowActiveState",
} as const;

const currentWindow = {
	label: "editor-web",
	listen<T>(name: string, callback: (event: { payload: T }) => void) {
		return listenEditorEvent(name, (payload) =>
			callback({ payload: payload as T }),
		);
	},
	emit(name: string, payload?: unknown) {
		return emitEditorEvent(name, payload);
	},
	show: async () => undefined,
	hide: async () => undefined,
	setFocus: async () => window.focus(),
	close: async () => {
		if (closeInProgress || closeRequestedHandlers.size === 0) {
			await emitEditorEvent("editor-close-approved");
			return;
		}
		closeInProgress = true;
		let prevented = false;
		try {
			for (const handler of closeRequestedHandlers) {
				await handler({
					preventDefault: () => {
						prevented = true;
					},
				});
			}
			if (!prevented) await emitEditorEvent("editor-close-approved");
		} finally {
			closeInProgress = false;
		}
	},
	setEffects: async () => undefined,
	setProgressBar: async () => undefined,
	isFocused: async () => document.hasFocus(),
	isResizable: async () => true,
	isMaximized: async () => false,
	isMaximizable: async () => true,
	onResized(
		callback: (event: { payload: { width: number; height: number } }) => void,
	) {
		const listener = () =>
			callback({ payload: { width: innerWidth, height: innerHeight } });
		window.addEventListener("resize", listener);
		return Promise.resolve(() =>
			window.removeEventListener("resize", listener),
		);
	},
	onFocusChanged(callback: (event: { payload: boolean }) => void) {
		const focused = () => callback({ payload: true });
		const blurred = () => callback({ payload: false });
		window.addEventListener("focus", focused);
		window.addEventListener("blur", blurred);
		return Promise.resolve(() => {
			window.removeEventListener("focus", focused);
			window.removeEventListener("blur", blurred);
		});
	},
	async onCloseRequested(callback: CloseRequestedHandler) {
		closeRequestedHandlers.add(callback);
		try {
			const unlisten = await listenEditorEvent("editor-close-requested", () =>
				callback({
					preventDefault: () => {
						void emitEditorEvent("editor-close-prevented");
					},
				}),
			);
			return () => {
				closeRequestedHandlers.delete(callback);
				unlisten();
			};
		} catch (error) {
			closeRequestedHandlers.delete(callback);
			throw error;
		}
	},
};

export function getCurrentWindow() {
	return currentWindow;
}

export function getCurrentWebviewWindow() {
	return currentWindow;
}
