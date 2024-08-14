import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";

import "@cap/ui/style";

export default function App() {
  return (
    <Router root={(props) => <Suspense>{props.children}</Suspense>}>
      <FileRoutes />
    </Router>
  );
}
