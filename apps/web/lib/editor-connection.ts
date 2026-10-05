/// Reported by packages/editor-solid-web/src/browser-connection-report.ts.

export type EditorConnectionLevel = "good" | "fair" | "poor" | "offline";

export type EditorConnectionReport = {
	level: EditorConnectionLevel;
	basis: "media" | "hint" | null;
	mbps: number | null;
	latencyMs: number | null;
};

const LEVELS: readonly EditorConnectionLevel[] = [
	"good",
	"fair",
	"poor",
	"offline",
];

const finiteOrNull = (value: unknown, max: number) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(value, max)
		: null;

export function parseEditorConnectionMessage(
	data: unknown,
): EditorConnectionReport | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (message.kind !== "cap-editor-connection" || message.version !== 1)
		return null;
	const level = LEVELS.find((candidate) => candidate === message.level);
	if (!level) return null;
	return {
		level,
		basis:
			message.basis === "media" || message.basis === "hint"
				? message.basis
				: null,
		mbps: finiteOrNull(message.mbps, 100_000),
		latencyMs: finiteOrNull(message.latencyMs, 600_000),
	};
}

export function editorConnectionDisplay(
	report: EditorConnectionReport | null,
	online: boolean,
): EditorConnectionLevel | "checking" {
	if (!online) return "offline";
	if (!report) return "checking";
	// The frame may still think it's offline for a moment after the page is
	// back; it reports its real level on its next look.
	if (report.level === "offline") return "checking";
	return report.level;
}

export const EDITOR_CONNECTION_COPY: Record<
	EditorConnectionLevel | "checking",
	{ label: string; title: string; body: string; bars: 0 | 1 | 2 | 3 }
> = {
	good: {
		label: "Good connection",
		title: "Good connection",
		body: "Editing and playback are smooth.",
		bars: 3,
	},
	fair: {
		label: "Fair connection",
		title: "Fair connection",
		body: "Editing works as usual. Playback and jumping around the video may pause briefly while it loads.",
		bars: 2,
	},
	poor: {
		label: "Slow connection",
		title: "Slow connection",
		body: "Edits still apply right away, but playback may pause while video loads. Editing isn't at its best right now.",
		bars: 1,
	},
	offline: {
		label: "Offline",
		title: "You're offline",
		body: "Keep editing. Your edits stay in this browser and save when you're back online. Video that hasn't loaded yet can't play until then.",
		bars: 0,
	},
	checking: {
		label: "Checking connection",
		title: "Checking your connection",
		body: "Cap measures it from the video the editor loads once it has opened, so it never uses extra data.",
		bars: 0,
	},
};

/// Only what the editor measured; the browser's hint is too rough to quote.
export function editorConnectionDetail(report: EditorConnectionReport | null) {
	if (!report || report.basis !== "media") return null;
	const parts: string[] = [];
	if (report.mbps !== null && report.mbps > 0)
		parts.push(
			report.mbps >= 100
				? "Over 100 Mbps"
				: `${report.mbps >= 10 ? Math.round(report.mbps) : Math.max(0.1, Math.round(report.mbps * 10) / 10)} Mbps`,
		);
	if (report.latencyMs !== null)
		parts.push(
			report.latencyMs >= 1000
				? `${Math.round(report.latencyMs / 100) / 10} s response`
				: `${Math.max(10, Math.round(report.latencyMs / 10) * 10)} ms response`,
		);
	return parts.length ? parts.join(" · ") : null;
}
