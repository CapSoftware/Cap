// Injected by vite `define` per build target (e.g. `__TARGET__: "firefox"`).
// Under vitest there is no define; the fallback to "chrome" is intentional —
// tests run against Chrome APIs. Every production Vite build MUST inject this
// define so that Firefox builds never accidentally enable Chrome-only paths.
declare const __TARGET__: "chrome" | "firefox" | undefined;

export type ExtensionTarget = "chrome" | "firefox";

export const TARGET: ExtensionTarget =
	typeof __TARGET__ === "undefined" ? "chrome" : __TARGET__;
