import { Router, useCurrentMatches } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { ErrorBoundary, onMount, Suspense } from "solid-js";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";
import { commands } from "./utils/tauri";
import { themeStore } from "./store/theme";
import "./store/early-theme-loader";

const darkModeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
const localStorageDarkMode = localStorage.getItem("darkMode");

// Check stored preference first, then system preference
if (
  localStorageDarkMode === "true" ||
  (localStorageDarkMode === null && darkModeMediaQuery.matches)
) {
  document.documentElement.classList.add("dark");
}

// Add base background color to prevent flash
const style = document.createElement("style");
style.textContent = `
  html.dark {
    background-color: #1E1E1E;
  }
  html.dark body {
    background-color: #1E1E1E;
  }
`;
document.head.appendChild(style);

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
  const darkMode = themeStore.isDarkMode;

  return (
    <div class={darkMode() ? "dark" : ""}>
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

                themeStore.initialize().then(() => {
                  getCurrentWindow().show();
                });
              });

              return <Suspense>{props.children}</Suspense>;
            }}
          >
            <FileRoutes />
          </Router>
        </QueryClientProvider>
      </ErrorBoundary>
    </div>
  );
}
