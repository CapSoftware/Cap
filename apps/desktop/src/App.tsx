import { Router, useCurrentMatches } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message } from "@tauri-apps/plugin-dialog";
import {
  createEffect,
  ErrorBoundary,
  onCleanup,
  onMount,
  Suspense,
} from "solid-js";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";

import { Button } from "@cap/ui-solid";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { Toaster } from "solid-toast";
import { generalSettingsStore } from "./store";
import { initAnonymousUser } from "./utils/analytics";
import { commands, type AppTheme } from "./utils/tauri";
import titlebar from "./utils/titlebar-state";

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
    <QueryClientProvider client={queryClient}>
      <Suspense>
        <Inner />
      </Suspense>
    </QueryClientProvider>
  );
}

function Inner() {
  const currentWindow = getCurrentWebviewWindow();
  createThemeListener(currentWindow);

  onMount(() => {
    initAnonymousUser();
  });

  return (
    <>
      <Toaster
        position="bottom-right"
        containerStyle={{
          "margin-top": titlebar.height,
        }}
        toastOptions={{
          duration: 3500,
          style: {
            padding: "8px 16px",
            "border-radius": "15px",
            "border-color": "var(--gray-200)",
            "border-width": "1px",
            "font-size": "1rem",
            "background-color": "var(--gray-50)",
            color: "var(--text-secondary)",
          },
        }}
      />
      <ErrorBoundary
        fallback={(e: Error) => {
          console.error(e);
          return (
            <div class="w-screen h-screen flex flex-col justify-center items-center bg-gray-100 border-gray-200 max-h-screen overflow-hidden transition-[border-radius] duration-200 text-[--text-secondary] gap-y-4 max-sm:gap-y-2 px-8 text-center">
              <IconCapLogo class="max-sm:size-16" />
              <h1 class="text-[--text-primary] text-3xl max-sm:text-xl font-bold">
                An Error Occured
              </h1>
              <p class="mb-2 max-sm:text-sm">
                We're very sorry, but something has gone wrong.
              </p>
              <div class="flex flex-row gap-4 max-sm:flex-col max-sm:gap-2">
                <Button
                  onClick={() => {
                    writeText(`${e.toString()}\n\n${e.stack}`);
                  }}
                >
                  Copy Error to Clipboard
                </Button>
                <Button
                  onClick={() => {
                    location.reload();
                  }}
                  variant="secondary"
                >
                  Reload
                </Button>
              </div>
            </div>
          );
        }}
      >
        <Router
          root={(props) => {
            const matches = useCurrentMatches();

            onMount(() => {
              for (const match of matches()) {
                if (match.route.info?.AUTO_SHOW_WINDOW === false) return;
              }

              currentWindow.show();
            });

            return (
              <Suspense
                fallback={
                  (() => {
                    console.log("Root suspense fallback showing");
                  }) as any
                }
              >
                {props.children}
              </Suspense>
            );
          }}
        >
          <FileRoutes />
        </Router>
      </ErrorBoundary>
    </>
  );
}

function createThemeListener(currentWindow: WebviewWindow) {
  const generalSettings = generalSettingsStore.createQuery();

  createEffect(() => {
    update(generalSettings.data?.theme ?? null);
  });

  onMount(async () => {
    const unlisten = await currentWindow.onThemeChanged((_) =>
      update(generalSettings.data?.theme)
    );
    onCleanup(() => unlisten?.());
  });

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
