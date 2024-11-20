import { createStore } from "solid-js/store";
import type { JSX } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";

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
  transparent: boolean;
  theme: "light" | "dark";
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
  transparent: false,
  theme: "light",
});

async function initializeTitlebar() {
  const currentWindow = getCurrentWindow();

  if (ostype() !== "macos" && (await currentWindow.isResizable())) {
    const [maximized, maximizable] = await Promise.all([
      currentWindow.isMaximized(),
      currentWindow.isMaximizable(),
    ]);

    setState({
      maximized,
      maximizable,
    });
  }

  return await currentWindow.onResized((_) => {
    currentWindow.isMaximized().then((maximized) => {
      setState("maximized", maximized);
    });
  });
}

export { setState as setTitlebar, initializeTitlebar };
export default state;
