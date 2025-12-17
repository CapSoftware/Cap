import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { debounce } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
	createEffect,
	createResource,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import {
	createImageDataWS,
	createLazySignal,
	type FrameData,
} from "~/utils/socket";
import {
	type Annotation,
	type AnnotationType,
	type AudioConfiguration,
	type Camera,
	type CursorConfiguration,
	commands,
	type HotkeysConfiguration,
	type ProjectConfiguration,
	type XY,
} from "~/utils/tauri";

export type ScreenshotProject = ProjectConfiguration;
export type { Annotation, AnnotationType };

export type CurrentDialog =
	| { type: "createPreset" }
	| { type: "renamePreset"; presetIndex: number }
	| { type: "deletePreset"; presetIndex: number }
	| {
			type: "crop";
			originalSize: XY<number>;
			currentCrop: { position: XY<number>; size: XY<number> } | null;
	  };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

const DEFAULT_CAMERA: Camera = {
	hide: false,
	mirror: false,
	position: { x: "right", y: "bottom" },
	size: 30,
	zoom_size: 60,
	rounding: 0,
	shadow: 0,
	advancedShadow: null,
	shape: "square",
	roundingType: "squircle",
} as unknown as Camera;

const DEFAULT_AUDIO: AudioConfiguration = {
	mute: false,
	improve: false,
	micVolumeDb: 0,
	micStereoMode: "stereo",
	systemVolumeDb: 0,
};

const DEFAULT_CURSOR: CursorConfiguration = {
	hide: false,
	hideWhenIdle: false,
	hideWhenIdleDelay: 2,
	size: 100,
	type: "auto",
	animationStyle: "mellow",
	tension: 120,
	mass: 1.1,
	friction: 18,
	raw: false,
	motionBlur: 0,
	useSvg: true,
};

const DEFAULT_HOTKEYS: HotkeysConfiguration = {
	show: false,
};

const DEFAULT_PROJECT: ScreenshotProject = {
	background: {
		source: {
			type: "wallpaper",
			path: "macOS/sequoia-dark",
		},
		blur: 0,
		padding: 20,
		rounding: 10,
		roundingType: "squircle",
		inset: 0,
		crop: null,
		shadow: 0,
		advancedShadow: null,
		border: null,
	},
	aspectRatio: null,
	camera: DEFAULT_CAMERA,
	audio: DEFAULT_AUDIO,
	cursor: DEFAULT_CURSOR,
	hotkeys: DEFAULT_HOTKEYS,
	timeline: null,
	captions: null,
	clips: [],
	annotations: [],
} as unknown as ScreenshotProject;

