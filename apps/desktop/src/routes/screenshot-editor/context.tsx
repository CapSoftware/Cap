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

const NV12_FORMAT_MAGIC = 0x4e563132;

function convertNv12ToRgba(
	nv12Data: Uint8ClampedArray,
	width: number,
	height: number,
	yStride: number,
): Uint8ClampedArray {
	const rgbaSize = width * height * 4;
	const rgba = new Uint8ClampedArray(rgbaSize);

	const ySize = yStride * height;
	const yPlane = nv12Data;
	const uvPlane = nv12Data.subarray(ySize);
	const uvStride = width;

	for (let row = 0; row < height; row++) {
		const yRowOffset = row * yStride;
		const uvRowOffset = Math.floor(row / 2) * uvStride;
		const rgbaRowOffset = row * width * 4;

		for (let col = 0; col < width; col++) {
			const y = yPlane[yRowOffset + col] - 16;

			const uvCol = Math.floor(col / 2) * 2;
			const u = uvPlane[uvRowOffset + uvCol] - 128;
			const v = uvPlane[uvRowOffset + uvCol + 1] - 128;

			const c = 298 * y;
			const d = u;
			const e = v;

			let r = (c + 409 * e + 128) >> 8;
			let g = (c - 100 * d - 208 * e + 128) >> 8;
			let b = (c + 516 * d + 128) >> 8;

			r = r < 0 ? 0 : r > 255 ? 255 : r;
			g = g < 0 ? 0 : g > 255 ? 255 : g;
			b = b < 0 ? 0 : b > 255 ? 255 : b;

			const rgbaOffset = rgbaRowOffset + col * 4;
			rgba[rgbaOffset] = r;
			rgba[rgbaOffset + 1] = g;
			rgba[rgbaOffset + 2] = b;
			rgba[rgbaOffset + 3] = 255;
		}
	}

	return rgba;
}

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
	const [isImageFileReady, setIsImageFileReady] = createSignal(false);
	let wsRef: WebSocket | null = null;

	const [editorInstance] = createResource(async () => {
		const instance = await commands.createScreenshotEditorInstance();

		if (instance.config) {
			setProject(reconcile(instance.config));
			if (instance.config.annotations) {
				setAnnotations(reconcile(instance.config.annotations));
			}
		}

		setOriginalImageSize({
			width: instance.imageWidth,
			height: instance.imageHeight,
		});

		const hasReceivedWebSocketFrame = { value: false };

		if (instance.path) {
			const loadImage = (imagePath: string, retryCount = 0) => {
				const img = new Image();
				img.crossOrigin = "anonymous";
				img.src = convertFileSrc(imagePath);
				img.onload = async () => {
					setIsImageFileReady(true);
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
				img.onerror = () => {
					if (retryCount < 10) {
						setTimeout(() => loadImage(imagePath, retryCount + 1), 200);
					}
				};
				return img;
			};

			const pathStr = instance.path;
			const isCapDir = pathStr.endsWith(".cap");
			const imagePath = isCapDir ? `${pathStr}/original.png` : pathStr;
			loadImage(imagePath);
		}

		const ws = new WebSocket(instance.framesSocketUrl);
		wsRef = ws;
		ws.binaryType = "arraybuffer";
		ws.onmessage = async (event) => {
			const buffer = event.data as ArrayBuffer;

			let isNv12Format = false;
			if (buffer.byteLength >= 28) {
				const formatCheck = new DataView(buffer, buffer.byteLength - 4, 4);
				isNv12Format = formatCheck.getUint32(0, true) === NV12_FORMAT_MAGIC;
			}

			let width: number;
			let height: number;
			let processedData: Uint8ClampedArray;

			if (isNv12Format) {
				if (buffer.byteLength < 28) return;

				const metadataOffset = buffer.byteLength - 28;
				const meta = new DataView(buffer, metadataOffset, 28);
				const yStride = meta.getUint32(0, true);
				height = meta.getUint32(4, true);
				width = meta.getUint32(8, true);

				if (!width || !height) return;

				const ySize = yStride * height;
				const uvSize = width * (height / 2);
				const totalSize = ySize + uvSize;

				const nv12Data = new Uint8ClampedArray(buffer, 0, totalSize);
				processedData = convertNv12ToRgba(nv12Data, width, height, yStride);
			} else {
				if (buffer.byteLength < 24) return;

				const metadataOffset = buffer.byteLength - 24;
				const meta = new DataView(buffer, metadataOffset, 24);
				const strideBytes = meta.getUint32(0, true);
				height = meta.getUint32(4, true);
				width = meta.getUint32(8, true);

				if (!width || !height) return;

				const expectedRowBytes = width * 4;
				const frameData = new Uint8ClampedArray(
					buffer,
					0,
					buffer.byteLength - 24,
				);

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
			}

			hasReceivedWebSocketFrame.value = true;
			setIsRenderReady(true);

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

	const SCREEN_MAX_PADDING = 0.4;

	const calculateImageTransform = (
		frameSize: { width: number; height: number },
		imageSize: { width: number; height: number },
		padding: number,
		crop: { position: XY<number>; size: XY<number> } | null,
	) => {
		const cropWidth = crop?.size.x ?? imageSize.width;
		const cropHeight = crop?.size.y ?? imageSize.height;
		const croppedAspect = cropWidth / cropHeight;
		const outputAspect = frameSize.width / frameSize.height;

		const paddingFactor = (padding / 100.0) * SCREEN_MAX_PADDING;
		const cropBasis = Math.max(cropWidth, cropHeight);
		const paddingPixels = cropBasis * paddingFactor;

		const availableWidth = frameSize.width - 2 * paddingPixels;
		const availableHeight = frameSize.height - 2 * paddingPixels;

		const isHeightConstrained = croppedAspect <= outputAspect;

		let targetWidth: number;
		let targetHeight: number;
		if (isHeightConstrained) {
			targetHeight = availableHeight;
			targetWidth = availableHeight * croppedAspect;
		} else {
			targetWidth = availableWidth;
			targetHeight = availableWidth / croppedAspect;
		}

		const targetOffsetX = (frameSize.width - targetWidth) / 2;
		const targetOffsetY = (frameSize.height - targetHeight) / 2;

		const offsetX = isHeightConstrained ? targetOffsetX : paddingPixels;
		const offsetY = isHeightConstrained ? paddingPixels : targetOffsetY;

		return {
			offset: { x: offsetX, y: offsetY },
			size: { width: targetWidth, height: targetHeight },
		};
	};

	let prevState: {
		frameSize: { width: number; height: number };
		imageSize: { width: number; height: number };
		transform: {
			offset: { x: number; y: number };
			size: { width: number; height: number };
		};
	} | null = null;

	createEffect(
		on(
			() => ({
				frame: latestFrame(),
				imageSize: originalImageSize(),
				padding: project.background.padding,
				crop: project.background.crop,
			}),
			({ frame, imageSize, padding, crop }) => {
				if (!frame || !imageSize) return;

				const frameSize = { width: frame.width, height: frame.height };

				const frameSizeChanged =
					!prevState ||
					Math.abs(frameSize.width - prevState.frameSize.width) > 1 ||
					Math.abs(frameSize.height - prevState.frameSize.height) > 1;

				if (!frameSizeChanged) {
					return;
				}

				const currentTransform = calculateImageTransform(
					frameSize,
					imageSize,
					padding,
					crop,
				);

				const rawAnnotations = unwrap(annotations);
				const shouldTransform =
					prevState && rawAnnotations.length > 0 && frameSizeChanged;

				if (shouldTransform && prevState) {
					const scaleX =
						currentTransform.size.width / prevState.transform.size.width;
					const scaleY =
						currentTransform.size.height / prevState.transform.size.height;

					const oldOffset = prevState.transform.offset;
					const newOffset = currentTransform.offset;

					const updatedAnnotations = rawAnnotations.map((ann) => {
						const relX = ann.x - oldOffset.x;
						const relY = ann.y - oldOffset.y;

						const newX = newOffset.x + relX * scaleX;
						const newY = newOffset.y + relY * scaleY;

						const newWidth = ann.width * scaleX;
						const newHeight = ann.height * scaleY;

						return {
							...ann,
							x: newX,
							y: newY,
							width: newWidth,
							height: newHeight,
						};
					});

					setAnnotations(reconcile(updatedAnnotations));
				}

				prevState = {
					frameSize,
					imageSize,
					transform: currentTransform,
				};
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
		isImageFileReady,
		editorInstance,
	};
}

export const [ScreenshotEditorProvider, useScreenshotEditorContext] =
	createContextProvider(
		createScreenshotEditorContext,
		null as unknown as ReturnType<typeof createScreenshotEditorContext>,
	);
