// Injected by vite `define` per build target; undefined under vitest, which
// runs without a define and must behave like the Chrome build.
declare const __TARGET__: "chrome" | "firefox" | undefined;

export type ExtensionTarget = "chrome" | "firefox";

export const TARGET: ExtensionTarget =
	typeof __TARGET__ === "undefined" ? "chrome" : __TARGET__;
