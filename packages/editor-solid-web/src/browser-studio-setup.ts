import type { BrowserEditorSources } from "./browser-sources";

type RendererModule =
	typeof import("../renderer/pkg/cap_editor_browser_renderer.js");

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function recordingMeta(sources: BrowserEditorSources) {
	return {
		segments: sources.segments.map((segment, index) => ({
			display: {
				path: `display-${index}.webm`,
				fps: segment.displayFps ?? 30,
				start_time: 0,
			},
			...(segment.camera
				? {
						camera: {
							path: `camera-${index}.webm`,
							fps: segment.cameraFps ?? segment.displayFps ?? 30,
							start_time: (segment.cameraOffsetMs ?? 0) / 1000,
						},
					}
				: {}),
			...(segment.micOffsetMs !== null
				? {
						mic: {
							path: `mic-${index}.webm`,
							start_time: segment.micOffsetMs / 1000,
						},
					}
				: {}),
			...(segment.systemAudioOffsetMs !== null
				? {
						system_audio: {
							path: `system-${index}.webm`,
							start_time: segment.systemAudioOffsetMs / 1000,
						},
					}
				: {}),
		})),
	};
}

export type WebInputRecording = {
	platform: string;
	cursor: unknown;
	cursors: Record<string, unknown>;
};

export function studioRecordingMeta(
	sources: BrowserEditorSources,
	input: WebInputRecording | null,
) {
	return {
		pretty_name: sources.title,
		...(input ? { platform: input.platform } : {}),
		...recordingMeta(sources),
		cursors: input?.cursors ?? {},
		status: { status: "Complete" },
	};
}

const inputTexts = new Map<string, Promise<string | null>>();

function inputEventsText(url: string) {
	let text = inputTexts.get(url);
	if (!text) {
		text = fetch(url, { credentials: "omit" }).then((response) => {
			const size = Number(response.headers.get("content-length") ?? 0);
			if (!response.ok || size > 64 * 1024 * 1024) {
				void response.body?.cancel();
				return null;
			}
			return response.text();
		});
		inputTexts.set(url, text);
		text.catch(() => {
			if (inputTexts.get(url) === text) inputTexts.delete(url);
		});
	}
	return text;
}

/// Drops pointer input downloaded for an editor that has been torn down.
export function releaseWebInputRecordings() {
	inputTexts.clear();
}

/// Starts downloading the recording's pointer input with the other startup
/// reads; a long recording's input runs to megabytes and the first frame
/// waits for it.
export function prefetchWebInputRecording(sources: BrowserEditorSources) {
	if (sources.inputEvents) {
		void inputEventsText(sources.inputEvents.url).catch(() => undefined);
	}
}

/// Pointer input recorded by the browser recorder or Chrome extension, parsed
/// by the same code the web export worker uses. Missing input only drops the
/// cursor layer, so failures are not fatal.
export async function webInputRecording(
	sources: BrowserEditorSources,
	module: RendererModule,
	signal: AbortSignal,
): Promise<WebInputRecording | null> {
	if (!sources.inputEvents) return null;
	try {
		const url = sources.inputEvents.url;
		const text = await new Promise<string | null>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			inputEventsText(url)
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", onAbort));
		});
		// The text can run to tens of megabytes; once parsed it is not kept.
		inputTexts.delete(url);
		if (text === null) return null;
		const parsed: unknown = JSON.parse(module.web_input_recording(text));
		const value = record(parsed);
		if (!value || typeof value.platform !== "string" || !record(value.cursors))
			return null;
		return {
			platform: value.platform,
			cursor: value.cursor,
			cursors: record(value.cursors) ?? {},
		};
	} catch (cause) {
		if (signal.aborted) throw cause;
		return null;
	}
}
