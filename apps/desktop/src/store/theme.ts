import { createSignal } from "solid-js";
import { generalSettingsStore } from "~/store";
import type { GeneralSettingsStore } from "~/utils/tauri";

const [isDarkMode, setIsDarkMode] = createSignal(false);

export const themeStore = {
  isDarkMode,
  toggleTheme: async () => {
    const newValue = !isDarkMode();
    setIsDarkMode(newValue);
    document.documentElement.classList.toggle("dark", newValue);
    await generalSettingsStore.set({ darkMode: newValue } as Partial<GeneralSettingsStore>);
  },
  initialize: async () => {
    const settings = await generalSettingsStore.get();
    
    // Check system preference if no setting is saved
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const darkMode = settings?.darkMode ?? prefersDark;
    
    setIsDarkMode(darkMode);
    document.documentElement.classList.toggle("dark", darkMode);
    
    // Listen for system theme changes
    window.matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        // Only change theme if user hasn't explicitly set a preference
        if (settings?.darkMode === undefined) {
          setIsDarkMode(e.matches);
          document.documentElement.classList.toggle("dark", e.matches);
        }
      });
  },
};
