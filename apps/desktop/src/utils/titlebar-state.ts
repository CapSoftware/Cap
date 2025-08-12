import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import type { JSX } from "solid-js";
import { createStore } from "solid-js/store";

export interface TitlebarState {
	height: string;
	hideMaximize: boolean;
	order: "right" | "left" | "platform";
	items?: JSX.Element;
	maximized: boolean;
	maximizable: boolean;
	minimizable: boolean;
	closable: boolean;
	border: boolean;
	backgroundColor: string | null;
	transparent: boolean;
}

const [state, setState] = createStore<TitlebarState>({
	height: "36px",
	hideMaximize: true,
	order: "platform",
	items: null,
	maximized: false,
	maximizable: false,
	minimizable: true,
	closable: true,
	border: true,
	backgroundColor: null,
	transparent: false,
});

async function initializeTitlebar(): Promise<UnlistenFn | undefined> {
	console.log("initailizing titlebar");
	if (ostype() === "macos") return;
	const currentWindow = getCurrentWindow();
	const resizable = await currentWindow.isResizable();
	if (!resizable) return;

	const [maximized, maximizable] = await Promise.all([
		currentWindow.isMaximized(),
		currentWindow.isMaximizable(),
	]);

	setState({
		maximized,
		maximizable,
	});

	return await currentWindow.onResized((_) => {
		currentWindow.isMaximized().then((maximized) => {
			setState("maximized", maximized);
		});
	});
}

export { initializeTitlebar };
export default state;
