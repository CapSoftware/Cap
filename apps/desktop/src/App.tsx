import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { ErrorBoundary, Suspense } from "solid-js";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";

import "@cap/ui-solid/main.css";
import "unfonts.css";

const queryClient = new QueryClient();

export default function App() {
  return (
    <ErrorBoundary
      fallback={(e: Error) => {
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
            return <Suspense>{props.children}</Suspense>;
          }}
        >
          <FileRoutes />
        </Router>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
