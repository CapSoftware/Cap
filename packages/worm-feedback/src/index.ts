import type { PostHogLike, WormFeedback, WormFeedbackConfig } from "./types";
import { mountWidget } from "./widget";

export type * from "./types";

let active: WormFeedback | null = null;

export function init(config: WormFeedbackConfig): WormFeedback {
	active?.destroy();
	const start = () => mountWidget(config);
	if (document.body) {
		active = start();
		return active;
	}
	let mounted: WormFeedback | null = null;
	const pending: WormFeedback = {
		open: () => mounted?.open(),
		close: () => mounted?.close(),
		destroy: () => {
			document.removeEventListener("DOMContentLoaded", ready);
			mounted?.destroy();
		},
	};
	const ready = () => {
		mounted = start();
	};
	document.addEventListener("DOMContentLoaded", ready, { once: true });
	active = pending;
	return pending;
}

export function autoInit(
	script: HTMLScriptElement | null,
): WormFeedback | null {
	const server = script?.dataset.server;
	const siteKey = script?.dataset.siteKey;
	if (!script || !server || !siteKey) return null;
	const posthog =
		script.dataset.posthog === "window"
			? (window as unknown as { posthog?: PostHogLike }).posthog
			: undefined;
	return init({
		server,
		siteKey,
		posthog,
		label: script.dataset.label,
		position:
			script.dataset.position === "bottom-left"
				? "bottom-left"
				: "bottom-right",
	});
}
