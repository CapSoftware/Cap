import type { AiGenerationLanguage } from "@cap/web-domain";

export type WebEditorCaptionData = {
	segments: Array<{
		id: string;
		start: number;
		end: number;
		text: string;
		words: Array<{ text: string; start: number; end: number }>;
	}>;
	settings: null;
};

type CaptionSnapshot = {
	status:
		| "ready"
		| "processing"
		| "missing"
		| "error"
		| "no_audio"
		| "disabled";
	captions: WebEditorCaptionData | null;
	message: string | null;
};

const CAPTION_WAIT_MS = 2000;
const CAPTION_DEADLINE_MS = 60 * 60 * 1000;
const CAPTION_STATUSES = new Set([
	"ready",
	"processing",
	"missing",
	"error",
	"no_audio",
	"disabled",
]);

function validRange(start: unknown, end: unknown) {
	return (
		typeof start === "number" &&
		typeof end === "number" &&
		Number.isFinite(start) &&
		Number.isFinite(end) &&
		start >= 0 &&
		end > start
	);
}

function isCaptionData(value: unknown): value is WebEditorCaptionData {
	if (
		typeof value !== "object" ||
		value === null ||
		!("settings" in value) ||
		value.settings !== null ||
		!("segments" in value) ||
		!Array.isArray(value.segments)
	) {
		return false;
	}
	return value.segments.every((segment: unknown) => {
		if (
			typeof segment !== "object" ||
			segment === null ||
			!("id" in segment) ||
			typeof segment.id !== "string" ||
			!("text" in segment) ||
			typeof segment.text !== "string" ||
			!("start" in segment) ||
			!("end" in segment) ||
			!validRange(segment.start, segment.end) ||
			!("words" in segment) ||
			!Array.isArray(segment.words)
		) {
			return false;
		}
		return segment.words.every(
			(word: unknown) =>
				typeof word === "object" &&
				word !== null &&
				"text" in word &&
				typeof word.text === "string" &&
				"start" in word &&
				"end" in word &&
				validRange(word.start, word.end),
		);
	});
}

function parseSnapshot(value: unknown): CaptionSnapshot {
	if (
		typeof value !== "object" ||
		value === null ||
		!("status" in value) ||
		typeof value.status !== "string" ||
		!CAPTION_STATUSES.has(value.status) ||
		!("message" in value) ||
		(value.message !== null && typeof value.message !== "string") ||
		!("captions" in value) ||
		(value.captions !== null && !isCaptionData(value.captions))
	) {
		throw new Error("Caption response was invalid");
	}
	return value as CaptionSnapshot;
}

function waitForCaptionPoll(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Caption generation cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", canceled);
			resolve();
		}, CAPTION_WAIT_MS);
		const canceled = () => {
			clearTimeout(timer);
			reject(new Error("Caption generation cancelled"));
		};
		signal.addEventListener("abort", canceled, { once: true });
	});
}

export async function generateWebEditorCaptions(
	videoId: string,
	sessionId: string,
	signal: AbortSignal,
	language: AiGenerationLanguage = "auto",
): Promise<WebEditorCaptionData> {
	const path = `/api/editor/sessions/${encodeURIComponent(sessionId)}/captions`;
	const request = async (method: "GET" | "POST") => {
		const response = await fetch(
			method === "GET"
				? `${path}?videoId=${encodeURIComponent(videoId)}&language=${encodeURIComponent(language)}`
				: path,
			{
				method,
				headers:
					method === "POST" ? { "Content-Type": "application/json" } : {},
				body:
					method === "POST" ? JSON.stringify({ videoId, language }) : undefined,
				cache: "no-store",
				signal,
			},
		);
		if (!response.ok) {
			throw new Error(
				response.status === 403
					? "Cap Pro is required for web editor captions"
					: response.status === 404
						? "Editor session is unavailable"
						: "Caption transcription is unavailable",
			);
		}
		const value: unknown = await response.json();
		return parseSnapshot(value);
	};

	let snapshot = await request("POST");
	const deadline = Date.now() + CAPTION_DEADLINE_MS;
	let restartCount = 0;
	let wasProcessing = snapshot.status === "processing";
	while (
		snapshot.status === "processing" ||
		(snapshot.status === "missing" && wasProcessing && restartCount < 3)
	) {
		if (Date.now() >= deadline) {
			throw new Error("Caption transcription timed out. Try again later.");
		}
		if (snapshot.status === "missing") {
			restartCount++;
			wasProcessing = false;
			snapshot = await request("POST");
			if (snapshot.status === "processing") wasProcessing = true;
			continue;
		}
		await waitForCaptionPoll(signal);
		snapshot = await request("GET");
		if (snapshot.status === "processing") wasProcessing = true;
	}
	if (snapshot.status === "ready" && snapshot.captions) {
		return snapshot.captions;
	}
	throw new Error(
		snapshot.message ??
			(snapshot.status === "missing"
				? "Caption transcript is not ready. Try again."
				: "Caption transcription did not produce captions"),
	);
}
