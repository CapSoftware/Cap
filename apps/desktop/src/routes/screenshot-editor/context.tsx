import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { debounce, throttle } from "@solid-primitives/scheduled";
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
import { createLazySignal, type FrameData } from "~/utils/socket";
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
			type: "color",
			value: [255, 255, 255],
			alpha: 255,
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
	const [originalImageSize, setOriginalImageSize] = createSignal<{
		width: number;
		height: number;
	} | null>(null);
	const [isRenderReady, setIsRenderReady] = createSignal(false);
	let wsRef: WebSocket | null = null;

	const [editorInstance] = createResource(async () => {
		const instance = await commands.createScreenshotEditorInstance();

		if (instance.config) {
			setProject(reconcile(instance.config));
			if (instance.config.annotations) {
				setAnnotations(reconcile(instance.config.annotations));
			}
		}

		const hasReceivedWebSocketFrame = { value: false };

		if (instance.path) {
			const loadImage = (imagePath: string) => {
				const img = new Image();
				img.crossOrigin = "anonymous";
				img.src = convertFileSrc(imagePath);
				img.onload = async () => {
					setOriginalImageSize({
						width: img.naturalWidth,
						height: img.naturalHeight,
					});
					if (hasReceivedWebSocketFrame.value) {
						return;
					}
					try {
						const bitmap = await createImageBitmap(img);
						if (hasReceivedWebSocketFrame.value) {
							bitmap.close();
							return;
						}
						const existing = latestFrame();
						if (existing?.bitmap) {
							existing.bitmap.close();
						}
						setLatestFrame({
							width: img.naturalWidth,
							height: img.naturalHeight,
							bitmap,
						});
						setIsRenderReady(true);
					} catch (e: unknown) {
						console.error(
							"Failed to create ImageBitmap from fallback image:",
							e,
						);
					}
				};
				return img;
			};

			const pathStr = instance.path;
			const isCapDir = pathStr.endsWith(".cap");

			if (isCapDir) {
				const originalPath = `${pathStr}/original.png`;
				const img = loadImage(originalPath);
				img.onerror = () => {
					loadImage(pathStr);
				};
			} else {
				loadImage(pathStr);
			}
		}

		const ws = new WebSocket(instance.framesSocketUrl);
		wsRef = ws;
		ws.binaryType = "arraybuffer";
		ws.onmessage = async (event) => {
			const buffer = event.data as ArrayBuffer;
			if (buffer.byteLength < 24) return;

			const metadataOffset = buffer.byteLength - 24;
			const meta = new DataView(buffer, metadataOffset, 24);
			const strideBytes = meta.getUint32(0, true);
			const height = meta.getUint32(4, true);
			const width = meta.getUint32(8, true);

			if (!width || !height) return;

			hasReceivedWebSocketFrame.value = true;
			setIsRenderReady(true);

			const expectedRowBytes = width * 4;
			const frameData = new Uint8ClampedArray(
				buffer,
				0,
				buffer.byteLength - 24,
			);

			let processedData: Uint8ClampedArray;
			if (strideBytes === expectedRowBytes) {
				processedData = frameData.subarray(0, expectedRowBytes * height);
			} else {
				processedData = new Uint8ClampedArray(expectedRowBytes * height);
				for (let row = 0; row < height; row++) {
					const srcStart = row * strideBytes;
					const destStart = row * expectedRowBytes;
					processedData.set(
						frameData.subarray(srcStart, srcStart + expectedRowBytes),
						destStart,
					);
				}
			}

			try {
				const imageData = new ImageData(processedData, width, height);
				const bitmap = await createImageBitmap(imageData);
				const existing = latestFrame();
				if (existing?.bitmap && existing.bitmap !== bitmap) {
					existing.bitmap.close();
				}
				setLatestFrame({ width, height, bitmap });
			} catch {}
		};

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
		if (wsRef) {
			wsRef.close();
			wsRef = null;
		}
	});

	const FPS = 60;
	const FRAME_TIME = 1000 / FPS;

	const doRenderUpdate = (config: ProjectConfiguration) => {
		commands.updateScreenshotConfig(config, false);
	};

	const throttledRenderUpdate = throttle(doRenderUpdate, FRAME_TIME);
	const trailingRenderUpdate = debounce(doRenderUpdate, FRAME_TIME + 16);

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

				throttledRenderUpdate(config);
				trailingRenderUpdate(config);
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
		originalImageSize,
		isRenderReady,
		editorInstance,
	};
}

export const [ScreenshotEditorProvider, useScreenshotEditorContext] =
	createContextProvider(
		createScreenshotEditorContext,
		null as unknown as ReturnType<typeof createScreenshotEditorContext>,
	);
