import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import Header from "./components/Header";

import "@cap/ui-solid/main.css";

const queryClient = new QueryClient();

export default function App() {
  return (
    <>
      <Header />
      <div class="px-3">
        <QueryClientProvider client={queryClient}>
          <Router root={(props) => <Suspense>{props.children}</Suspense>}>
            <FileRoutes />
          </Router>
        </QueryClientProvider>
      </div>
    </>
  );
}
