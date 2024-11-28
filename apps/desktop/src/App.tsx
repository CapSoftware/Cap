import { Router, useCurrentMatches } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import {
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  onCleanup,
  onMount,
  Suspense,
} from "solid-js";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import {
  getCurrentWindow,
  type Theme as TauriTheme,
} from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";
import { generalSettingsStore } from "./store";
import { commands, type AppTheme } from "./utils/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { setTheme } from "@tauri-apps/api/app";

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: {
      onError: (e) => {
        message(`An error occured, here are the details:\n${e}`);
      },
    },
  },
});

export default function App() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  createThemeListener();

  return (
    <ErrorBoundary
      fallback={(e: Error) => {
        console.error(e);
        return (
          <>
            <p>{e.toString()}</p>
            <p>{e.stack?.toString()}</p>
          </>
        );
      }}
    >
      <QueryClientProvider client={queryClient}>
        <Router
          root={(props) => {
            const matches = useCurrentMatches();

            onMount(() => {
              for (const match of matches()) {
                if (match.route.info?.AUTO_SHOW_WINDOW === false) return;
              }

              getCurrentWindow().show();
            });

            return <Suspense>{props.children}</Suspense>;
          }}
        >
          <FileRoutes />
        </Router>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

const browserPrefersDarkScheme = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

function createThemeListener() {
  // Check theme(). if `system` then check CSS media
  const currentWindow = getCurrentWebviewWindow();
  let systemThemeUnlisten: UnlistenFn | undefined;
  const [theme, themeActions] = createResource<AppTheme>(() =>
    generalSettingsStore.get().then((s) => s?.theme ?? "system")
  );
  const [darkMode, setDarkMode] = createSignal(
    theme() === "dark" || (theme() === "system" && browserPrefersDarkScheme())
  );

  createEffect(() => {
    console.log(`Theme is: ${theme()}`);
    console.log(`dark mode initialized to: ${darkMode()}`);
    console.log(`Browser prefers dark: ${browserPrefersDarkScheme()}`);
  });

  onMount(async () => {
    // Listen to system theme changed.
    systemThemeUnlisten = await currentWindow.onThemeChanged(
      ({ payload: systemTheme }) => {
        console.log(`System theme: ${systemTheme}`);
        if (theme() === "system") setDarkMode(systemTheme === "dark");
      }
    );
  });

  onCleanup(() => {
    systemThemeUnlisten?.();
  });

  generalSettingsStore.listen((s) => {
    setDarkMode(s?.theme === "dark");
    themeActions.mutate(s?.theme);
  });

  createEffect(() => {
    let darkModeEnabled = darkMode();
    console.log(`Dark Mode enabled?: ${darkModeEnabled}`);
    if (
      location.pathname === "/camera" ||
      location.pathname === "/prev-recordings"
    )
      darkModeEnabled = false;

    currentWindow.setTheme(
      theme() === "system" ? null : darkModeEnabled ? "dark" : "light"
    );

    if (darkModeEnabled) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  });
}
