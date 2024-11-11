import { createStore } from "solid-js/store";
import type { JSX } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "./tauri";
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
}

const [state, setState] = createStore<TitlebarState>({
  height: "44px",
  hideMaximize: false,
  order: "platform",
  items: undefined,
  maximized: false,
  maximizable: false,
  minimizable: true,
  closable: true,
  border: true,
});

async function initializeTitlebar() {
  const currentWindow = getCurrentWindow();

  const [maximized, maximizable, closable] = await Promise.all([
    currentWindow.isMaximized(),
    currentWindow.isMaximizable(),
    currentWindow.isClosable(),
  ]);
  if (ostype() === "macos") commands.positionTrafficLights(null);

  setState({ maximized, maximizable, closable });

  return await currentWindow.onResized(() => {
    currentWindow.isMaximized().then((maximized) => {
      setState("maximized", maximized);
    });
  });
}

export { setState as setTitlebar, initializeTitlebar };
export default state;
