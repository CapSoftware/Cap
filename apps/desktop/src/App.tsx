import { Router, useCurrentMatches } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { ErrorBoundary, onMount, Suspense } from "solid-js";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import { getCurrentWindow } from "@tauri-apps/api/window";

const queryClient = new QueryClient();

export default function App() {
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
