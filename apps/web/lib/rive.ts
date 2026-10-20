"use client";

import { RuntimeLoader } from "@rive-app/react-canvas";

// Self-host the Rive WASM. By default @rive-app/canvas fetches its runtime from
// unpkg.com on first use, which adds a third-party origin (extra DNS/TLS) to the
// critical path. The file under /public/rive must stay in sync with the
// @rive-app/canvas version that @rive-app/react-canvas resolves to.
RuntimeLoader.setWasmUrl("/rive/rive.wasm");

export * from "@rive-app/react-canvas";
