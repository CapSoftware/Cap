import { createSignal } from "solid-js";
import { generalSettingsStore } from "~/store";
import type { GeneralSettingsStore } from "~/utils/tauri";
import { emit, listen } from "@tauri-apps/api/event";

const THEME_CHANGE_EVENT = "theme-change";
const [isDarkMode, setIsDarkMode] = createSignal(false);

const applyTheme = (darkMode: boolean) => {
  setIsDarkMode(darkMode);
  document.documentElement.classList.toggle("dark", darkMode);
};

export const themeStore = {
  isDarkMode,
  toggleTheme: async () => {
    const newValue = !isDarkMode();
    applyTheme(newValue);
    await generalSettingsStore.set({ darkMode: newValue } as Partial<GeneralSettingsStore>);
    // Emit theme change event to other windows
    await emit(THEME_CHANGE_EVENT, { darkMode: newValue });
  },
  initialize: async () => {
    const settings = await generalSettingsStore.get();
    
    // Check system preference if no setting is saved
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const darkMode = settings?.darkMode ?? prefersDark;
    
    applyTheme(darkMode);
    
    // Listen for theme changes from other windows
    await listen(THEME_CHANGE_EVENT, (event: any) => {
      applyTheme(event.payload.darkMode);
    });
    
    // Listen for system theme changes
    window.matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        // Only change theme if user hasn't explicitly set a preference
        if (settings?.darkMode === undefined) {
          applyTheme(e.matches);
          emit(THEME_CHANGE_EVENT, { darkMode: e.matches });
        }
      });
  },
};
