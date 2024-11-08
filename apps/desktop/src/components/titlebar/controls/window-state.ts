import { getCurrentWindow } from "@tauri-apps/api/window";
import { createRoot, createSignal } from "solid-js";

// Create a store to hold window state
export const WindowState = createRoot(() => {
  const [isMaximized, setIsMaximized] = createSignal(false);
  const [isMaximizable, setIsMaximizable] = createSignal(false);
  const [isMinimizable, setIsMinimizable] = createSignal(true);
  const [isClosable, setIsClosable] = createSignal(true);

  // Initialize window state
  const initializeState = async () => {
    const currentWindow = getCurrentWindow();
    setIsMaximizable(await currentWindow.isMaximizable());
    setIsMinimizable(await currentWindow.isMinimizable());
    setIsClosable(await currentWindow.isClosable());

    // Listen for window resize events
    await currentWindow.listen("tauri://resize", async () => {
      setIsMaximized(await currentWindow.isMaximized());
    });
  };

  const currentWindow = getCurrentWindow();

  // Initialize the state
  initializeState().catch(console.error);

  return {
    isMaximized,
    isMaximizable,
    isMinimizable,
    isClosable,
    maximize: () => currentWindow.maximize(),
    minimize: () => currentWindow.minimize(),
    unmaximize: () => currentWindow.unmaximize,
    close: () => currentWindow.close(),
  };
});

// Export individual functions and signals
export const {
  isMinimizable,
  isMaximizable,
  isClosable,
  isMaximized,
  maximize,
  unmaximize,
  minimize,
  close,
} = WindowState;
