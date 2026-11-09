import type { Collector } from "./evidence";
import type { Evidence, FeedbackContext, PostHogLike } from "./types";
import type { VoiceMemo } from "./voice";

export const MAX_NOTE = 4000;
const ID = /^[\w.:\-/+]{1,128}$/;

export function contextIds(
	value: FeedbackContext | undefined | null,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!value || typeof value !== "object") return out;
	for (const key of ["userId", "orgId", "release"] as const) {
		const raw = value[key];
		if (typeof raw !== "string" && typeof raw !== "number") continue;
		const text = String(raw).trim();
		if (ID.test(text)) out[key] = text;
	}
	return out;
}

export function postHogIds(
	instance: PostHogLike | undefined,
): Evidence["posthog"] {
	if (!instance) return undefined;
	const read = (fn: () => unknown) => {
		try {
			const value = fn();
			return typeof value === "string" && value.length <= 2000
				? value
				: undefined;
		} catch {
			return undefined;
		}
	};
	const sessionId = read(() => instance.get_session_id?.());
	const replayUrl = read(() =>
		instance.get_session_replay_url?.({
			withTimestamp: true,
			timestampLookBack: 30,
		}),
	);
	const safeReplay =
		replayUrl && /^https:\/\//.test(replayUrl) ? replayUrl : undefined;
	if (!sessionId && !safeReplay) return undefined;
	return {
		...(sessionId ? { sessionId } : {}),
		...(safeReplay ? { replayUrl: safeReplay } : {}),
	};
}

export async function buildEvidence(
	collector: Collector,
	options: {
		getContext?: () => FeedbackContext | Promise<FeedbackContext>;
		posthog?: PostHogLike;
		voice?: VoiceMemo | null;
	},
): Promise<Evidence> {
	let context: Record<string, string> = {};
	try {
		context = contextIds(await options.getContext?.());
	} catch {}
	let timezone: string | undefined;
	try {
		timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {}
	const posthog = postHogIds(options.posthog);
	return {
		schemaVersion: 1,
		capturedAt: Date.now(),
		route: collector.route(),
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			dpr: window.devicePixelRatio || 1,
		},
		userAgent: navigator.userAgent.slice(0, 300),
		language: navigator.language,
		...(timezone ? { timezone } : {}),
		context,
		...(posthog ? { posthog } : {}),
		...(options.voice
			? {
					voice: {
						mimeType: options.voice.mimeType,
						durationMs: options.voice.durationMs,
					},
				}
			: {}),
		events: collector.events(),
	};
}

const extension: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"audio/webm": "webm",
	"audio/mp4": "m4a",
	"audio/aac": "aac",
	"audio/ogg": "ogg",
	"audio/mpeg": "mp3",
};

export function reportForm(input: {
	siteKey: string;
	note: string;
	evidence: Evidence;
	screenshot?: Blob | null;
	voice?: VoiceMemo | null;
}): FormData {
	const form = new FormData();
	form.set("key", input.siteKey);
	form.set("note", input.note.slice(0, MAX_NOTE));
	form.set("evidence", JSON.stringify(input.evidence));
	if (input.screenshot)
		form.set(
			"screenshot",
			input.screenshot,
			`screenshot.${extension[input.screenshot.type] ?? "jpg"}`,
		);
	if (input.voice)
		form.set(
			"voice",
			input.voice.blob,
			`voice.${extension[input.voice.mimeType] ?? "webm"}`,
		);
	return form;
}
