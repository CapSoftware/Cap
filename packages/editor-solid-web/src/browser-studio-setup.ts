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
		const response = await fetch(sources.inputEvents.url, {
			signal,
			credentials: "omit",
		});
		if (!response.ok) return null;
		const size = Number(response.headers.get("content-length") ?? 0);
		if (size > 64 * 1024 * 1024) return null;
		const parsed: unknown = JSON.parse(
			module.web_input_recording(await response.text()),
		);
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
