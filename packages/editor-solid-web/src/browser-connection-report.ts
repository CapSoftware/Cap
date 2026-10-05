import {
	type ConnectionLevel,
	reportConnectionLevel,
} from "../../../apps/desktop/src/routes/editor/connection-status";
import { mediaConnectionSample } from "./browser-network-budget";
import {
	type ConnectionSample,
	createConnectionTracker,
} from "./connection-quality";

/// Nothing is fetched to measure the connection, so looking again is cheap.
const SAMPLE_MS = 2000;

type NetworkInformationLike = {
	effectiveType?: string;
	downlink?: number;
	rtt?: number;
};

function connectionHint(): ConnectionSample["hint"] {
	const connection = (
		navigator as Navigator & { connection?: NetworkInformationLike }
	).connection;
	if (!connection) return null;
	return {
		effectiveType: connection.effectiveType,
		downlinkMbps: connection.downlink,
		rttMs: connection.rtt,
	};
}

function sample(): ConnectionSample {
	return {
		online: navigator.onLine,
		media: mediaConnectionSample(),
		hint: connectionHint(),
	};
}

const LEVELS: readonly ConnectionLevel[] = ["good", "fair", "poor", "offline"];

/// Inside the page, the editor's own explanations use a level only once the
/// page says its indicator shows that level too, so the two never disagree,
/// even while the page is still loading its code.
export function startConnectionReport(host: Window | null) {
	const tracker = createConnectionTracker();
	const post = (level: ConnectionLevel) => {
		if (!host) return;
		const media = mediaConnectionSample();
		host.postMessage(
			{
				kind: "cap-editor-connection",
				version: 1,
				level,
				basis: tracker.basis,
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
