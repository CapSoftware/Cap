import { Router, useCurrentMatches } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import {
  createResource,
  ErrorBoundary,
  onCleanup,
  onMount,
  Suspense,
} from "solid-js";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { message } from "@tauri-apps/plugin-dialog";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";
import { generalSettingsStore } from "./store";
import { commands, type AppTheme } from "./utils/tauri";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";

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
  const currentWindow = getCurrentWebviewWindow();
  createThemeListener(currentWindow);

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

              currentWindow.show();
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

function createThemeListener(currentWindow: WebviewWindow) {
  const [theme, themeActions] = createResource<AppTheme | null>(() =>
    generalSettingsStore.get().then((s) => {
      const t = s?.theme ?? null;
      update(t);
      return t;
    })
  );
  generalSettingsStore.listen((s) => {
    themeActions.mutate(s?.theme ?? null);
    update(theme());
  });

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await currentWindow.onThemeChanged((_) => update(theme()));
  });
  onCleanup(() => unlisten?.());

  function update(appTheme: AppTheme | null | undefined) {
    if (appTheme === undefined || appTheme === null) return;
    if (
      location.pathname === "/camera" ||
      location.pathname === "/prev-recordings"
    )
      return;

    commands.setTheme(appTheme).then(() => {
      document.documentElement.classList.toggle(
        "dark",
        appTheme === "dark" ||
          window.matchMedia("(prefers-color-scheme: dark)").matches
      );
    });
  }
}
