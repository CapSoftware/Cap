import { registerEditorChannel, unregisterEditorChannel } from "./channels";
import { editorTransport } from "./editor-transport";
import type {
	AnimatedGradientCatalog,
	AnimatedGradientConfig,
	CaptionData,
	EditorStateChanged,
	ExportEstimates,
	ExportPreviewResult,
	ExportPreviewSettings,
	ExportSettings,
	FrameLayoutEvent,
	FramesRendered,
	ImportedAudioTrack,
	ProjectConfiguration,
	RecordingMeta,
	RenderFrameEvent,
	SerializedEditorInstance,
	TranscriptionEngine,
	VideoRecordingMetadata,
	XY,
} from "./types";

function call<T>(name: string, ...args: unknown[]) {
	return editorTransport().invoke(name, args) as Promise<T>;
}

export const commands = {
	animatedGradientCatalog: () =>
		call<AnimatedGradientCatalog>("animatedGradientCatalog"),
	randomAnimatedGradient: () =>
		call<AnimatedGradientConfig>("randomAnimatedGradient"),
	createEditorInstance: () =>
		call<SerializedEditorInstance>("createEditorInstance"),
	getEditorProjectPath: () => call<string>("getEditorProjectPath"),
	getEditorMeta: () => call<RecordingMeta>("getEditorMeta"),
	getRecordingMetaByPath: (projectPath: string) =>
		call<RecordingMeta>("getRecordingMetaByPath", projectPath),
	getVideoMetadata: (path: string) =>
		call<VideoRecordingMetadata>("getVideoMetadata", path),
	getDefaultProjectConfig: () =>
		call<ProjectConfiguration>("getDefaultProjectConfig"),
	getDisplayFrameForCropping: (fps: number) =>
		call<Uint8Array>("getDisplayFrameForCropping", fps),
	getClipThumbnail: (recordingSegment: number, time: number) =>
		call<string>("getClipThumbnail", recordingSegment, time),
	getMicWaveforms: () => call<number[][]>("getMicWaveforms"),
	getSystemAudioWaveforms: () => call<number[][]>("getSystemAudioWaveforms"),
	loadCaptions: (videoId: string) =>
		call<CaptionData | null>("loadCaptions", videoId),
	startPlayback: (fps: number, resolutionBase: XY<number>) =>
		call<null>("startPlayback", fps, resolutionBase),
	stopPlayback: () => call<null>("stopPlayback"),
	seekTo: (frameNumber: number) => call<null>("seekTo", frameNumber),
	setPlayheadPosition: (frameNumber: number) =>
		call<null>("setPlayheadPosition", frameNumber),
	updateProjectConfigInMemory: (
		config: ProjectConfiguration,
		frameNumber: number | null,
		fps: number | null,
		resolutionBase: XY<number> | null,
	) =>
		call<null>(
			"updateProjectConfigInMemory",
			config,
			frameNumber,
			fps,
			resolutionBase,
		),
	setProjectConfig: (config: ProjectConfiguration) =>
		call<null>("setProjectConfig", config),
	setPrettyName: (prettyName: string) =>
		call<null>("setPrettyName", prettyName),
	checkUpgradedAndUpdate: () => call<boolean>("checkUpgradedAndUpdate"),
	openUpgrade: () => call<null>("showWindow", "Upgrade"),
	editorDeleteProject: () => call<null>("editorDeleteProject"),
	globalMessageDialog: (message: string) =>
		call<void>("globalMessageDialog", message),
	importAudioTrackFile: (file: File) =>
		call<ImportedAudioTrack>("importAudioTrackFile", file),
	importEditorImage: (file: File) =>
		call<{ path: string }>("importEditorImage", file),
	importCurrentDesktopBackground: (file: File) =>
		call<string>("importCurrentDesktopBackground", file),
	addExistingRecordingToEditor: (file: File) =>
		call<number>("addExistingRecordingToEditor", file),
	transcribeAudio: (
		videoPath: string,
		modelPath: string,
		language: string,
		engine: TranscriptionEngine,
	) =>
		call<CaptionData>(
			"transcribeAudio",
			videoPath,
			modelPath,
			language,
			engine,
		),
	exportVideoToFile: (
		projectPath: string,
		progress: EditorChannel<FramesRendered>,
		settings: ExportSettings,
		fileName: string,
		fileType: string,
	) =>
		call<string>(
			"exportVideoToFile",
			projectPath,
			progress,
			settings,
			fileName,
			fileType,
		),
	cancelCurrentWindowExports: () => call<void>("cancelCurrentWindowExports"),
	generateExportPreviewFast: (
		frameTime: number,
		settings: ExportPreviewSettings,
	) =>
		call<ExportPreviewResult>("generateExportPreviewFast", frameTime, settings),
	getExportEstimates: (
		path: string,
		settings: ExportSettings,
		onEstimate: EditorChannel<ExportEstimates>,
	) => call<ExportEstimates>("getExportEstimates", path, settings, onEstimate),
	cancelExportEstimates: () => call<void>("cancelExportEstimates"),
};

// The host page matches these on the `tauri:` prefix.
export function hostCommand<T>(name: string, args?: unknown) {
	return editorTransport().invoke(`tauri:${name}`, [args]) as Promise<T>;
}

type EditorEvent<T> = {
	listen: (callback: (event: { payload: T }) => void) => Promise<() => void>;
	once: (callback: (event: { payload: T }) => void) => Promise<() => void>;
	emit: (payload: T) => Promise<void>;
};

function editorEvent<T>(name: string): EditorEvent<T> {
	return {
		listen: (callback) =>
			Promise.resolve(
				editorTransport().listen(name, (payload) =>
					callback({ payload: payload as T }),
				),
			),
		once: (callback) => {
			const unlisten = editorTransport().listen(name, (payload) => {
				unlisten();
				callback({ payload: payload as T });
			});
			return Promise.resolve(unlisten);
		},
		emit: (payload) => editorTransport().emit(name, payload),
	};
}

export const events = {
	editorStateChanged: editorEvent<EditorStateChanged>("editorStateChanged"),
	frameLayoutEvent: editorEvent<FrameLayoutEvent>("frameLayoutEvent"),
	renderFrameEvent: editorEvent<RenderFrameEvent>("renderFrameEvent"),
};

export function listenEditorEvent(
	name: string,
	callback: (payload: unknown) => void,
) {
	return editorTransport().listen(name, callback);
}

export function emitEditorEvent(name: string, payload?: unknown) {
	return editorTransport().emit(name, payload);
}

let nextChannelId = 1;

// Crosses the port as `__CHANNEL__:<id>`; the host answers with
// `{ kind: "channel", id }`.
export class EditorChannel<T> {
	readonly id = nextChannelId++;

	constructor(onmessage: (message: T) => void) {
		registerEditorChannel(this.id, onmessage);
	}

	close() {
		unregisterEditorChannel(this.id);
	}

	toJSON() {
		return `__CHANNEL__:${this.id}`;
	}
}
