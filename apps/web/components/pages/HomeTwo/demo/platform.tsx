"use client";

import { createContext, useContext } from "react";

/**
 * Which OS the demo is dressed as. Everything except the Cap windows'
 * chrome is shared, so a single context beats threading a prop through the
 * whole window tree.
 *
 * Windows visitors get the Windows shell; every other platform (macOS,
 * Linux, and the first paint before detection resolves) gets macOS, the same
 * default the download button uses.
 */
export type DemoPlatform = "macos" | "windows";

const DemoPlatformContext = createContext<DemoPlatform>("macos");

export const DemoPlatformProvider = DemoPlatformContext.Provider;

export const useDemoPlatform = () => useContext(DemoPlatformContext);

export const useIsWindowsDemo = () => useDemoPlatform() === "windows";

/** System UI stack per platform, for the OS chrome (not the Cap windows). */
export const OS_FONT = {
	macos:
		"-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
	windows:
		"'Segoe UI Variable Text', 'Segoe UI', 'Segoe UI Web (West European)', system-ui, sans-serif",
} as const;
