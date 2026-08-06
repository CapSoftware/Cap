import { createEventListener } from "@solid-primitives/event-listener";
import { type Accessor, createSignal } from "solid-js";

/**
 * Reactive `window.matchMedia` binding. Tracks the query's live state and
 * updates on change; safe to call in environments without `matchMedia`
 * (returns a static `false` accessor).
 */
export function useMediaQuery(query: string): Accessor<boolean> {
	if (typeof window === "undefined" || !window.matchMedia) {
		return () => false;
	}

	const mql = window.matchMedia(query);
	const [matches, setMatches] = createSignal(mql.matches);

	createEventListener(mql, "change", (event) => setMatches(event.matches));

	return matches;
}

/** True when the user has requested reduced motion at the OS level. */
export function usePrefersReducedMotion(): Accessor<boolean> {
	return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** True when the user has requested increased contrast at the OS level. */
export function usePrefersIncreasedContrast(): Accessor<boolean> {
	return useMediaQuery("(prefers-contrast: more)");
}

/** True when the user has requested reduced transparency at the OS level. */
export function usePrefersReducedTransparency(): Accessor<boolean> {
	return useMediaQuery("(prefers-reduced-transparency: reduce)");
}

/** True when the system is in dark mode. */
export function usePrefersDarkMode(): Accessor<boolean> {
	return useMediaQuery("(prefers-color-scheme: dark)");
}

/**
 * Coarse pointer (touch) vs fine pointer (mouse/trackpad). Useful for
 * widening hit targets or disabling hover-only affordances.
 */
export function useHasCoarsePointer(): Accessor<boolean> {
	return useMediaQuery("(pointer: coarse)");
}
