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
import Page from "./routes/notifications";

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

function createThemeListener() {
  const browserPrefersDarkScheme = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const currentWindow = getCurrentWebviewWindow();
  const [theme, themeActions] = createResource<AppTheme>(() =>
    generalSettingsStore.get().then((s) => s?.theme ?? "system")
  );
  const [darkMode, setDarkMode] = createSignal(false);

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await currentWindow.onThemeChanged(
      async ({ payload: windowTheme }) => {
        if (theme() === "system") {
          const prefersDark = browserPrefersDarkScheme();
          setDarkMode(windowTheme === null || prefersDark);

          console.log(
            `Window Theme: ${windowTheme}, Browser Prefers Dark: ${prefersDark}, Dark Mode: ${darkMode()}`
          );
        }
      }
    );
  });
  onCleanup(() => unlisten?.());

  generalSettingsStore.listen((s) => {
    themeActions.mutate(s?.theme);
    setDarkMode(s?.theme === "dark");
  });

  createEffect(async () => {
    const appTheme = theme();
    if (appTheme === undefined) return;
    if (
      location.pathname === "/camera" ||
      location.pathname === "/prev-recordings"
    )
      return;

    await currentWindow.setTheme(
      appTheme === "system" ? null : (appTheme as TauriTheme)
    );

    const darkModeEnabled =
      appTheme === "system" ? browserPrefersDarkScheme() : appTheme === "dark";

    console.log(
      `App Theme: ${appTheme}, Window Theme: ${await currentWindow.theme()}, Dark Mode Enabled: ${darkModeEnabled}`
    );

    document.documentElement.classList.toggle("dark", darkModeEnabled);
  });

  createEffect(() => {
    const isDarkMode = darkMode();
    document.documentElement.classList.toggle("dark", isDarkMode);
  });
}
