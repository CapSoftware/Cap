import { z } from "zod";
import { hasEditorCaptionContent } from "../../../web/lib/editor-caption-access";
import {
	createEditorCaptionCache,
	type EditorCaptionCache,
	restoreEditorCaptionConfig,
} from "../../../web/lib/editor-caption-transport";
import { listEditorAudioLibrary } from "./editor-audio-library";

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_NUMBER = 1_000_000;

const resolutionSchema = z.object({
	x: z.number().int().min(1).max(3840),
	y: z.number().int().min(1).max(2160),
});
const frameSchema = z.object({
	frameNumber: z.number().int().min(0).max(MAX_FRAME_NUMBER),
	fps: z.number().int().min(1).max(60),
	resolutionBase: resolutionSchema,
});
const keyboardGenerationSchema = z.object({
	groupingThresholdMs: z.number().finite().min(0).max(60_000),
	lingerDurationMs: z.number().finite().min(0).max(60_000),
	showModifiers: z.boolean(),
	showSpecialKeys: z.boolean(),
});
const autoZoomSchema = z.object({
	zoomAmount: z.number().finite().min(0.1).max(10),
});
const renderEventSchema = z.object({
	frame_number: z.number().int().min(0).max(MAX_FRAME_NUMBER),
	fps: z.number().int().min(1).max(60),
	resolution_base: resolutionSchema,
});
const socketRequestSchema = z.object({
	kind: z.enum(["invoke", "emit"]),
	id: z.number().int().min(1).max(1_000_000_000),
	name: z.string().min(1).max(100),
	args: z.array(z.unknown()).max(4),
});

export type EditorSocketRequest = z.infer<typeof socketRequestSchema>;
export type EditorCommandState = {
	frameNumber: number;
	fps: number;
	resolutionBase: { x: number; y: number };
	captionsEnabled?: boolean;
	captionCache?: EditorCaptionCache | null;
};
export type NativeEditorRequest = (
	path: string,
	method: "GET" | "PUT" | "POST" | "DELETE",
	body?: unknown,
	eventOnly?: boolean,
) => Promise<unknown>;
export type EditorSocketReply =
	| { kind: "result"; id: number; value: unknown }
	| { kind: "error"; id: number; error: string };

export function parseEditorSocketRequest(value: unknown) {
	const result = socketRequestSchema.safeParse(value);
	return result.success ? result.data : null;
}

function asObject(value: unknown, cache: EditorCaptionCache | null) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid editor project configuration");
	}
	const restored = restoreEditorCaptionConfig(
		value as Record<string, unknown>,
		cache,
	);
	if (!restored) throw new Error("Caption payload cache is unavailable");
	const json = JSON.stringify(restored);
	if (Buffer.byteLength(json, "utf8") > MAX_CONFIG_BYTES) {
		throw new Error("Editor project configuration is too large");
	}
	return restored;
}

function asInstance(value: unknown, sessionId: string) {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("instanceId" in value) ||
		typeof value.instanceId !== "string"
	) {
		throw new Error("Editor instance is unavailable");
	}
	return {
		...value,
		path: `cap-web-editor://session/${sessionId}`,
		framesSocketUrl: "",
		audioSocketUrl: "",
		eventsSocketUrl: "",
	};
}

function asFrameNumber(value: unknown) {
	return frameSchema.shape.frameNumber.parse(value);
}