function createScreenshotEditorContext() {
	const [project, setProject] = createStore<ScreenshotProject>(DEFAULT_PROJECT);
	const [annotations, setAnnotations] = createStore<Annotation[]>([]);
	const [selectedAnnotationId, setSelectedAnnotationId] = createSignal<
		string | null
	>(null);
	const [activeTool, setActiveTool] = createSignal<AnnotationType | "select">(
		"select",
	);

	const [layersPanelOpen, setLayersPanelOpen] = makePersisted(
		createSignal(false),
		{ name: "screenshotEditorLayersPanelOpen" },
	);
	const [focusAnnotationId, setFocusAnnotationId] = createSignal<string | null>(
		null,
	);

	const [activePopover, setActivePopover] = createSignal<
		"background" | "padding" | "rounding" | "shadow" | "border" | null
	>(null);

	const [dialog, setDialog] = createSignal<DialogState>({
		open: false,
	});

	const [latestFrame, setLatestFrame] = createLazySignal<FrameData>();

	const [editorInstance] = createResource(async () => {
		const instance = await commands.createScreenshotEditorInstance();

		if (instance.config) {
			setProject(reconcile(instance.config));
			if (instance.config.annotations) {
				setAnnotations(reconcile(instance.config.annotations));
			}
		}

		if (instance.path) {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.src = convertFileSrc(instance.path);
			img.onload = async () => {
				try {
					const bitmap = await createImageBitmap(img);
					const existing = latestFrame();
					if (existing?.bitmap) {
						existing.bitmap.close();
					}
					setLatestFrame({
						width: img.naturalWidth,
						height: img.naturalHeight,
						bitmap,
					});
				} catch (e: unknown) {
					console.error("Failed to create ImageBitmap from fallback image:", e);
				}
			};
			img.onerror = (event) => {
				console.error("Failed to load screenshot image:", {
					path: instance.path,
					src: img.src,
					event,
				});
			};
		}

		const [_ws, _isConnected, _isWorkerReady] = createImageDataWS(
			instance.framesSocketUrl,
			setLatestFrame,
		);

		return instance;
	});

	createEffect(
		on(latestFrame, (current, previous) => {
			if (previous?.bitmap && previous.bitmap !== current?.bitmap) {
				previous.bitmap.close();
			}
		}),
	);

	onCleanup(() => {
		const frame = latestFrame();
		if (frame?.bitmap) {
			frame.bitmap.close();
		}
	});

	const saveConfig = debounce((config: ProjectConfiguration) => {
		commands.updateScreenshotConfig(config, true);
	}, 1000);

	createEffect(
		on(
			[
				() => trackStore(project),
				() => trackStore(annotations),
				editorInstance,
			],
			async ([, , instance]) => {
				if (!instance) return;

				const config = {
					...unwrap(project),
					annotations: unwrap(annotations),
				};

				commands.updateScreenshotConfig(config, false);
				saveConfig(config);
			},
		),
	);

	// History Implementation
	const [history, setHistory] = createStore<{
		past: { project: ScreenshotProject; annotations: Annotation[] }[];
		future: { project: ScreenshotProject; annotations: Annotation[] }[];
	}>({
		past: [],
		future: [],
	});

	type HistorySnapshot = {
		project: ScreenshotProject;
		annotations: Annotation[];
	};

	let pausedHistorySnapshot: HistorySnapshot | null = null;
	let hasPausedHistoryChanges = false;
	const [historyPauseCount, setHistoryPauseCount] = createSignal(0);

	createEffect(
		on([() => trackStore(project), () => trackStore(annotations)], () => {
			if (historyPauseCount() > 0) {
				hasPausedHistoryChanges = true;
			}
		}),
	);

	const pushHistory = (snapshot: HistorySnapshot | null = null) => {
		const state = snapshot ?? {
			project: structuredClone(unwrap(project)),
			annotations: structuredClone(unwrap(annotations)),
		};
		setHistory("past", (p) => [...p, state]);
		setHistory("future", []);
	};

	const pauseHistory = () => {
		if (historyPauseCount() === 0) {
			pausedHistorySnapshot = {
				project: structuredClone(unwrap(project)),
				annotations: structuredClone(unwrap(annotations)),
			};
			hasPausedHistoryChanges = false;
		}

		setHistoryPauseCount((count) => count + 1);

		let resumed = false;

		return () => {
			if (resumed) return;
			resumed = true;

			setHistoryPauseCount((count) => {
				const next = Math.max(0, count - 1);

				if (next === 0) {
					if (pausedHistorySnapshot && hasPausedHistoryChanges) {
						pushHistory(pausedHistorySnapshot);
					}

					pausedHistorySnapshot = null;
					hasPausedHistoryChanges = false;
				}

				return next;
			});
		};
	};

	const undo = () => {
		if (history.past.length === 0) return;
		const previous = history.past[history.past.length - 1];
		const current = {
			project: structuredClone(unwrap(project)),
			annotations: structuredClone(unwrap(annotations)),
		};

		setHistory("past", (p) => p.slice(0, -1));
		setHistory("future", (f) => [current, ...f]);

		setProject(reconcile(previous.project));
		setAnnotations(reconcile(previous.annotations));
	};

	const redo = () => {
		if (history.future.length === 0) return;
		const next = history.future[0];
		const current = {
			project: structuredClone(unwrap(project)),
			annotations: structuredClone(unwrap(annotations)),
		};

		setHistory("future", (f) => f.slice(1));
		setHistory("past", (p) => [...p, current]);

		setProject(reconcile(next.project));
		setAnnotations(reconcile(next.annotations));
	};

	const canUndo = () => history.past.length > 0;
	const canRedo = () => history.future.length > 0;

	const projectHistory = {
		push: pushHistory,
		undo,
		redo,
		canUndo,
		canRedo,
		pause: pauseHistory,
		isPaused: () => historyPauseCount() > 0,
	};

	return {
		get path() {
			return editorInstance()?.path ?? "";
		},
		get prettyName() {
			return editorInstance()?.prettyName ?? "Screenshot";
		},
		project,
		setProject,
		annotations,
		setAnnotations,
		selectedAnnotationId,
		setSelectedAnnotationId,
		activeTool,
		setActiveTool,
		layersPanelOpen,
		setLayersPanelOpen,
		focusAnnotationId,
		setFocusAnnotationId,
		activePopover,
		setActivePopover,
		projectHistory,
		dialog,
		setDialog,
		latestFrame,
		editorInstance,
	};
}

export const [ScreenshotEditorProvider, useScreenshotEditorContext] =
	createContextProvider(
		createScreenshotEditorContext,
		null as unknown as ReturnType<typeof createScreenshotEditorContext>,
	);
