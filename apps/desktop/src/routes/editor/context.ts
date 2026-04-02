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
import { defaultKeyboardSettings } from "~/store/keyboard";

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
import type { MaskSegment } from "./masks";
import type { TextSegment } from "./text";
import {
	getUsedTrackCount,
	normalizeTrackSegments,
	sortTrackSegments,
} from "./timelineTracks";
import { createProgressBar } from "./utils";

export type ModalDialog =
	| { type: "createPreset" }
	| { type: "renamePreset"; presetIndex: number }
	| { type: "deletePreset"; presetIndex: number }
	| {
			type: "crop";
			position: XY<number>;
			size: XY<number>;
			previewUrl?: string | null;
	  };

export type LayoutMode = { type: "export" } | { type: "transcript" };

export type CurrentDialog = ModalDialog | LayoutMode;

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);
export type OpenLayoutMode = { open: true } & LayoutMode;
export type OpenModalDialog = { open: true } & ModalDialog;

const LAYOUT_MODE_TYPES: Set<CurrentDialog["type"]> = new Set([
	"export",
	"transcript",
]);

export function isLayoutMode(d: DialogState): d is OpenLayoutMode {
	return d.open && "type" in d && LAYOUT_MODE_TYPES.has(d.type);
}

export function isModalDialog(d: DialogState): d is OpenModalDialog {
	return d.open && "type" in d && !LAYOUT_MODE_TYPES.has(d.type);
}

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
	const width = (Math.max(4, Math.round(OUTPUT_SIZE.x * scale)) + 3) & ~3;
	const height = (Math.max(2, Math.round(OUTPUT_SIZE.y * scale)) + 1) & ~1;

	return { x: width, y: height };
};

export type TimelineTrackType =
	| "clip"
	| "caption"
	| "keyboard"
	| "text"
	| "zoom"
	| "scene"
	| "mask";

export const MAX_ZOOM_IN = 3;
const PROJECT_SAVE_DEBOUNCE_MS = 250;

export type RenderState =
	| { type: "starting" }
	| { type: "rendering"; progress: FramesRendered };

export type CustomDomainResponse = {
	custom_domain: string | null;
	domain_verified: boolean | null;
};

export type CornerRoundingType = "rounded-sm" | "squircle";

type WithCornerStyle<T> = T & { roundingType: CornerRoundingType };

type EditorTimelineConfiguration = Omit<
	TimelineConfiguration,
	"sceneSegments" | "maskSegments"
