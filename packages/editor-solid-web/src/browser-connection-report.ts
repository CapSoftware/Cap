import {
	type ConnectionLevel,
	reportConnectionLevel,
} from "../../../apps/desktop/src/routes/editor/connection-status";
import { onBrowserPreviewSettled } from "./browser-frame-socket";
import {
	mediaConnectionSample,
	openConnectionWindow,
} from "./browser-network-budget";
import {
	type ConnectionSample,
	createConnectionTracker,
} from "./connection-quality";

/// Nothing is fetched to measure the connection, so looking again is cheap.
const SAMPLE_MS = 2000;
/// Measuring starts once the first frame has painted, when the editor's own
/// startup downloads are done; a first frame this late is no reason to wait
/// any longer.
const MEASURE_BY_MS = 20_000;

function sample(): ConnectionSample {
	return { online: navigator.onLine, media: mediaConnectionSample() };
}

const LEVELS: readonly ConnectionLevel[] = ["good", "fair", "poor", "offline"];

/// Inside the page, the editor's own explanations use a level only once the
/// page says its indicator shows that level too, so the two never disagree,
/// even while the page is still loading its code.
export function startConnectionReport(host: Window | null) {
	const tracker = createConnectionTracker();
	const post = (level: ConnectionLevel) => {
		if (!host) return;
		const sample = mediaConnectionSample();
		// Before anything is read once the editor has opened, its startup reads
		// are the only numbers there are; they understate the connection.
		const media =
			sample.bitsPerSecond === null && sample.latencyMs === null
				? sample.startup
				: sample;
		host.postMessage(
			{
				kind: "cap-editor-connection",
				version: 1,
				level,
				basis: "media",
				mbps:
					media.bitsPerSecond === null
						? null
						: Math.round(media.bitsPerSecond / 100_000) / 10,
				latencyMs:
					media.latencyMs === null ? null : Math.round(media.latencyMs),
			},
			window.location.origin,
		);
	};
	const check = () => {
		const changed = tracker.update(sample());
		if (!changed) return;
		if (!host) reportConnectionLevel(changed);
		post(changed);
	};
	let measuring = false;
	let fallback = 0;
	let unsubscribe = () => {};
	const startMeasuring = () => {
		if (measuring) return;
		measuring = true;
		window.clearTimeout(fallback);
		unsubscribe();
		openConnectionWindow();
	};
	fallback = window.setTimeout(startMeasuring, MEASURE_BY_MS);
	// It calls back at once when the preview has already settled.
	unsubscribe = onBrowserPreviewSettled(startMeasuring);
	if (measuring) unsubscribe();
	check();
	window.setInterval(check, SAMPLE_MS);
	window.addEventListener("online", check);
	window.addEventListener("offline", check);
	window.addEventListener("message", (event: MessageEvent<unknown>) => {
		if (
			!host ||
			event.source !== host ||
			event.origin !== window.location.origin ||
			typeof event.data !== "object" ||
			event.data === null
		)
			return;
		const message = event.data as Record<string, unknown>;
		if (message.version !== 1) return;
		if (message.kind === "cap-editor-connection-request") {
			if (tracker.level) post(tracker.level);
			return;
		}
		if (message.kind !== "cap-editor-connection-shown") return;
		// What the page's indicator shows; null while it is still checking.
		const shown = LEVELS.find((level) => level === message.level) ?? null;
		reportConnectionLevel(shown);
	});
}
