import {
	createElementBounds,
	type NullableBounds,
} from "@solid-primitives/bounds";
import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { createUndoHistory } from "@solid-primitives/history";
import { createQuery, skipToken } from "@tanstack/solid-query";
import {
	type Accessor,
	batch,
	createEffect,
	createMemo,
	createResource,
	createRoot,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";

import { generalSettingsStore } from "~/store";

import { createPresets } from "~/utils/createPresets";
import { createCustomDomainQuery } from "~/utils/queries";
import {
	type CanvasControls,
	createImageDataWS,
	createLazySignal,
	type FrameData,
} from "~/utils/socket";
import {
	commands,
	type EditorPreviewQuality,
	events,
	type FramesRendered,
	type MultipleSegments,
	type ProjectConfiguration,
	type RecordingMeta,
	type SceneSegment,
	type SerializedEditorInstance,
	type SingleSegment,
	type TimelineConfiguration,
	type XY,
} from "~/utils/tauri";
import {
	cleanup as cleanupCropVideoPreloader,
	preloadCropVideoMetadata,
} from "./cropVideoPreloader";
import type { MaskSegment } from "./masks";
import type { TextSegment } from "./text";
import { createProgressBar } from "./utils";

export type CurrentDialog =
	| { type: "createPreset" }
	| { type: "renamePreset"; presetIndex: number }
	| { type: "deletePreset"; presetIndex: number }
	| { type: "crop"; position: XY<number>; size: XY<number> }
	| { type: "export" };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

export const FPS = 60;

export const OUTPUT_SIZE = {
	x: 1920,
	y: 1080,
};

export const DEFAULT_PREVIEW_QUALITY: EditorPreviewQuality = "half";

const previewQualityScale: Record<EditorPreviewQuality, number> = {
	full: 1,
	half: 0.65,
	quarter: 0.25,
};

export const getPreviewResolution = (
	quality: EditorPreviewQuality,
): XY<number> => {
	const scale = previewQualityScale[quality];
	const width = (Math.max(2, Math.round(OUTPUT_SIZE.x * scale)) + 1) & ~1;
	const height = (Math.max(2, Math.round(OUTPUT_SIZE.y * scale)) + 1) & ~1;

	return { x: width, y: height };
};

export type TimelineTrackType = "clip" | "text" | "zoom" | "scene" | "mask" | "caption" | "keyboard";

export const MAX_ZOOM_IN = 3;
const PROJECT_SAVE_DEBOUNCE_MS = 250;

export type RenderState =
	| { type: "starting" }
	| { type: "rendering"; progress: FramesRendered };

export type CustomDomainResponse = {
	custom_domain: string | null;
	domain_verified: boolean | null;
};

export type CornerRoundingType = "rounded" | "squircle";

type WithCornerStyle<T> = T & { roundingType: CornerRoundingType };

type CaptionTrackSegment = {
	id: string;
	start: number;
	end: number;
	text: string;
	words?: Array<{ text: string; start: number; end: number }>;
	fadeDurationOverride?: number | null;
	lingerDurationOverride?: number | null;
	positionOverride?: string | null;
	colorOverride?: string | null;
	backgroundColorOverride?: string | null;
	fontSizeOverride?: number | null;
};

type KeyboardTrackSegment = {
	id: string;
	start: number;
	end: number;
	displayText: string;
	keys?: Array<{ key: string; timeOffset: number }>;
	fadeDurationOverride?: number | null;
	positionOverride?: string | null;
	colorOverride?: string | null;
	backgroundColorOverride?: string | null;
	fontSizeOverride?: number | null;
};

type EditorTimelineConfiguration = Omit<
	TimelineConfiguration,
	"sceneSegments" | "maskSegments"
> & {
	sceneSegments?: SceneSegment[];
	maskSegments: MaskSegment[];
	textSegments: TextSegment[];
	captionSegments: CaptionTrackSegment[];
	keyboardSegments: KeyboardTrackSegment[];
};

export type EditorProjectConfiguration = Omit<
	ProjectConfiguration,
	"background" | "camera" | "timeline"
> & {
	background: WithCornerStyle<ProjectConfiguration["background"]>;
	camera: WithCornerStyle<ProjectConfiguration["camera"]>;
	timeline?: EditorTimelineConfiguration | null;
	hiddenTextSegments?: number[];
};

function withCornerDefaults<
	T extends {
		roundingType?: CornerRoundingType;
		rounding_type?: CornerRoundingType;
	},
>(value: T): T & { roundingType: CornerRoundingType } {
	const roundingType = value.roundingType ?? value.rounding_type ?? "squircle";
	return {
		...value,
		roundingType,
	};
}

export function normalizeProject(
	config: ProjectConfiguration,
): EditorProjectConfiguration {
	const timeline = config.timeline
		? {
				...config.timeline,
				sceneSegments: config.timeline.sceneSegments ?? [],
				maskSegments:
					(
						config.timeline as TimelineConfiguration & {
							maskSegments?: MaskSegment[];
						}
					).maskSegments ?? [],
				textSegments:
					(
						config.timeline as TimelineConfiguration & {
							textSegments?: TextSegment[];
						}
					).textSegments ?? [],
				captionSegments:
					(
						config.timeline as TimelineConfiguration & {
							captionSegments?: CaptionTrackSegment[];
						}
					).captionSegments ?? [],
				keyboardSegments:
					(
						config.timeline as TimelineConfiguration & {
							keyboardSegments?: KeyboardTrackSegment[];
						}
					).keyboardSegments ?? [],
			}
		: undefined;

	return {
		...config,
		timeline,
		background: withCornerDefaults(config.background),
		camera: withCornerDefaults(config.camera),
	};
}

export function serializeProjectConfiguration(
	project: EditorProjectConfiguration,
): ProjectConfiguration {
	const { background, camera, ...rest } = project;
	const { roundingType: backgroundRoundingType, ...backgroundRest } =
		background;
	const { roundingType: cameraRoundingType, ...cameraRest } = camera;

	const timeline = project.timeline
		? {
				...project.timeline,
				maskSegments: project.timeline.maskSegments ?? [],
				textSegments: project.timeline.textSegments ?? [],
				captionSegments: project.timeline.captionSegments ?? [],
				keyboardSegments: project.timeline.keyboardSegments ?? [],
			}
		: project.timeline;

	return {
		...rest,
		timeline: timeline as unknown as ProjectConfiguration["timeline"],
		background: {
			...backgroundRest,
			roundingType: backgroundRoundingType,
		},
		camera: {
			...cameraRest,
			roundingType: cameraRoundingType,
		},
	};
}

export const [EditorContextProvider, useEditorContext] = createContextProvider(
	(props: {
		meta: () => TransformedMeta;
		editorInstance: SerializedEditorInstance;
		refetchMeta(): Promise<void>;
	}) => {
		const editorInstanceContext = useEditorInstanceContext();
		const [project, setProject] = createStore<EditorProjectConfiguration>(
			normalizeProject(props.editorInstance.savedProjectConfig),
		);

		const projectActions = {
			splitClipSegment: (time: number) => {
				setProject(
					"timeline",
					"segments",
					produce((segments) => {
						let searchTime = time;
						let _prevDuration = 0;
						const currentSegmentIndex = segments.findIndex((segment) => {
							const duration =
								(segment.end - segment.start) / segment.timescale;
							if (searchTime > duration) {
								searchTime -= duration;
								_prevDuration += duration;
								return false;
							}

							return true;
						});

						if (currentSegmentIndex === -1) return;
						const segment = segments[currentSegmentIndex];

						const splitPositionInRecording = searchTime * segment.timescale;

						segments.splice(currentSegmentIndex + 1, 0, {
							...segment,
							start: segment.start + splitPositionInRecording,
							end: segment.end,
						});
						segments[currentSegmentIndex].end =
							segment.start + splitPositionInRecording;
					}),
				);
			},
			deleteClipSegment: (segmentIndex: number) => {
				if (!project.timeline) return;
				const segment = project.timeline.segments[segmentIndex];
				if (
					!segment ||
					!segment.recordingSegment === undefined ||
					project.timeline.segments.filter(
						(s) => s.recordingSegment === segment.recordingSegment,
					).length < 2
				)
					return;

				batch(() => {
					setProject(
						"timeline",
						"segments",
						produce((s) => {
							if (!s) return;
							s.splice(segmentIndex, 1);
						}),
					);
					setEditorState("timeline", "selection", null);
				});
			},
			splitZoomSegment: (index: number, time: number) => {
				setProject(
					"timeline",
					"zoomSegments",
					produce((segments) => {
						const segment = segments[index];
						if (!segment) return;

						const newLengths = [segment.end - segment.start - time, time];

						if (newLengths.some((l) => l < 1)) return;

						segments.splice(index + 1, 0, {
							...segment,
							start: segment.start + time,
							end: segment.end,
						});
						segments[index].end = segment.start + time;
					}),
				);
			},
			deleteZoomSegments: (segmentIndices: number[]) => {
				batch(() => {
					setProject(
						"timeline",
						"zoomSegments",
						produce((s) => {
							if (!s) return;
							// Normalize: numbers only, in-bounds, deduped, then descending
							const sorted = [...new Set(segmentIndices)]
								.filter((i) => Number.isInteger(i) && i >= 0 && i < s.length)
								.sort((a, b) => b - a);
							if (sorted.length === 0) return;
							for (const i of sorted) s.splice(i, 1);
						}),
					);
					setEditorState("timeline", "selection", null);
				});
			},
			splitMaskSegment: (index: number, time: number) => {
				setProject(
					"timeline",
					"maskSegments",
					produce((segments) => {
						const segment = segments?.[index];
						if (!segment) return;

						const duration = segment.end - segment.start;
						const remaining = duration - time;
						if (time < 1 || remaining < 1) return;

						segments.splice(index + 1, 0, {
							...segment,
							start: segment.start + time,
							end: segment.end,
						});
						segments[index].end = segment.start + time;
					}),
				);
			},
			deleteMaskSegments: (segmentIndices: number[]) => {
				batch(() => {
					setProject(
						"timeline",
						"maskSegments",
						produce((segments) => {
							if (!segments) return;
							const sorted = [...new Set(segmentIndices)]
								.filter(
									(i) => Number.isInteger(i) && i >= 0 && i < segments.length,
								)
								.sort((a, b) => b - a);
							for (const i of sorted) segments.splice(i, 1);
						}),
					);
					setEditorState("timeline", "selection", null);
				});
			},
			splitTextSegment: (index: number, time: number) => {
				setProject(
					"timeline",
					"textSegments",
					produce((segments) => {
						const segment = segments?.[index];
						if (!segment) return;

						const duration = segment.end - segment.start;
						const remaining = duration - time;
						if (time < 1 || remaining < 1) return;

						segments.splice(index + 1, 0, {
							...segment,
							start: segment.start + time,
							end: segment.end,
						});
						segments[index].end = segment.start + time;
					}),
				);
			},
			deleteTextSegments: (segmentIndices: number[]) => {
				batch(() => {
					setProject(
						"timeline",
						"textSegments",
						produce((segments) => {
							if (!segments) return;
							const sorted = [...new Set(segmentIndices)]
								.filter(
									(i) => Number.isInteger(i) && i >= 0 && i < segments.length,
								)
								.sort((a, b) => b - a);
							for (const i of sorted) segments.splice(i, 1);
						}),
					);
					setEditorState("timeline", "selection", null);
				});
			},
			splitSceneSegment: (index: number, time: number) => {
				setProject(
					"timeline",
					"sceneSegments",
					produce((segments) => {
						const segment = segments?.[index];
						if (!segment) return;

						const newLengths = [segment.end - segment.start - time, time];

						if (newLengths.some((l) => l < 1)) return;

						segments.splice(index + 1, 0, {
							...segment,
							start: segment.start + time,
							end: segment.end,
						});
						segments[index].end = segment.start + time;
					}),
				);
			},
			deleteSceneSegment: (segmentIndex: number) => {
				batch(() => {
					setProject(
						"timeline",
						"sceneSegments",
						produce((s) => {
							if (!s) return;
							s.splice(segmentIndex, 1);
						}),
					);
					setEditorState("timeline", "selection", null);
				});
			},
			splitCaptionSegment: (index: number, time: number) => {
				setProject(
					"timeline",
					"captionSegments",
					produce((segments) => {
						const segment = segments?.[index];
						if (!segment) return;

						const duration = segment.end - segment.start;
						const remaining = duration - time;
						if (time < 0.5 || remaining < 0.5) return;

						segments.splice(index + 1, 0, {
							...segment,
							id: `caption-${Date.now()}`,
							start: segment.start + time,
							end: segment.end,
						});
						segments[index].end = segment.start + time;
					}),
				);
			},
			deleteCaptionSegments: (segmentIndices: number[]) => {
				batch(() => {
					setProject(
						"timeline",
						"captionSegments",
						produce((segments) => {
							if (!segments) return;
							const sorted = [...new Set(segmentIndices)]
								.filter(
									(i) => Number.isInteger(i) && i >= 0 && i < segments.length,
								)
								.sort((a, b) => b - a);
							for (const i of sorted) segments.splice(i, 1);
						}),
					);
					setEditorState("timeline", "selection", null);
				});
			},
			splitKeyboardSegment: (index: number, time: number) => {
				setProject(
					"timeline",
					"keyboardSegments",
					produce((segments) => {
						const segment = segments?.[index];
						if (!segment) return;

						const duration = segment.end - segment.start;
						const remaining = duration - time;
						if (time < 0.5 || remaining < 0.5) return;

						segments.splice(index + 1, 0, {
							...segment,
							id: `kb-${Date.now()}`,
							start: segment.start + time,
							end: segment.end,
						});
						segments[index].end = segment.start + time;
					}),
				);
			},
			deleteKeyboardSegments: (segmentIndices: number[]) => {
				batch(() => {
					setProject(
						"timeline",
						"keyboardSegments",
						produce((segments) => {
							if (!segments) return;
							const sorted = [...new Set(segmentIndices)]
								.filter(
									(i) => Number.isInteger(i) && i >= 0 && i < segments.length,
								)
								.sort((a, b) => b - a);
							for (const i of sorted) segments.splice(i, 1);
						}),
					);
					setEditorState("timeline", "selection", null);
				});
			},
			setClipSegmentTimescale: (index: number, timescale: number) => {
				setProject(
					produce((project) => {
						const timeline = project.timeline;
						if (!timeline) return;

						const segment = timeline.segments[index];
						if (!segment) return;

						const currentLength =
							(segment.end - segment.start) / segment.timescale;
						const nextLength = (segment.end - segment.start) / timescale;

						const lengthDiff = nextLength - currentLength;

						const absoluteStart = timeline.segments.reduce((acc, curr, i) => {
							if (i >= index) return acc;
							return acc + (curr.end - curr.start) / curr.timescale;
						}, 0);

						const diff = (v: number) => {
							const diff = (lengthDiff * (v - absoluteStart)) / currentLength;

							if (v > absoluteStart + currentLength) return lengthDiff;
							else if (v > absoluteStart) return diff;
							else return 0;
						};

						for (const zoomSegment of timeline.zoomSegments) {
							zoomSegment.start += diff(zoomSegment.start);
							zoomSegment.end += diff(zoomSegment.end);
						}

						for (const maskSegment of timeline.maskSegments) {
							maskSegment.start += diff(maskSegment.start);
							maskSegment.end += diff(maskSegment.end);
						}

						for (const textSegment of timeline.textSegments) {
							textSegment.start += diff(textSegment.start);
							textSegment.end += diff(textSegment.end);
						}

						segment.timescale = timescale;
					}),
				);
			},
		};

		let projectSaveTimeout: number | undefined;
		let saveInFlight = false;
		let shouldResave = false;
		let hasPendingProjectSave = false;

		const flushProjectConfig = async () => {
			if (!hasPendingProjectSave && !saveInFlight) return;
			if (saveInFlight) {
				if (hasPendingProjectSave) {
					shouldResave = true;
				}
				return;
			}
			saveInFlight = true;
			shouldResave = false;
			hasPendingProjectSave = false;
			try {
				const config = serializeProjectConfiguration(project);
				await commands.setProjectConfig(config);
			} catch (error) {
				console.error("Failed to persist project config", error);
			} finally {
				saveInFlight = false;
				if (shouldResave) {
					shouldResave = false;
					void flushProjectConfig();
				}
			}
		};

		const scheduleProjectConfigSave = () => {
			hasPendingProjectSave = true;
			if (projectSaveTimeout) {
				clearTimeout(projectSaveTimeout);
			}
			projectSaveTimeout = window.setTimeout(() => {
				projectSaveTimeout = undefined;
				void flushProjectConfig();
			}, PROJECT_SAVE_DEBOUNCE_MS);
		};

		onCleanup(() => {
			if (projectSaveTimeout) {
				clearTimeout(projectSaveTimeout);
				projectSaveTimeout = undefined;
			}
			void flushProjectConfig();
		});

		createEffect(
			on(
				() => {
					trackStore(project);
				},
				() => {
					scheduleProjectConfigSave();
				},
				{ defer: true },
			),
		);

		const [storedSettings] = createResource(() => generalSettingsStore.get());
		const initialPreviewQuality = createMemo((): EditorPreviewQuality => {
			const stored = storedSettings()?.editorPreviewQuality;
			if (stored === "quarter" || stored === "half" || stored === "full") {
				return stored;
			}
			return DEFAULT_PREVIEW_QUALITY;
		});

		const [previewQuality, _setPreviewQuality] =
			createSignal<EditorPreviewQuality>(DEFAULT_PREVIEW_QUALITY);

		createEffect(() => {
			const quality = initialPreviewQuality();
			_setPreviewQuality(quality);
		});

		const setPreviewQuality = (quality: EditorPreviewQuality) => {
			_setPreviewQuality(quality);
			generalSettingsStore
				.set({ editorPreviewQuality: quality })
				.catch((error) => {
					console.error("Failed to persist preview quality setting", error);
				});
		};

		const previewResolutionBase = () => getPreviewResolution(previewQuality());

		const [dialog, setDialog] = createSignal<DialogState>({
			open: false,
		});

		const [exportState, setExportState] = createStore<
			| { type: "idle" }
			| (
					| ({ action: "copy" } & (
							| RenderState
							| { type: "copying" }
							| { type: "done" }
					  ))
					| ({ action: "save" } & (
							| RenderState
							| { type: "copying" }
							| { type: "done" }
					  ))
					| ({ action: "upload" } & (
							| RenderState
							| { type: "uploading"; progress: number }
							| { type: "done" }
					  ))
			  )
		>({ type: "idle" });

		createProgressBar(() =>
			exportState?.type === "rendering"
				? (exportState.progress.renderedCount /
						exportState.progress.totalFrames) *
					100
				: undefined,
		);

		createEffect(
			on(
				() => editorState.playing,
				(active) => {
					if (!active)
						commands.setPlayheadPosition(
							Math.floor(editorState.playbackTime * FPS),
						);
				},
			),
		);

		const totalDuration = () =>
			project.timeline?.segments.reduce(
				(acc, s) => acc + (s.end - s.start) / s.timescale,
				0,
			) ?? props.editorInstance.recordingDuration;

		type State = {
			zoom: number;
			position: number;
		};

		const zoomOutLimit = () => Math.min(totalDuration(), 60 * 10);

		function updateZoom(state: State, newZoom: number, origin: number): State {
			const zoom = Math.max(Math.min(newZoom, zoomOutLimit()), MAX_ZOOM_IN);

			const visibleOrigin = origin - state.position;

			const originPercentage = Math.min(1, visibleOrigin / state.zoom);

			const newVisibleOrigin = zoom * originPercentage;
			const newPosition = origin - newVisibleOrigin;

			return {
				zoom,
				position: newPosition,
			};
		}

		const initialMaskTrackEnabled =
			(project.timeline?.maskSegments?.length ?? 0) > 0;
		const initialTextTrackEnabled =
			(project.timeline?.textSegments?.length ?? 0) > 0;
		const initialCaptionTrackEnabled =
			(project.timeline?.captionSegments?.length ?? 0) > 0 ||
			(project.captions?.segments?.length ?? 0) > 0;
		const initialKeyboardTrackEnabled =
			(project.timeline?.keyboardSegments?.length ?? 0) > 0;

		const [editorState, setEditorState] = createStore({
			previewTime: null as number | null,
			playbackTime: 0,
			playing: false,
			captions: {
				isGenerating: false,
				isDownloading: false,
				downloadProgress: 0,
				downloadingModel: null as string | null,
			},
			timeline: {
				interactMode: "seek" as "seek" | "split",
				selection: null as
					| null
					| { type: "zoom"; indices: number[] }
					| { type: "clip"; indices: number[] }
					| { type: "scene"; indices: number[] }
					| { type: "mask"; indices: number[] }
					| { type: "text"; indices: number[] }
					| { type: "caption"; indices: number[] }
					| { type: "keyboard"; indices: number[] },
				transform: {
					// visible seconds
					zoom: zoomOutLimit(),
					updateZoom(z: number, origin: number) {
						const { zoom, position } = updateZoom(
							{
								zoom: editorState.timeline.transform.zoom,
								position: editorState.timeline.transform.position,
							},
							z,
							origin,
						);

						const transform = editorState.timeline.transform;
						batch(() => {
							setEditorState("timeline", "transform", "zoom", zoom);
							if (transform.zoom !== zoom) return;
							transform.setPosition(position);
						});
					},
					// number of seconds of leftmost point
					position: 0,
					setPosition(p: number) {
						setEditorState(
							"timeline",
							"transform",
							"position",
							Math.min(
								Math.max(p, 0),
								Math.max(zoomOutLimit(), totalDuration()) +
									4 -
									editorState.timeline.transform.zoom,
							),
						);
					},
				},
				tracks: {
					clip: true,
					zoom: true,
					scene: true,
					mask: initialMaskTrackEnabled,
					text: initialTextTrackEnabled,
					caption: initialCaptionTrackEnabled,
					keyboard: initialKeyboardTrackEnabled,
				},
				hoveredTrack: null as null | TimelineTrackType,
			},
		});

		const [micWaveforms] = createResource(() => commands.getMicWaveforms());
		const [systemAudioWaveforms] = createResource(() =>
			commands.getSystemAudioWaveforms(),
		);
		const customDomain = createCustomDomainQuery();

		return {
			...editorInstanceContext,
			meta() {
				return props.meta();
			},
			customDomain,
			refetchMeta: () => props.refetchMeta(),
			editorInstance: props.editorInstance,
			dialog,
			setDialog,
			project,
			setProject,
			projectActions,
			projectHistory: createStoreHistory(project, setProject),
			editorState,
			setEditorState,
			totalDuration,
			zoomOutLimit,
			exportState,
			setExportState,
			micWaveforms,
			systemAudioWaveforms,
			previewQuality,
			setPreviewQuality,
			previewResolutionBase,
		};
	},
	// biome-ignore lint/style/noNonNullAssertion: it's ok
	null!,
);

export type { CanvasControls, FrameData } from "~/utils/socket";
export type { EditorPreviewQuality } from "~/utils/tauri";

function transformMeta({ pretty_name, ...rawMeta }: RecordingMeta) {
	if ("fps" in rawMeta) {
		throw new Error("Instant mode recordings cannot be edited");
	}

	let meta;

	if ("segments" in rawMeta) {
		meta = {
			...rawMeta,
			type: "multiple",
		} as unknown as MultipleSegments & { type: "multiple" };
	} else {
		meta = {
			...rawMeta,
			type: "single",
		} as unknown as SingleSegment & { type: "single" };
	}

	return {
		...rawMeta,
		...meta,
		prettyName: pretty_name,
		hasCamera: (() => {
			if (meta.type === "single") return !!meta.camera;
			return !!meta.segments[0].camera;
		})(),
		hasSystemAudio: (() => {
			if (meta.type === "single") return false;
			return !!meta.segments[0].system_audio;
		})(),
		hasMicrophone: (() => {
			if (meta.type === "single") return !!meta.audio;
			return !!meta.segments[0].mic;
		})(),
	};
}

export type TransformedMeta = ReturnType<typeof transformMeta>;

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
	createContextProvider(() => {
		const [latestFrame, setLatestFrame] = createLazySignal<FrameData>();

		const [_isConnected, setIsConnected] = createSignal(false);
		const [isWorkerReady, setIsWorkerReady] = createSignal(false);
		const [canvasControls, setCanvasControls] =
			createSignal<CanvasControls | null>(null);
		const [performanceMode, setPerformanceMode] = createSignal(false);

		let disposeWorkerReadyEffect: (() => void) | undefined;

		onCleanup(() => {
			disposeWorkerReadyEffect?.();
			cleanupCropVideoPreloader();
		});

		const [editorInstance, { refetch: refetchEditorInstance }] = createResource(
			async () => {
				console.log("[Editor] Creating editor instance...");

				let instance;
				let lastError;
				for (let attempt = 0; attempt < 5; attempt++) {
					try {
						instance = await commands.createEditorInstance();
						break;
					} catch (e) {
						lastError = e;
						console.warn(
							`[Editor] Attempt ${attempt + 1}/5 failed:`,
							e,
							"- retrying...",
						);
						await new Promise((resolve) =>
							setTimeout(resolve, 500 * (attempt + 1)),
						);
					}
				}

				if (!instance) {
					throw lastError;
				}

				console.log("[Editor] Editor instance created, setting up WebSocket");

				preloadCropVideoMetadata(
					`${instance.path}/content/segments/segment-0/display.mp4`,
				);

				const requestFrame = () => {
					events.renderFrameEvent.emit({
						frame_number: 0,
						fps: FPS,
						resolution_base: getPreviewResolution(DEFAULT_PREVIEW_QUALITY),
					});
				};

				const [ws, _wsConnected, workerReady, controls] = createImageDataWS(
					instance.framesSocketUrl,
					setLatestFrame,
					requestFrame,
				);

				setCanvasControls(controls);

				disposeWorkerReadyEffect = createRoot((dispose) => {
					createEffect(() => {
						setIsWorkerReady(workerReady());
					});
					return dispose;
				});

				ws.addEventListener("open", () => {
					setIsConnected(true);
					requestFrame();
				});

				ws.addEventListener("close", () => {
					setIsConnected(false);
				});

				return instance;
			},
		);

		const metaQuery = createQuery(() => ({
			queryKey: ["editor", "meta"],
			queryFn: editorInstance()
				? () => commands.getEditorMeta().then(transformMeta)
				: skipToken,
			cacheTime: 0,
			staleTime: 0,
		}));

		return {
			editorInstance,
			refetchEditorInstance,
			latestFrame,
			presets: createPresets(),
			metaQuery,
			isWorkerReady,
			canvasControls,
			performanceMode,
			setPerformanceMode,
		};
	}, null!);

function createStoreHistory<T extends Static>(
	...[state, setState]: ReturnType<typeof createStore<T>>
) {
	// not working properly yet
	// const getDelta = captureStoreUpdates(state);

	const [pauseCount, setPauseCount] = createSignal(0);

	const history = createUndoHistory(() => {
		if (pauseCount() > 0) return;

		trackStore(state);

		const copy = structuredClone(unwrap(state));

		return () => setState(reconcile(copy));
	});

	createEventListener(window, "keydown", (e) => {
		switch (e.code) {
			case "KeyZ": {
				if (!(e.ctrlKey || e.metaKey)) return;
				if (e.shiftKey) history.redo();
				else history.undo();
				break;
			}
			case "KeyY": {
				if (!(e.ctrlKey || e.metaKey)) return;
				history.redo();
				break;
			}
			default: {
				return;
			}
		}

		e.preventDefault();
		e.stopPropagation();
	});

	return Object.assign(history, {
		pause() {
			setPauseCount(pauseCount() + 1);

			return () => {
				setPauseCount(pauseCount() - 1);
			};
		},
		isPaused: () => pauseCount() > 0,
	});
}

type Static<T = unknown> =
	| {
			[K in number | string]: T;
	  }
	| T[];

export const [TimelineContextProvider, useTimelineContext] =
	createContextProvider(
		(props: {
			duration: number;
			secsPerPixel: number;
			timelineBounds: Readonly<NullableBounds>;
		}) => {
			return {
				duration: () => props.duration,
				secsPerPixel: () => props.secsPerPixel,
				timelineBounds: props.timelineBounds,
			};
		},
		null!,
	);

export const [TrackContextProvider, useTrackContext] = createContextProvider(
	(props: { ref: Accessor<Element | undefined> }) => {
		const { editorState } = useEditorContext();

		const [trackState, setTrackState] = createStore({
			draggingSegment: false,
		});
		const bounds = createElementBounds(() => props.ref());

		const secsPerPixel = () =>
			editorState.timeline.transform.zoom / (bounds.width ?? 1);

		return {
			secsPerPixel,
			trackBounds: bounds,
			trackState,
			setTrackState,
		};
	},
	null!,
);

export const [SegmentContextProvider, useSegmentContext] =
	createContextProvider((props: { width: Accessor<number> }) => {
		return props;
	}, null!);