> & {
	sceneSegments?: SceneSegment[];
	maskSegments: MaskSegment[];
	textSegments: TextSegment[];
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
	const keyboard =
		config.keyboard && config.keyboard.settings.position === "above-captions"
			? {
					...config.keyboard,
					settings: {
						...config.keyboard.settings,
						position: "bottom-center",
					},
				}
			: config.keyboard;

	const timeline = config.timeline
		? {
				...config.timeline,
				sceneSegments: config.timeline.sceneSegments ?? [],
				captionSegments: config.timeline.captionSegments ?? [],
				keyboardSegments: config.timeline.keyboardSegments ?? [],
				maskSegments: normalizeTrackSegments(
					(
						config.timeline as TimelineConfiguration & {
							maskSegments?: MaskSegment[];
						}
					).maskSegments ?? [],
				),
				textSegments: normalizeTrackSegments(
					(
						config.timeline as TimelineConfiguration & {
							textSegments?: TextSegment[];
						}
					).textSegments ?? [],
				),
			}
		: undefined;

	return {
		...config,
		keyboard,
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
				captionSegments: project.timeline.captionSegments ?? [],
				keyboardSegments: project.timeline.keyboardSegments ?? [],
				maskSegments: project.timeline.maskSegments ?? [],
				textSegments: project.timeline.textSegments ?? [],
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
						sortTrackSegments(segments);
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
						sortTrackSegments(segments);
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
							normalizeTrackSegments(segments);
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
						sortTrackSegments(segments);
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
							normalizeTrackSegments(segments);
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
						if (time < 0.3 || remaining < 0.3) return;

						segments.splice(index + 1, 0, {
							...segment,
							id: `kb-split-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
							id: `cap-split-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

						for (const captionSegment of timeline.captionSegments ?? []) {
							captionSegment.start += diff(captionSegment.start);
							captionSegment.end += diff(captionSegment.end);
						}

						for (const keyboardSegment of timeline.keyboardSegments ?? []) {
							keyboardSegment.start += diff(keyboardSegment.start);
							keyboardSegment.end += diff(keyboardSegment.end);
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

		const initialMaskTrackCount = getUsedTrackCount(
			project.timeline?.maskSegments ?? [],
		);
		const initialTextTrackCount = getUsedTrackCount(
			project.timeline?.textSegments ?? [],
		);
		const initialCaptionTrackVisible =
			project.captions?.settings.enabled ??
			(project.timeline?.captionSegments?.length ?? 0) > 0;
		const initialKeyboardTrackVisible =
			project.keyboard?.settings.enabled ?? false;

		const [editorState, setEditorState] = createStore({
			previewTime: null as number | null,
			playbackTime: 0,
			playing: false,
			captions: {
				isGenerating: false,
				isDownloading: false,
				downloadProgress: 0,
				downloadingModel: null as string | null,
				isStale: false,
				staleDismissed: false,
			},
			timeline: {
				interactMode: "seek" as "seek" | "split",
				selection: null as
					| null
					| { type: "zoom"; indices: number[] }
					| { type: "clip"; indices: number[] }
					| { type: "scene"; indices: number[] }
					| { type: "mask"; indices: number[] }
					| { type: "caption"; indices: number[] }
					| { type: "keyboard"; indices: number[] }
					| { type: "text"; indices: number[] },
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
					caption: initialCaptionTrackVisible,
					keyboard: initialKeyboardTrackVisible,
					zoom: true,
					scene: true,
					mask: initialMaskTrackCount,
					text: initialTextTrackCount,
				},
				hoveredTrack: null as null | TimelineTrackType,
				hoveredMaskIndex: null as number | null,
				hoveredMaskTime: null as number | null,
			},
		});

		const [micWaveforms] = createResource(() => commands.getMicWaveforms());
		const [systemAudioWaveforms] = createResource(() =>
			commands.getSystemAudioWaveforms(),
		);
		const customDomain = createCustomDomainQuery();
		const hasRecordedKeyboardEvents = createMemo(() => {
			const meta = props.meta();
			if (meta.type === "single") return false;
			return meta.segments.some((segment) => !!segment.keyboard);
		});
		const [didInitializeKeyboardSegments, setDidInitializeKeyboardSegments] =
			createSignal(false);

		createEffect(() => {
			if (didInitializeKeyboardSegments()) return;
			if (!project.timeline) return;
			if (!hasRecordedKeyboardEvents()) {
				setDidInitializeKeyboardSegments(true);
				return;
			}
			if ((project.timeline?.keyboardSegments?.length ?? 0) > 0) {
				setDidInitializeKeyboardSegments(true);
				return;
			}

			setDidInitializeKeyboardSegments(true);

			void (async () => {
				try {
					const segments = await commands.generateKeyboardSegments(
						defaultKeyboardSettings.groupingThresholdMs,
						defaultKeyboardSettings.lingerDuration * 1000,
						defaultKeyboardSettings.showModifiers,
						defaultKeyboardSettings.showSpecialKeys,
					);

					if (segments.length < 1) return;

					batch(() => {
						if (!project.keyboard) {
							setProject("keyboard", {
								settings: defaultKeyboardSettings,
							});
						}
						setProject("timeline", "keyboardSegments", segments);
					});
				} catch (error) {
					console.error("Failed to initialize keyboard segments", error);
				}
			})();
		});

		createEffect(
			on(
				() => {
					const segs = project.timeline?.segments;
					if (!segs || segs.length === 0) return "";
					return segs
						.map(
							(s) =>
								`${s.start}|${s.end}|${s.timescale}|${s.recordingSegment ?? 0}`,
						)
						.join(",");
				},
				(current, prev) => {
					if (prev === undefined || prev === "") return;
					if (current === prev) return;

					const hasCaptions =
						(project.timeline?.captionSegments?.length ?? 0) > 0 ||
						(project.captions?.segments?.length ?? 0) > 0;

					if (hasCaptions) {
						batch(() => {
							setEditorState("captions", "isStale", true);
							setEditorState("captions", "staleDismissed", false);
						});
					}
				},
				{ defer: true },
			),
		);

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

	let meta:
		| (MultipleSegments & { type: "multiple" })
		| (SingleSegment & { type: "single" });

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
		hasRecordedCursorData: (() => {
			if (meta.type === "single") return !!meta.cursor;
			return meta.segments.some((s) => !!s.cursor);
		})(),
	};
}

export type TransformedMeta = ReturnType<typeof transformMeta>;

const createEditorInstanceContext = () => {
	const [latestFrame, setLatestFrame] = createLazySignal<FrameData>();

	const [_isConnected, setIsConnected] = createSignal(false);
	const [isWorkerReady, setIsWorkerReady] = createSignal(false);
	const [canvasControls, setCanvasControls] =
		createSignal<CanvasControls | null>(null);
	const [performanceMode, setPerformanceMode] = createSignal(false);

	let disposeWorkerReadyEffect: (() => void) | undefined;

	onCleanup(() => {
		disposeWorkerReadyEffect?.();
		canvasControls()?.dispose();
	});

	const [editorInstance, { refetch: refetchEditorInstance }] = createResource(
		async () => {
			console.log("[Editor] Creating editor instance...");

			let instance: SerializedEditorInstance | undefined;
			let lastError: unknown;
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					instance = await commands.createEditorInstance();
					break;
				} catch (e) {
					lastError = e;
					const errorMessage = e instanceof Error ? e.message : String(e);
					if (/may need to be recovered/i.test(errorMessage)) {
						break;
					}
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
		queryFn: editorInstance.latest
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
};

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
	createContextProvider(
		createEditorInstanceContext,
		null as unknown as ReturnType<typeof createEditorInstanceContext>,
	);

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

type TimelineContextValue = {
	duration: Accessor<number>;
	secsPerPixel: Accessor<number>;
	timelineBounds: Readonly<NullableBounds>;
};

type TrackContextValue = {
	secsPerPixel: Accessor<number>;
	trackBounds: Readonly<NullableBounds>;
	trackState: {
		draggingSegment: boolean;
	};
	setTrackState: ReturnType<
		typeof createStore<{ draggingSegment: boolean }>
	>[1];
};

type SegmentContextValue = {
	width: Accessor<number>;
};

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
		null as unknown as TimelineContextValue,
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
	null as unknown as TrackContextValue,
);

export const [SegmentContextProvider, useSegmentContext] =
	createContextProvider(
		(props: { width: Accessor<number> }) => {
			return props;
		},
		null as unknown as SegmentContextValue,
	);