async function executeEditorCommand(
	sessionId: string,
	request: EditorSocketRequest,
	state: EditorCommandState,
	native: NativeEditorRequest,
) {
	const args = request.args;
	if (request.kind === "emit") {
		if (request.name !== "renderFrameEvent") {
			throw new Error(`Unsupported editor event: ${request.name}`);
		}
		const event = renderEventSchema.parse(args[0]);
		state.frameNumber = event.frame_number;
		state.fps = event.fps;
		state.resolutionBase = event.resolution_base;
		await native(
			"/preview",
			"POST",
			{
				frameNumber: event.frame_number,
				fps: event.fps,
				resolutionBase: event.resolution_base,
			},
			true,
		);
		return null;
	}
	switch (request.name) {
		case "getEditorProjectPath":
			return `cap-web-editor://session/${sessionId}`;
		case "getRecordingMetaByPath":
			if (args[0] !== `cap-web-editor://session/${sessionId}`) {
				throw new Error("Invalid editor project path");
			}
			return native("/meta", "GET");
		case "getEditorMeta":
			return native("/meta", "GET");
		case "getVideoMetadata": {
			if (args[0] !== `cap-web-editor://session/${sessionId}`)
				throw new Error("Invalid editor project path");
			const instance = await native("/instance", "GET");
			if (
				typeof instance !== "object" ||
				instance === null ||
				!("recordingDuration" in instance) ||
				typeof instance.recordingDuration !== "number" ||
				!Number.isFinite(instance.recordingDuration) ||
				instance.recordingDuration <= 0
			) {
				throw new Error("Recording duration is unavailable");
			}
			return {
				duration: instance.recordingDuration,
				size: (8_192_000 * instance.recordingDuration) / (8 * 1024 * 1024),
			};
		}
		case "checkUpgradedAndUpdate":
			return state.captionsEnabled === true;
		case "createEditorInstance":
			return asInstance(await native("/instance", "GET"), sessionId);
		case "getDefaultProjectConfig":
			return native("/default-config", "GET");
		case "animatedGradientCatalog":
			return native("/animated-gradients", "GET");
		case "randomAnimatedGradient":
			return native("/animated-gradients/random", "GET");
		case "loadCaptions": {
			if (state.captionsEnabled === false) return null;
			const config = await native("/config", "GET");
			return typeof config === "object" &&
				config !== null &&
				"captions" in config
				? config.captions
				: null;
		}
		case "getMicWaveforms":
			return native("/waveforms/mic", "GET");
		case "getSystemAudioWaveforms":
			return native("/waveforms/system", "GET");
		case "generateKeyboardSegments": {
			const settings = keyboardGenerationSchema.parse({
				groupingThresholdMs: args[0],
				lingerDurationMs: args[1],
				showModifiers: args[2],
				showSpecialKeys: args[3],
			});
			return native("/keyboard-segments", "POST", settings);
		}
		case "generateZoomSegmentsFromClicks": {
			const settings = autoZoomSchema.parse({ zoomAmount: args[0] });
			return native("/auto-zoom-segments", "POST", settings);
		}
		case "listAudioLibrary":
			return listEditorAudioLibrary();
		case "setWindowTransparent":
		case "tauri:get_recording_recovery_success":
			return request.name === "setWindowTransparent" ? null : false;
		case "setProjectConfig":
			throw new Error("Editor project saves require the authenticated web API");
		case "updateProjectConfigInMemory": {
			const reused =
				typeof args[0] === "object" &&
				args[0] !== null &&
				"webCaptionRef" in args[0];
			const config = asObject(args[0], state.captionCache ?? null);
			if (state.captionsEnabled === false && hasEditorCaptionContent(config)) {
				throw new Error("Cap Pro is required for captions");
			}
			await native("/config/memory", "PUT", config);
			if (!reused) state.captionCache = await createEditorCaptionCache(config);
			if (args[1] !== null && args[2] !== null && args[3] !== null) {
				const frame = frameSchema.parse({
					frameNumber: args[1],
					fps: args[2],
					resolutionBase: args[3],
				});
				state.frameNumber = frame.frameNumber;
				state.fps = frame.fps;
				state.resolutionBase = frame.resolutionBase;
				await native("/preview", "POST", frame, true);
			}
			return null;
		}
		case "startPlayback": {
			const frame = frameSchema.parse({
				frameNumber: state.frameNumber,
				fps: args[0],
				resolutionBase: args[1],
			});
			state.fps = frame.fps;
			state.resolutionBase = frame.resolutionBase;
			await native("/playback", "POST", frame);
			return null;
		}
		case "stopPlayback":
			await native("/playback", "DELETE");
			return null;
		case "seekTo":
		case "setPlayheadPosition": {
			const frameNumber = asFrameNumber(args[0]);
			await native("/seek", "PUT", {
				frameNumber,
				fps: state.fps,
				resolutionBase: state.resolutionBase,
			});
			state.frameNumber = frameNumber;
			return null;
		}
		default:
			throw new Error(`Unsupported editor command: ${request.name}`);
	}
}

export async function dispatchEditorSocketCommand(
	sessionId: string,
	request: EditorSocketRequest,
	state: EditorCommandState,
	native: NativeEditorRequest,
): Promise<EditorSocketReply> {
	try {
		return {
			kind: "result",
			id: request.id,
			value: await executeEditorCommand(sessionId, request, state, native),
		};
	} catch (cause) {
		return {
			kind: "error",
			id: request.id,
			error: cause instanceof Error ? cause.message : "Editor command failed",
		};
	}
}
