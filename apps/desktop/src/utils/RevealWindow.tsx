import { useCurrentMatches, useIsRouting } from "@solidjs/router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	children,
	createEffect,
	type JSX,
	type ParentProps,
	Suspense,
} from "solid-js";

let windowShown = false;

/**
 * Delays showing the native window until the initial route tree has fully
 * resolved and the app is no longer navigating.
 * It waits for the router + suspense boundaries to
 * 	settle before showing the window automatically.
 *
 * This prevents the window from flashing partially-loaded UI during startup.
 *
 * Routes can opt out of automatic reveal by setting:
 * ```ts
 * route.info.autoShow = false
 * ```
 *
 * The window is revealed only once per app lifecycle via the shared
 * `windowShown` guard.
 */
export function AutoRevealWindowOnReady() {
	const matches = useCurrentMatches();
	const isRouting = useIsRouting();

	createEffect(() => {
		if (isRouting() || windowShown) return;
		const shouldDefer = matches().some(
			(match) => match.route.info?.autoShow === false,
		);
		if (shouldDefer) return;
		maybeShowWindow();
	});

	return null;
}

/**
 * Suspense boundary that delays revealing the native window until its children
 * have resolved at least once.
 *
 * Unlike a normal `Suspense`, the `fallback` is not shown during the initial
 * application load because the window itself remains hidden until resolution
 * completes. The fallback is only visible during subsequent suspensions after
 * the window has already been revealed (for example, during route reloads or
 * async updates).
 *
 * @param props.children Async content that must resolve before the window is shown.
 * @param props.fallback Optional fallback UI displayed only after the initial
 * window reveal if the subtree suspends again.
 */
export function RevealWindowWithSuspense(
	props: ParentProps<{ fallback?: JSX.Element }>,
) {
	const resolved = children(() => props.children);

	createEffect(() => {
		if (resolved() !== undefined) maybeShowWindow();
	});

	return <Suspense fallback={props.fallback}>{resolved()}</Suspense>;
}

export function maybeShowWindow() {
	if (windowShown) return;
	windowShown = true;
	void getCurrentWindow().show();
}
