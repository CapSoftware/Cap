import { Router, useCurrentMatches } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import {
  createEffect,
  createResource,
  ErrorBoundary,
  onMount,
  Suspense,
} from "solid-js";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";
import { generalSettingsStore } from "./store";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { commands } from "./utils/tauri";

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
  const [theme, themeActions] = createResource(() =>
    generalSettingsStore.get().then((s) => s?.darkMode ?? null)
  );

  generalSettingsStore.listen((s) => {
    themeActions.mutate(s?.darkMode);
  });

  createEffect(() => {
    let t = theme();
    if (
      location.pathname === "/camera" ||
      location.pathname === "/prev-recordings"
    )
      t = false;
    if (t === undefined) return;

    commands.setWindowTheme(!!t);

    if (t) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  });
}
