import {
	createElementBounds,
	type NullableBounds,
} from "@solid-primitives/bounds";
import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { createUndoHistory } from "@solid-primitives/history";
import { debounce } from "@solid-primitives/scheduled";
import { createQuery, skipToken } from "@tanstack/solid-query";
import {
	type Accessor,
	batch,
	createEffect,
	createResource,
	createSignal,
	on,
} from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";

import { createPresets } from "~/utils/createPresets";
import { createCustomDomainQuery } from "~/utils/queries";
import { createImageDataWS, createLazySignal } from "~/utils/socket";
import {
	commands,
	events,
	type FramesRendered,
	type MultipleSegments,
	type ProjectConfiguration,
	type RecordingMeta,
	type SerializedEditorInstance,
	type SingleSegment,
	type XY,
} from "~/utils/tauri";
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

export const MAX_ZOOM_IN = 3;

export type RenderState =
	| { type: "starting" }
	| { type: "rendering"; progress: FramesRendered };

export type CustomDomainResponse = {
	custom_domain: string | null;
	domain_verified: boolean | null;
};

export const [EditorContextProvider, useEditorContext] = createContextProvider(
	(props: {
		meta: () => TransformedMeta;
		editorInstance: SerializedEditorInstance;
		refetchMeta(): Promise<void>;
	}) => {
		const editorInstanceContext = useEditorInstanceContext();
		const [project, setProject] = createStore<ProjectConfiguration>(
			props.editorInstance.savedProjectConfig,
		);

		const projectActions = {
			splitClipSegment: (time: number) => {
				setProject(
					"timeline",
					"segments",
					produce((segments) => {
						let searchTime = time;
						let prevDuration = 0;
						const currentSegmentIndex = segments.findIndex((segment) => {
							const duration = segment.end - segment.start;
							if (searchTime > duration) {
								searchTime -= duration;
								prevDuration += duration;
								return false;
							}

							return true;
						});

						if (currentSegmentIndex === -1) return;
						const segment = segments[currentSegmentIndex];

						segments.splice(currentSegmentIndex + 1, 0, {
							start: segment.start + searchTime,
							end: segment.end,
							timescale: 1,
							recordingSegment: segment.recordingSegment,
						});
						segments[currentSegmentIndex].end = segment.start + searchTime;
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
			duplicateSceneSegment: (segmentIndex: number) => {
				if (!project.timeline?.sceneSegments?.[segmentIndex]) return;
				const segment = project.timeline.sceneSegments[segmentIndex];
				const segmentDuration = segment.end - segment.start;
				const newSegmentStart = segment.end;
				const newSegmentEnd = newSegmentStart + segmentDuration;
				
				// Check if there's enough space in the timeline
				const timelineDuration = totalDuration();
				if (newSegmentEnd > timelineDuration) {
					// Not enough space for the duplicate
					return;
				}
				
				// Check if the new segment would overlap with any existing scene segments
				const wouldOverlap = project.timeline.sceneSegments.some((s, i) => {
					if (i === segmentIndex) return false; // Skip the original segment
					return (newSegmentStart < s.end && newSegmentEnd > s.start);
				});
				
				if (wouldOverlap) {
					// Would overlap with another segment
					return;
				}
				
				batch(() => {
					setProject(
						"timeline",
						"sceneSegments",
						produce((s) => {
							if (!s) return;
							// Insert duplicate right after the original
							s.splice(segmentIndex + 1, 0, {
								...segment,
								start: newSegmentStart,
								end: newSegmentEnd,
								// Deep clone split view settings if present
								splitViewSettings: segment.splitViewSettings 
									? { ...segment.splitViewSettings }
									: undefined,
							});
						}),
					);
					// Select and click on the newly duplicated segment
					setEditorState("timeline", "selection", {
						type: "scene",
						index: segmentIndex + 1,
					});
					// Move playhead to the start of the new segment
					setEditorState("playbackTime", newSegmentStart);
					// Center the timeline view on the new segment
					const currentZoom = editorState.timeline.transform.zoom;
					const targetPosition = Math.max(0, newSegmentStart - currentZoom / 2);
					editorState.timeline.transform.setPosition(targetPosition);
				});
			},
			copySceneSettingsFromOriginal: (segmentIndex: number) => {
				if (!project.timeline?.sceneSegments?.[segmentIndex]) return;
				
				// Find the first segment with the same mode
				const currentSegment = project.timeline.sceneSegments[segmentIndex];
				const originalSegment = project.timeline.sceneSegments.find(
					(s, i) => i !== segmentIndex && s.mode === currentSegment.mode
				);
				
				if (!originalSegment) return;
				
				setProject(
					"timeline",
					"sceneSegments",
					segmentIndex,
					produce((s) => {
						if (!s) return;
						// Copy settings based on mode
						if (s.mode === "splitView" && originalSegment.splitViewSettings) {
							s.splitViewSettings = { ...originalSegment.splitViewSettings };
						}
						// Can add more mode-specific settings copying here in the future
					}),
				);
			},
		};

		createEffect(
			on(
				() => {
					trackStore(project);
				},
				debounce(() => {
					commands.setProjectConfig(project);
				}),
				{ defer: true },
			),
		);

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

		const [editorState, setEditorState] = createStore({
			previewTime: null as number | null,
			playbackTime: 0,
			playing: false,
			timeline: {
				interactMode: "seek" as "seek" | "split",
				selection: null as
					| null
					| { type: "zoom"; indices: number[] }
					| { type: "clip"; index: number }
					| { type: "scene"; index: number },
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
		};
	},
	// biome-ignore lint/style/noNonNullAssertion: it's ok
	null!,
);

export type FrameData = { width: number; height: number; data: ImageData };

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
		const [latestFrame, setLatestFrame] = createLazySignal<{
			width: number;
			data: ImageData;
		}>();

		const [editorInstance] = createResource(async () => {
			const instance = await commands.createEditorInstance();

			const [_ws, isConnected] = createImageDataWS(
				instance.framesSocketUrl,
				setLatestFrame,
			);

			createEffect(() => {
				if (isConnected()) {
					events.renderFrameEvent.emit({
						frame_number: Math.floor(0),
						fps: FPS,
						resolution_base: OUTPUT_SIZE,
					});
				}
			});

			return instance;
		});

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
			latestFrame,
			presets: createPresets(),
			metaQuery,
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
