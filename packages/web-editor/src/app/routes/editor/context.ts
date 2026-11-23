import {
	createElementBounds,
	type NullableBounds,
} from "@solid-primitives/bounds";
import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { createQuery, skipToken } from "@tanstack/solid-query";
import {
	type Accessor,
	batch,
	createContext,
	createEffect,
	createMemo,
	createResource,
	createRoot,
	createSignal,
	on,
	onCleanup,
	onMount,
	untrack,
	useContext,
} from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import toast from "solid-toast";
import { generalSettingsStore } from "~/store";
import {
	type EditorCaptionSettings,
	normalizeCaptionSettings,
} from "~/store/captions";
import { createEditorEventListener } from "~/utils/createEventListener";
import { createPresets } from "~/utils/createPresets";
import {
	type CanvasControls,
	createLazySignal,
	createPreviewConnection,
	type FrameData,
} from "../../../engine/browser-frame-socket";
import { commands, events } from "../../../engine/editor-api";
import { savedEditorProjectAfterFreeEdit } from "../../../engine/editor-caption-access";
import type {
	ClipSpeedAudioMode,
	ColorCorrectionConfiguration,
	EditorPreviewQuality,
	FrameLayoutEvent,
	FramesRendered,
	ImportedAudioTrack,
	MultipleSegments,
	ProjectConfiguration,
	RecordingMeta,
	SceneSegment,
	SerializedEditorInstance,
	SingleSegment,
	TimelineConfiguration,
	TimelineSegment,
	XY,
} from "../../../engine/types";
import {
	type AudioTrackSegment,
	createAudioTrackSegment,
	MIN_AUDIO_SEGMENT_DURATION,
} from "./audio";
import { deriveCaptionTrackSegments, mapEditedTimeToSource } from "./captions";
import {
	type ClipMergeDirection,
	clipMergeBlocker,
	clipMergeKeptIndex,
	mergedClipSegment,
	transitionsAfterClipMerge,
} from "./clip-merge";
import {
	type ClipTransition,
	type ClipTransitionInput,
	clampTransitionDuration,
	clipDuration,
	clipTimelineDuration,
	clipTimelineOffsets,
	getClipTransition,
	normalizeClipTransitions,
	rippleTimelineTrack,
	timelineShiftAfterClipDurationChange,
	transitionsAfterClipSplit,
} from "./clip-transitions";
import { normalizeColorCorrection } from "./colorCorrection";
import { defaultImageSegment, type ImageSegment, pickImage } from "./images";
import {
	mapKeyboardTrackTimes,
	rippleKeyboardTrack,
	splitKeyboardSegment,
} from "./keyboard-timing";
import type { MaskSegment } from "./masks";
import { createProjectConfigSave } from "./project-config-save";
import { createStoreHistory, withEditorTimeline } from "./project-history";
import type { SnapGuide } from "./snapping";
import {
	activeStyleSegments,
	applyStyleSegments,
	defaultStyleSegment,
	type StyleGroup,
	type StyleSegment,
	splitOverlaySegment,
} from "./style";
import type { TextSegment } from "./text";
import {
	applyMotionTemplate,
	applySceneToRange,
	autoCamera3DScene,
	CAMERA3D_SCENES,
	type Camera3DMotionTemplate,
	type Camera3DSegment,
	camera3DPoseSeekTime,
	DEFAULT_CAMERA3D_SHOT_DURATION,
	defaultCamera3DTracks,
	evaluatePose,
	getEndPose,
	getMotionEasing,
	getStartPose,
	newCamera3DShot,
	normalizeCamera3DSegments,
	placeCamera3DShot,
	scaleKeyframeTimes,
	setMotion,
} from "./three-d";
import {
	effectiveToOutput,
	heldTimeBefore,
	holdWindows,
	totalHeldDuration,
} from "./timeline-holds";
import { deleteClipAndRippleAllTracks } from "./timeline-utils";
import {
	getUsedTrackCount,
	normalizeTrackSegments,
	placeSegmentAtTime,
	sortTrackSegments,
} from "./timelineTracks";
import { defaultWaveformSegment, waveformGapAt } from "./waveform";

export type ModalDialog =
	| { type: "createPreset" }
	| { type: "renamePreset"; presetIndex: number }
	| { type: "deletePreset"; presetIndex: number }
	| {
			type: "crop";
			styleTarget?: number | null;
			scopeToken?: object;
			position: XY<number>;
			size: XY<number>;
	  };

export type LayoutMode =
	| { type: "export"; destination?: "link" }
	| { type: "transcript" }
	| { type: "clips" };

export type CurrentDialog = ModalDialog | LayoutMode;

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);
export type OpenLayoutMode = { open: true } & LayoutMode;
export type OpenModalDialog = { open: true } & ModalDialog;

const LAYOUT_MODE_TYPES: Set<CurrentDialog["type"]> = new Set([
	"export",
	"transcript",
	"clips",
]);

const PERSISTED_LAYOUT_MODE_TYPES: Set<CurrentDialog["type"]> = new Set([
	"export",
	"clips",
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
	| "style"
	| "image"
	| "waveform"
	| "clip"
	| "caption"
	| "keyboard"
	| "text"
	| "zoom"
	| "scene"
	| "mask"
	| "audio"
	| "3d";

export const MAX_ZOOM_IN = 3;

export type RenderState =
	| { type: "starting" }
	| { type: "rendering"; progress: FramesRendered };

export type CustomDomainResponse = {
	custom_domain: string | null;
	domain_verified: boolean | null;
};

export type CornerRoundingType = "rounded" | "squircle";

type WithCornerStyle<T> = T & { roundingType: CornerRoundingType };

export type EditorTimelineSegment = TimelineSegment & {
	name?: string | null;
};

type EditorTimelineConfiguration = Omit<
	TimelineConfiguration,
	| "sceneSegments"
	| "maskSegments"
	| "segments"
	| "audioSegments"
	| "transitions"
	| "camera3dSegments"
> & {
	segments: EditorTimelineSegment[];
	transitions: ClipTransition[];
	sceneSegments?: SceneSegment[];
	maskSegments: MaskSegment[];
	textSegments: TextSegment[];
	styleSegments: StyleSegment[];
	imageSegments: ImageSegment[];
	audioSegments?: AudioTrackSegment[];
	camera3dSegments: Camera3DSegment[];
};

type EditorCaptionsData = NonNullable<ProjectConfiguration["captions"]> & {
	settings: EditorCaptionSettings;
};

export type EditorProjectConfiguration = Omit<
	ProjectConfiguration,
	"background" | "camera" | "timeline" | "captions"
> & {
	background: WithCornerStyle<ProjectConfiguration["background"]>;
	camera: WithCornerStyle<ProjectConfiguration["camera"]>;
	timeline?: EditorTimelineConfiguration | null;
	captions: EditorCaptionsData | null;
	hiddenTextSegments?: number[];
	colorCorrection: ColorCorrectionConfiguration;
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
				styleSegments: normalizeTrackSegments(
					config.timeline.styleSegments ?? [],
				),
				imageSegments: (config.overlayOrder?.length
					? sortTrackSegments
					: normalizeTrackSegments)(config.timeline.imageSegments ?? []),
				waveformSegments: (config.overlayOrder?.length
					? sortTrackSegments
					: normalizeTrackSegments)(config.timeline.waveformSegments ?? []),
				transitions:
					(
						config.timeline as TimelineConfiguration & {
							transitions?: ClipTransition[];
						}
					).transitions ?? [],
				sceneSegments: config.timeline.sceneSegments ?? [],
				captionSegments: config.timeline.captionSegments ?? [],
				keyboardSegments: config.timeline.keyboardSegments ?? [],
				maskSegments: (config.overlayOrder?.length
					? sortTrackSegments
					: normalizeTrackSegments)(
					(
						config.timeline as TimelineConfiguration & {
							maskSegments?: MaskSegment[];
						}
					).maskSegments ?? [],
				),
				textSegments: (config.overlayOrder?.length
					? sortTrackSegments
					: normalizeTrackSegments)(
					(
						config.timeline as TimelineConfiguration & {
							textSegments?: TextSegment[];
						}
					).textSegments ?? [],
				),
				audioSegments: normalizeTrackSegments(
					(
						config.timeline as TimelineConfiguration & {
							audioSegments?: AudioTrackSegment[];
						}
					).audioSegments ?? [],
				),
				camera3dSegments: normalizeCamera3DSegments(
					config.timeline.camera3dSegments,
				),
			}
		: undefined;
	const captions = config.captions
		? {
				...config.captions,
				settings: normalizeCaptionSettings(config.captions.settings),
			}
		: null;

	return {
		...config,
		keyboard,
		timeline,
		captions,
		background: withCornerDefaults(config.background),
		camera: withCornerDefaults(config.camera),
		colorCorrection: normalizeColorCorrection(config.colorCorrection),
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
				transitions: project.timeline.transitions ?? [],
				styleSegments: project.timeline.styleSegments ?? [],
				imageSegments: project.timeline.imageSegments ?? [],
				waveformSegments: project.timeline.waveformSegments ?? [],
				captionSegments: project.timeline.captionSegments ?? [],
				keyboardSegments: project.timeline.keyboardSegments ?? [],
				maskSegments: project.timeline.maskSegments ?? [],
				textSegments: project.timeline.textSegments ?? [],
				audioSegments: project.timeline.audioSegments ?? [],
				camera3dSegments: project.timeline.camera3dSegments ?? [],
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

export const [EditorContextProvider, useBaseEditorContext] =
	createContextProvider(
		(props: {
			meta: () => TransformedMeta;
			editorInstance: SerializedEditorInstance;
			refetchMeta(): Promise<void>;
		}) => {
			const editorInstanceContext = useEditorInstanceContext();
			const [project, setProject] = createStore<EditorProjectConfiguration>(
				withEditorTimeline(
					normalizeProject(props.editorInstance.savedProjectConfig),
					props.editorInstance.recordingDuration,
				),
			);

			const setClipTransition = (
				segmentIndex: number,
				transition: ClipTransitionInput | null,
			) => {
				setProject(
					produce((project) => {
						const timeline = project.timeline;
						if (!timeline || segmentIndex <= 0) return;
						const segment = timeline.segments[segmentIndex];
						const previous = timeline.segments[segmentIndex - 1];
						if (!segment || !previous) return;
						const transitions = timeline.transitions ?? [];

						const oldDuration =
							getClipTransition(timeline.segments, transitions, segmentIndex)
								?.duration ?? 0;
						const duration = transition
							? clampTransitionDuration(transition.duration, previous, segment)
							: 0;
						const boundary = effectiveToOutput(
							holdWindows(timeline.textSegments),
							clipTimelineOffsets(timeline.segments, transitions)[
								segmentIndex
							] + oldDuration,
						);
						const shift = oldDuration - duration;

						timeline.transitions = transitions.filter(
							(value) => value.segmentIndex !== segmentIndex,
						);
						if (transition && duration > 0) {
							timeline.transitions.push({
								...transition,
								segmentIndex,
								duration,
							});
							timeline.transitions.sort(
								(a, b) => a.segmentIndex - b.segmentIndex,
							);
						}

						if (shift === 0) return;
						const camera3dSegments = timeline.camera3dSegments ?? [];
						const previousCamera3dDurations = camera3dSegments.map(
							(segment) => segment.end - segment.start,
						);
						const tracks = [
							timeline.styleSegments,
							timeline.imageSegments,
							timeline.waveformSegments ?? [],
							timeline.zoomSegments,
							timeline.sceneSegments ?? [],
							timeline.maskSegments,
							timeline.textSegments,
							timeline.captionSegments ?? [],
							timeline.audioSegments ?? [],
							camera3dSegments,
						];
						for (const track of tracks) {
							rippleTimelineTrack(track, boundary, shift);
						}
						rippleKeyboardTrack(
							timeline.keyboardSegments ?? [],
							boundary,
							shift,
						);
						for (let index = 0; index < camera3dSegments.length; index++) {
							const camera3dSegment = camera3dSegments[index];
							const previousDuration = previousCamera3dDurations[index];
							// Keyframe times are relative to the segment start, so a
							// segment the ripple resized (the straddling case) has to
							// have them rescaled onto its new length.
							const nextDuration = camera3dSegment.end - camera3dSegment.start;
							if (previousDuration <= 0 || nextDuration === previousDuration)
								continue;
							scaleKeyframeTimes(
								camera3dSegment.tracks,
								nextDuration / previousDuration,
							);
						}
					}),
				);
			};

			const camera3DClipCuts = (start: number, end: number) => {
				const timeline = project.timeline;
				if (!timeline) return [];
				const offsets = clipTimelineOffsets(
					timeline.segments,
					timeline.transitions ?? [],
				);
				const cuts: number[] = [];
				for (let index = 0; index < timeline.segments.length; index++) {
					const boundaries = [
						offsets[index],
						offsets[index] + clipDuration(timeline.segments[index]),
					];
					for (const boundary of boundaries)
						if (boundary > start && boundary < end) cuts.push(boundary);
				}
				return cuts;
			};

			const camera3DAutoSceneSegments = (count: number) => {
				const total = totalDuration();
				if (!(total > 0)) return [];
				return applySceneToRange(
					autoCamera3DScene(count),
					0,
					total,
					camera3DClipCuts(0, total),
				);
			};

			const camera3DAutoScenePreview = (count: number) =>
				camera3DAutoSceneSegments(count).map((segment) => ({
					start: segment.start,
					end: segment.end,
				}));

			// Parking the playhead on a pose is how the canvas shows it, and the
			// renderer floors the seek onto a frame, so every seek goes through the
			// frame-accurate time rather than the raw boundary.
			const seekCamera3DPose = (
				segment: { start: number; end: number },
				end = false,
			) => {
				setEditorState("playbackTime", camera3DPoseSeekTime(segment, end, FPS));
				setEditorState("previewTime", null);
			};

			const insertCamera3DShots = (shots: Camera3DSegment[]) => {
				if (shots.length === 0) return;
				const start = shots[0].start;
				const index = (project.timeline?.camera3dSegments ?? []).filter(
					(segment) => segment.start < start,
				).length;
				batch(() => {
					setProject("timeline", "camera3dSegments", (segments) =>
						[...(segments ?? []), ...shots].sort((a, b) => a.start - b.start),
					);
					setEditorState("timeline", "tracks", "3d", true);
					setEditorState("timeline", "camera3dPose", "start");
					setEditorState("timeline", "selection", {
						type: "3d",
						indices: [index],
					});
					seekCamera3DPose(shots[0]);
				});
			};

			const overlaySegments = (type: "style" | "image" | "waveform") =>
				(type === "style"
					? project.timeline?.styleSegments
					: type === "image"
						? project.timeline?.imageSegments
						: project.timeline?.waveformSegments) ?? [];
			const overlayPlacement = (
				type: "style" | "image",
				lane: number,
				time: number,
			) => {
				const segments = overlaySegments(type);
				const length = Math.min(3, totalDuration());
				if (length <= 0) return null;
				const requested = placeSegmentAtTime(
					segments.filter((segment) => segment.track === lane),
					time,
					length,
					totalDuration(),
				);
				if (requested) return { ...requested, lane };
				const placement = placeSegmentAtTime([], time, length, totalDuration());
				return placement
					? {
							...placement,
							lane: Math.max(
								getUsedTrackCount<{
									start: number;
									end: number;
									track?: number;
								}>(segments),
								lane + 1,
							),
						}
					: null;
			};
			const selectAddedOverlay = (
				type: "style" | "image" | "waveform",
				lane: number,
				start: number,
			) => {
				const segments = overlaySegments(type);
				const index = segments.findIndex(
					(segment) => segment.track === lane && segment.start === start,
				);
				batch(() => {
					setEditorState(
						"timeline",
						"tracks",
						type,
						Math.max(editorState.timeline.tracks[type], lane + 1),
					);
					setEditorState("timeline", "selection", { type, indices: [index] });
					if (type === "style") enterStyleScope(index);
					setEditorState("playbackTime", start);
					setEditorState("previewTime", null);
				});
			};
			const [camera3DShotStop, setCamera3DShotStop] = createSignal<{
				end: number;
			} | null>(null);

			const projectActions = {
				setClipTransition,
				normalizeClipTransitions: () => {
					setProject(
						produce((project) => {
							const timeline = project.timeline;
							if (!timeline) return;
							const normalized = normalizeClipTransitions(
								timeline.segments,
								timeline.transitions ?? [],
							);
							if (
								normalized.length === timeline.transitions.length &&
								normalized.every((transition, index) => {
									const current = timeline.transitions[index];
									return (
										current?.segmentIndex === transition.segmentIndex &&
										current.type === transition.type &&
										current.duration === transition.duration
									);
								})
							)
								return;
							timeline.transitions = normalized;
						}),
					);
				},
				deleteClipTransition: (segmentIndex: number) => {
					setClipTransition(segmentIndex, null);
					setEditorState("timeline", "selection", null);
				},
				splitClipSegment: (time: number, requestedSegmentIndex?: number) => {
					let didSplit = false;
					setProject(
						produce((project) => {
							const timeline = project.timeline;
							if (!timeline) return;
							const segments = timeline.segments;
							time -= heldTimeBefore(holdWindows(timeline.textSegments), time);
							const offsets = clipTimelineOffsets(
								segments,
								timeline.transitions ?? [],
							);
							let currentSegmentIndex = requestedSegmentIndex ?? -1;
							if (currentSegmentIndex < 0) {
								for (let index = 0; index < segments.length; index++) {
									const duration =
										(segments[index].end - segments[index].start) /
										segments[index].timescale;
									if (
										time >= offsets[index] &&
										time <= offsets[index] + duration
									) {
										currentSegmentIndex = index;
									}
								}
							}

							if (currentSegmentIndex === -1) return;
							const segment = segments[currentSegmentIndex];
							const localTime = time - offsets[currentSegmentIndex];
							const duration =
								(segment.end - segment.start) / segment.timescale;
							if (localTime <= 0 || localTime >= duration) return;
							const incomingDuration =
								getClipTransition(
									segments,
									timeline.transitions ?? [],
									currentSegmentIndex,
								)?.duration ?? 0;
							const outgoingDuration =
								getClipTransition(
									segments,
									timeline.transitions ?? [],
									currentSegmentIndex + 1,
								)?.duration ?? 0;
							if (
								localTime < incomingDuration * 2 ||
								duration - localTime < outgoingDuration * 2
							)
								return;
							const splitPositionInRecording = localTime * segment.timescale;

							segments.splice(currentSegmentIndex + 1, 0, {
								...segment,
								start: segment.start + splitPositionInRecording,
								end: segment.end,
							});
							segments[currentSegmentIndex].end =
								segment.start + splitPositionInRecording;
							timeline.transitions = transitionsAfterClipSplit(
								timeline.transitions ?? [],
								currentSegmentIndex,
							);
							didSplit = true;
						}),
					);
					if (didSplit) setEditorState("timeline", "selection", null);
				},
				deleteClipSegment: (segmentIndex: number) => {
					if (!project.timeline) return;
					if (project.timeline.segments.length < 2) return;

					batch(() => {
						setProject(
							produce((project) => {
								const timeline = project.timeline;
								if (!timeline) return;
								deleteClipAndRippleAllTracks(timeline, segmentIndex);
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
				splitCamera3DSegment: (index: number, time: number) => {
					setProject(
						"timeline",
						"camera3dSegments",
						produce((segments) => {
							const segment = segments?.[index];
							if (!segment) return;

							const duration = segment.end - segment.start;
							const remaining = duration - time;
							if (time < 1 || remaining < 1) return;

							// A split must not change what plays: both halves meet on the pose
							// the segment held at the cut, so the left half moves start -> mid
							// and the right half picks up mid -> end. Blur is segment-level, so
							// it is simply carried onto both halves.
							const startPose = getStartPose(segment);
							const midPose = evaluatePose(segment, time);
							const endPose = getEndPose(segment);
							const easing = getMotionEasing(segment);

							const right: Camera3DSegment = {
								...segment,
								start: segment.start + time,
								end: segment.end,
								properties: { ...segment.properties },
								blur: { ...segment.blur },
								tracks: defaultCamera3DTracks(),
							};
							setMotion(right, midPose, endPose, easing);
							segments.splice(index + 1, 0, right);

							const left = segments[index];
							left.end = segment.start + time;
							left.tracks = defaultCamera3DTracks();
							setMotion(left, startPose, midPose, easing);
							sortTrackSegments(segments);
						}),
					);
				},
				deleteCamera3DSegments: (segmentIndices: number[]) => {
					batch(() => {
						setProject(
							"timeline",
							"camera3dSegments",
							produce((segments) => {
								if (!segments) return;
								const sorted = [...new Set(segmentIndices)]
									.filter(
										(i) => Number.isInteger(i) && i >= 0 && i < segments.length,
									)
									.sort((a, b) => b - a);
								if (sorted.length === 0) return;
								for (const i of sorted) segments.splice(i, 1);
							}),
						);
						setEditorState("timeline", "selection", null);
					});
				},
				applyCamera3DScene: (segmentIndex: number, sceneId: string) => {
					const scene = CAMERA3D_SCENES.find((s) => s.id === sceneId);
					const segment = project.timeline?.camera3dSegments?.[segmentIndex];
					if (!scene || !segment) return;

					const { start, end } = segment;
					const generated = applySceneToRange(
						scene,
						start,
						end,
						camera3DClipCuts(start, end),
					);
					if (generated.length === 0) return;

					batch(() => {
						setProject(
							"timeline",
							"camera3dSegments",
							produce((segments) => {
								if (!segments) return;
								segments.splice(segmentIndex, 1, ...generated);
								sortTrackSegments(segments);
							}),
						);
						setEditorState("timeline", "selection", {
							type: "3d",
							indices: [segmentIndex],
						});
						setEditorState("timeline", "camera3dPose", "start");
						seekCamera3DPose(generated[0]);
					});
				},
				applyCamera3DLook: (
					segmentIndex: number,
					look: Camera3DMotionTemplate,
				) => {
					const segment = project.timeline?.camera3dSegments?.[segmentIndex];
					if (!segment) return;
					const range = { start: segment.start, end: segment.end };
					batch(() => {
						setProject(
							"timeline",
							"camera3dSegments",
							produce((segments) => {
								const target = segments?.[segmentIndex];
								if (!target) return;
								applyMotionTemplate(target, look);
							}),
						);
						setEditorState("timeline", "camera3dPose", "start");
						seekCamera3DPose(range);
					});
				},
				selectCamera3DPose: (segmentIndex: number, end: boolean) => {
					const segment = project.timeline?.camera3dSegments?.[segmentIndex];
					if (!segment) return;
					const range = { start: segment.start, end: segment.end };
					batch(() => {
						const selection = editorState.timeline.selection;
						if (
							selection?.type !== "3d" ||
							selection.indices.length !== 1 ||
							selection.indices[0] !== segmentIndex
						)
							setEditorState("timeline", "selection", {
								type: "3d",
								indices: [segmentIndex],
							});
						setEditorState("timeline", "camera3dPose", end ? "end" : "start");
						seekCamera3DPose(range, end);
					});
				},
				addCamera3DShot: (
					time = editorState.playbackTime,
					duration = DEFAULT_CAMERA3D_SHOT_DURATION,
				) => {
					const placement = placeCamera3DShot(
						project.timeline?.camera3dSegments ?? [],
						time,
						duration,
						totalDuration(),
					);
					if (!placement) {
						toast.error("No room for another 3D shot");
						return;
					}
					insertCamera3DShots([
						newCamera3DShot(placement.start, placement.end),
					]);
				},
				addCamera3DShotRange: (start: number, end: number) => {
					if (!(end > start)) return;
					insertCamera3DShots([newCamera3DShot(start, end)]);
				},
				applyCamera3DAutoScene: (count: number) => {
					const generated = camera3DAutoSceneSegments(count);
					if (generated.length === 0) {
						toast.error("This recording is too short for a 3D scene");
						return;
					}
					batch(() => {
						setProject("timeline", "camera3dSegments", generated);
						setEditorState("timeline", "tracks", "3d", true);
						setEditorState("timeline", "camera3dAutoPreview", null);
						setEditorState("timeline", "camera3dPose", "start");
						setEditorState("timeline", "selection", {
							type: "3d",
							indices: [0],
						});
						seekCamera3DPose(generated[0]);
					});
				},
				playCamera3DShot: async (segmentIndex: number) => {
					const segment = project.timeline?.camera3dSegments?.[segmentIndex];
					if (!segment) return;
					const start = camera3DPoseSeekTime(segment, false, FPS);
					// The stop is driven off the playhead rather than a timer, so a
					// slow decoder still pauses on the shot's last frame.
					setCamera3DShotStop({ end: segment.end });
					try {
						await commands.stopPlayback();
						setEditorState("playbackTime", start);
						setEditorState("previewTime", null);
						await commands.seekTo(Math.floor(start * FPS));
						await commands.startPlayback(FPS, previewResolutionBase());
						setEditorState("playing", true);
					} catch (error) {
						console.error("Failed to play 3D shot:", error);
						setCamera3DShotStop(null);
						setEditorState("playing", false);
					}
				},
				splitOverlaySegment: (
					type: "style" | "image" | "waveform",
					index: number,
					time: number,
				) => {
					setProject(
						produce((value) => {
							const timeline = value.timeline;
							if (!timeline) return;
							if (type === "waveform") {
								const segment = timeline.waveformSegments?.[index];
								const parts =
									segment &&
									splitOverlaySegment(structuredClone(unwrap(segment)), time);
								if (parts)
									timeline.waveformSegments?.splice(index, 1, ...parts);
							} else if (type === "style") {
								const parts = splitOverlaySegment(
									structuredClone(unwrap(timeline.styleSegments[index])),
									time,
								);
								if (parts) timeline.styleSegments.splice(index, 1, ...parts);
							} else if (timeline.imageSegments[index]) {
								const parts = splitOverlaySegment(
									structuredClone(unwrap(timeline.imageSegments[index])),
									time,
								);
								if (parts) timeline.imageSegments.splice(index, 1, ...parts);
							}
						}),
					);
					setEditorState("timeline", "selection", { type, indices: [index] });
					if (type === "style") enterStyleScope(index);
				},
				deleteOverlaySegments: (
					type: "style" | "image" | "waveform",
					indices: number[],
				) => {
					const remove = new Set(indices);
					batch(() => {
						setProject(
							produce((value) => {
								if (!value.timeline) return;
								if (type === "style")
									value.timeline.styleSegments =
										value.timeline.styleSegments.filter(
											(_, index) => !remove.has(index),
										);
								else if (type === "image")
									value.timeline.imageSegments =
										value.timeline.imageSegments.filter(
											(_, index) => !remove.has(index),
										);
								else
									value.timeline.waveformSegments =
										value.timeline.waveformSegments?.filter(
											(_, index) => !remove.has(index),
										);
							}),
						);
						if (type === "style") setEditorState("styleEditIndex", null);
						setEditorState("timeline", "selection", null);
					});
				},
				addStyleSegment: (lane: number, time = editorState.playbackTime) => {
					const placement = overlayPlacement("style", lane, time);
					if (!placement || !project.timeline) return;
					setProject(
						"timeline",
						"styleSegments",
						produce((segments) => {
							segments.push(
								defaultStyleSegment(
									placement.start,
									placement.end,
									placement.lane,
								),
							);
							sortTrackSegments(segments);
						}),
					);
					selectAddedOverlay("style", placement.lane, placement.start);
				},
				addWaveformSegment: (lane: number, time = 0) => {
					const timeline = project.timeline;
					if (!timeline) return;
					const segments = timeline.waveformSegments ?? [];
					const requested = waveformGapAt(
						segments.filter((segment) => segment.track === lane),
						time,
						totalDuration(),
					);
					const placement = requested
						? { ...requested, lane }
						: {
								start: 0,
								end: totalDuration(),
								lane: Math.max(getUsedTrackCount(segments), lane + 1),
							};
					if (!(placement.end > placement.start)) return;
					setProject("timeline", "waveformSegments", (segments) =>
						sortTrackSegments([
							...(segments ?? []),
							defaultWaveformSegment(
								placement.start,
								placement.end,
								placement.lane,
							),
						]),
					);
					selectAddedOverlay("waveform", placement.lane, placement.start);
				},
				importImageSegment: async (
					lane: number,
					time = editorState.playbackTime,
					replaceIndex?: number,
				) => {
					if (editorState.importingImage) return;
					const original =
						replaceIndex === undefined
							? null
							: project.timeline?.imageSegments[replaceIndex];
					setEditorState("importingImage", true);
					try {
						const asset = await pickImage();
						if (!asset || !project.timeline) return;
						if (replaceIndex !== undefined) {
							if (
								!original ||
								project.timeline.imageSegments[replaceIndex] !== original
							)
								return;
							const output = editorInstanceContext.latestFrameLayout();
							const width = output?.output_width ?? 1920;
							const height = output?.output_height ?? 1080;
							const scale = Math.min(
								(original.size.x * width) / asset.width,
								(original.size.y * height) / asset.height,
							);
							setProject("timeline", "imageSegments", replaceIndex, {
								path: asset.path,
								name: asset.name,
								...(original.lockAspect
									? {
											size: {
												x: (asset.width * scale) / width,
												y: (asset.height * scale) / height,
											},
										}
									: {}),
							});
							return;
						}
						const placement = overlayPlacement("image", lane, time);
						if (!placement) return;
						const layout = editorInstanceContext.latestFrameLayout();
						const output = {
							width: layout?.output_width ?? 1920,
							height: layout?.output_height ?? 1080,
						};
						setProject(
							"timeline",
							"imageSegments",
							produce((segments) => {
								segments.push(
									defaultImageSegment(
										asset,
										placement.start,
										placement.end,
										placement.lane,
										output,
									),
								);
								sortTrackSegments(segments);
							}),
						);
						selectAddedOverlay("image", placement.lane, placement.start);
					} catch (error) {
						toast.error(
							error instanceof Error ? error.message : "Unable to import image",
						);
					} finally {
						setEditorState("importingImage", false);
					}
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
							}),
						);
						setEditorState("timeline", "selection", null);
					});
				},
				splitAudioSegment: (index: number, time: number) => {
					setProject(
						"timeline",
						"audioSegments",
						produce((segments) => {
							const segment = segments?.[index];
							if (!segment) return;

							const duration = segment.end - segment.start;
							const remaining = duration - time;
							if (time < MIN_AUDIO_SEGMENT_DURATION) return;
							if (remaining < MIN_AUDIO_SEGMENT_DURATION) return;

							segments.splice(index + 1, 0, {
								...segment,
								start: segment.start + time,
								end: segment.end,
								trimStart: segment.trimStart + time,
								fadeIn: 0,
							});
							segments[index].end = segment.start + time;
							segments[index].fadeOut = 0;
							sortTrackSegments(segments);
						}),
					);
				},
				deleteAudioSegments: (segmentIndices: number[]) => {
					batch(() => {
						setProject(
							"timeline",
							"audioSegments",
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
				addAudioSegment: (laneIndex: number, imported: ImportedAudioTrack) => {
					const total = totalDuration();
					const hasSourceDuration = imported.duration > 0;
					const sourceDuration = hasSourceDuration ? imported.duration : total;
					const length = Math.max(
						MIN_AUDIO_SEGMENT_DURATION,
						Math.min(sourceDuration, total > 0 ? total : sourceDuration),
					);
					const maxStart = Math.max(0, total - length);
					const start = Math.min(
						Math.max(editorState.playbackTime, 0),
						maxStart,
					);

					batch(() => {
						setProject("timeline", "audioSegments", (v) => v ?? []);
						setProject(
							"timeline",
							"audioSegments",
							produce((segments) => {
								segments ??= [];
								segments.push(
									createAudioTrackSegment({
										start,
										end: start + length,
										track: laneIndex,
										path: imported.path,
										name: imported.name,
										duration: hasSourceDuration ? imported.duration : null,
									}),
								);
								sortTrackSegments(segments);
							}),
						);

						const segments = project.timeline?.audioSegments ?? [];
						setEditorState(
							"timeline",
							"tracks",
							"audio",
							Math.max(
								getUsedTrackCount<{
									start: number;
									end: number;
									track?: number;
								}>(segments),
								laneIndex + 1,
							),
						);
						setEditorState("timeline", "audioPicker", null);
						const insertedIndex = segments.findIndex(
							(segment) =>
								segment.track === laneIndex &&
								segment.start === start &&
								segment.path === imported.path,
						);
						if (insertedIndex >= 0) {
							setEditorState("timeline", "selection", {
								type: "audio",
								indices: [insertedIndex],
							});
						}
					});
				},
				replaceAudioSegment: (index: number, imported: ImportedAudioTrack) => {
					setProject(
						"timeline",
						"audioSegments",
						produce((segments) => {
							const segment = segments?.[index];
							if (!segment) return;

							const hasSourceDuration = imported.duration > 0;
							segment.path = imported.path;
							segment.name = imported.name;
							segment.duration = hasSourceDuration ? imported.duration : null;
							segment.trimStart = 0;

							if (hasSourceDuration) {
								const maxEnd = segment.start + imported.duration;
								if (segment.end > maxEnd) {
									segment.end = Math.max(
										segment.start + MIN_AUDIO_SEGMENT_DURATION,
										maxEnd,
									);
								}
							}

							const duration = Math.max(segment.end - segment.start, 0);
							if (segment.fadeIn > duration) segment.fadeIn = duration;
							if (segment.fadeOut > duration) segment.fadeOut = duration;
							sortTrackSegments(segments);
						}),
					);
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
							const parts = splitKeyboardSegment(
								structuredClone(unwrap(segment)),
								segment.start + time,
								`kb-split-${Date.now()}-${Math.random().toString(36).slice(2)}`,
							);
							if (parts) segments.splice(index, 1, ...parts);
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

							const oldDuration = clipTimelineDuration(
								timeline.segments,
								timeline.transitions ?? [],
							);
							const oldOffsets = clipTimelineOffsets(
								timeline.segments,
								timeline.transitions ?? [],
							);
							const oldHolds = holdWindows(timeline.textSegments);
							const incomingDuration =
								getClipTransition(
									timeline.segments,
									timeline.transitions ?? [],
									index,
								)?.duration ?? 0;
							segment.timescale = timescale;
							timeline.transitions = normalizeClipTransitions(
								timeline.segments,
								timeline.transitions ?? [],
							);
							const newDuration = clipTimelineDuration(
								timeline.segments,
								timeline.transitions,
							);
							const newOffsets = clipTimelineOffsets(
								timeline.segments,
								timeline.transitions,
							);
							const absoluteStart = oldOffsets[index] + incomingDuration;
							const oldNextBoundary = oldOffsets[index + 1] ?? oldDuration;
							const newNextBoundary = newOffsets[index + 1] ?? newDuration;

							const diff = (value: number) =>
								timelineShiftAfterClipDurationChange(
									value,
									oldOffsets[index],
									newOffsets[index],
									absoluteStart,
									oldNextBoundary,
									newNextBoundary,
								);
							const mapOutputTime = (value: number) => {
								const held = heldTimeBefore(oldHolds, value);
								return value + diff(value - held);
							};

							for (const overlay of [
								...timeline.styleSegments,
								...timeline.imageSegments,
								...(timeline.waveformSegments ?? []),
							]) {
								overlay.start = mapOutputTime(overlay.start);
								overlay.end = mapOutputTime(overlay.end);
							}
							for (const zoomSegment of timeline.zoomSegments) {
								zoomSegment.start = mapOutputTime(zoomSegment.start);
								zoomSegment.end = mapOutputTime(zoomSegment.end);
							}

							for (const sceneSegment of timeline.sceneSegments ?? []) {
								sceneSegment.start = mapOutputTime(sceneSegment.start);
								sceneSegment.end = mapOutputTime(sceneSegment.end);
							}

							for (const maskSegment of timeline.maskSegments) {
								maskSegment.start = mapOutputTime(maskSegment.start);
								maskSegment.end = mapOutputTime(maskSegment.end);
							}

							for (const textSegment of timeline.textSegments) {
								textSegment.start = mapOutputTime(textSegment.start);
								textSegment.end = mapOutputTime(textSegment.end);
							}

							for (const audioSegment of timeline.audioSegments ?? []) {
								audioSegment.start = mapOutputTime(audioSegment.start);
								audioSegment.end = mapOutputTime(audioSegment.end);
							}

							for (const captionSegment of timeline.captionSegments ?? []) {
								captionSegment.start = mapOutputTime(captionSegment.start);
								captionSegment.end = mapOutputTime(captionSegment.end);
							}

							mapKeyboardTrackTimes(
								timeline.keyboardSegments ?? [],
								mapOutputTime,
							);

							for (const camera3dSegment of timeline.camera3dSegments ?? []) {
								const previousDuration =
									camera3dSegment.end - camera3dSegment.start;
								camera3dSegment.start = mapOutputTime(camera3dSegment.start);
								camera3dSegment.end = mapOutputTime(camera3dSegment.end);
								// Keyframe times are relative to the segment start, so they
								// have to follow the segment's new length rather than the
								// absolute shift the other tracks use.
								const nextDuration =
									camera3dSegment.end - camera3dSegment.start;
								if (previousDuration <= 0 || nextDuration === previousDuration)
									continue;
								scaleKeyframeTimes(
									camera3dSegment.tracks,
									nextDuration / previousDuration,
								);
							}
						}),
					);
				},
				setClipSegmentSpeedAudioMode: (
					index: number,
					speedAudioMode: ClipSpeedAudioMode,
				) => {
					setProject(
						"timeline",
						"segments",
						index,
						"speedAudioMode",
						speedAudioMode,
					);
				},
				setClipSegmentVolume: (index: number, volume: number) => {
					if (!Number.isFinite(volume) || !project.timeline?.segments[index]) {
						return;
					}
					const next = Math.min(2, Math.max(0, volume));
					setProject(
						"timeline",
						"segments",
						index,
						"volume",
						next === 1 ? null : next,
					);
				},
				setClipSegmentMuted: (index: number, muted: boolean) => {
					const segment = project.timeline?.segments[index];
					if (!segment) return;
					setProject(
						"timeline",
						"segments",
						index,
						"speedAudioMode",
						muted ? "mute" : segment.timescale === 1 ? null : "maintainPitch",
					);
				},
				setClipSegmentHideCursor: (index: number, hidden: boolean) => {
					if (!project.timeline?.segments[index]) return;
					setProject(
						"timeline",
						"segments",
						index,
						"hideCursor",
						hidden ? true : undefined,
					);
				},
				setClipSegmentName: (index: number, name: string | null) => {
					if (!project.timeline?.segments[index]) return;
					const trimmed = name?.trim();
					setProject(
						"timeline",
						"segments",
						index,
						"name",
						trimmed ? trimmed : null,
					);
				},
				mergeClipSegment: (index: number, direction: ClipMergeDirection) => {
					const timeline = project.timeline;
					if (!timeline) return;
					if (clipMergeBlocker(timeline.segments, index, direction)) return;
					const kept = clipMergeKeptIndex(index, direction);
					batch(() => {
						// Dropping the transition on the merged boundary first lets
						// setClipTransition ripple the other tracks for the overlap it
						// gave back; the merge itself is duration-neutral.
						setClipTransition(kept + 1, null);
						setProject(
							produce((project) => {
								const timeline = project.timeline;
								if (!timeline) return;
								const left = timeline.segments[kept];
								const right = timeline.segments[kept + 1];
								const settingsFrom = timeline.segments[index];
								if (!left || !right || !settingsFrom) return;
								timeline.segments.splice(
									kept,
									2,
									mergedClipSegment(left, right, settingsFrom),
								);
								timeline.transitions = transitionsAfterClipMerge(
									timeline.transitions ?? [],
									kept,
								);
							}),
						);
						setEditorState("timeline", "selection", {
							type: "clip",
							indices: [kept],
						});
					});
				},
			};

			const initialWebConfig = JSON.stringify(
				serializeProjectConfiguration(project),
			);
			let lastPersistedWebConfig: string | null = null;
			const projectSave = createProjectConfigSave({
				trackChanges: () => {
					trackStore(project);
				},
				getConfig: () => serializeProjectConfiguration(project),
				save: async (config) => {
					const preservePaidCaptions =
						(
							window as Window & {
								capWebEditorCaptionsEnabled?: boolean;
							}
						).capWebEditorCaptionsEnabled === false;
					await commands.setProjectConfig(config);
					const prior = JSON.parse(
						lastPersistedWebConfig ?? initialWebConfig,
					) as Record<string, unknown>;
					lastPersistedWebConfig = JSON.stringify(
						preservePaidCaptions
							? savedEditorProjectAfterFreeEdit(
									config as unknown as Record<string, unknown>,
									prior,
								)
							: config,
					);
				},
				onError: (error) => {
					console.error("Failed to persist project config", error);
				},
			});
			const editorWindow = window as Window & {
				capWebEditorUnsavedProjectSnapshot?: () => string | null;
			};
			const unsavedProjectSnapshot = () => {
				const serialized = JSON.stringify(
					serializeProjectConfiguration(project),
				);
				return serialized === (lastPersistedWebConfig ?? initialWebConfig)
					? null
					: serialized;
			};
			editorWindow.capWebEditorUnsavedProjectSnapshot = unsavedProjectSnapshot;
			onCleanup(() => {
				if (
					editorWindow.capWebEditorUnsavedProjectSnapshot ===
					unsavedProjectSnapshot
				) {
					delete editorWindow.capWebEditorUnsavedProjectSnapshot;
				}
			});

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

			const previewResolutionBase = () =>
				getPreviewResolution(previewQuality());
			createEffect(() =>
				editorInstanceContext.setPreviewBase(previewResolutionBase()),
			);

			const layoutModeStorageKey = `cap:editor:layoutMode:${props.editorInstance.path}`;

			const readPersistedLayoutMode = (): DialogState => {
				try {
					const raw = sessionStorage.getItem(layoutModeStorageKey);
					if (!raw) return { open: false };
					const parsed = JSON.parse(raw) as { type?: CurrentDialog["type"] };
					if (parsed?.type && PERSISTED_LAYOUT_MODE_TYPES.has(parsed.type)) {
						return { open: true, type: parsed.type } as OpenLayoutMode;
					}
				} catch (error) {
					console.error("Failed to read persisted editor layout mode", error);
				}
				return { open: false };
			};

			const [dialog, setDialog] = createSignal<DialogState>(
				readPersistedLayoutMode(),
			);

			createEffect(() => {
				const current = dialog();
				try {
					if (
						isLayoutMode(current) &&
						PERSISTED_LAYOUT_MODE_TYPES.has(current.type)
					) {
						sessionStorage.setItem(
							layoutModeStorageKey,
							JSON.stringify({ type: current.type }),
						);
					} else {
						sessionStorage.removeItem(layoutModeStorageKey);
					}
				} catch (error) {
					console.error("Failed to persist editor layout mode", error);
				}
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

			const totalDuration = createMemo(() =>
				project.timeline
					? clipTimelineDuration(
							project.timeline.segments,
							project.timeline.transitions ?? [],
						) + totalHeldDuration(holdWindows(project.timeline.textSegments))
					: props.editorInstance.recordingDuration,
			);

			type State = {
				zoom: number;
				position: number;
			};

			const zoomOutLimit = totalDuration;

			function updateZoom(
				state: State,
				newZoom: number,
				origin: number,
			): State {
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
			const initialAudioTrackCount = getUsedTrackCount(
				project.timeline?.audioSegments ?? [],
			);
			const initialCaptionTrackVisible =
				project.captions?.settings.enabled ??
				(project.timeline?.captionSegments?.length ?? 0) > 0;
			const initialKeyboardTrackVisible =
				project.keyboard?.settings.enabled ?? false;
			const initialCamera3DTrackVisible =
				(project.timeline?.camera3dSegments?.length ?? 0) > 0;

			const [editorState, setEditorState] = createStore({
				styleEditIndex: null as number | null,
				importingImage: false,
				previewTime: null as number | null,
				playbackTime: 0,
				playing: false,
				canvasSelection: null as
					| null
					| { type: "display" }
					| { type: "camera" },
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
					splitPreview: null as null | { time: number; snapped: boolean },
					selection: null as
						| null
						| { type: "style"; indices: number[] }
						| { type: "image"; indices: number[] }
						| { type: "waveform"; indices: number[] }
						| { type: "zoom"; indices: number[] }
						| { type: "clip"; indices: number[] }
						| { type: "transition"; index: number }
						| { type: "scene"; indices: number[] }
						| { type: "mask"; indices: number[] }
						| { type: "caption"; indices: number[] }
						| { type: "keyboard"; indices: number[] }
						| { type: "text"; indices: number[] }
						| { type: "audio"; indices: number[] }
						| { type: "3d"; indices: number[] },
					transform: {
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
						style: getUsedTrackCount(project.timeline?.styleSegments ?? []),
						image: getUsedTrackCount(project.timeline?.imageSegments ?? []),
						waveform: getUsedTrackCount(
							project.timeline?.waveformSegments ?? [],
						),
						clip: true,
						caption: initialCaptionTrackVisible,
						keyboard: initialKeyboardTrackVisible,
						zoom: true,
						scene: true,
						"3d": initialCamera3DTrackVisible,
						mask: initialMaskTrackCount,
						text: initialTextTrackCount,
						audio: initialAudioTrackCount,
					},
					hoveredTrack: null as null | TimelineTrackType,
					hoveredMaskIndex: null as number | null,
					hoveredMaskTime: null as number | null,
					audioPicker: null as number | null,
					audioReplace: null as number | null,
					camera3dPose: "start" as "start" | "end",
					camera3dAutoPreview: null as number | null,
					pendingTextEdit: null as number | null,
				},
			});

			createEffect(
				on(
					() => editorState.timeline.selection,
					(selection) => {
						if (!selection) return;
						batch(() => {
							setEditorState("timeline", "audioPicker", null);
							setEditorState("timeline", "audioReplace", null);
						});
					},
				),
			);

			createEffect(
				on(totalDuration, (end) => {
					untrack(() => {
						if (
							editorState.previewTime !== null &&
							editorState.previewTime > end
						)
							setEditorState("previewTime", end);
						if (!editorState.playing && editorState.playbackTime > end)
							setEditorState("playbackTime", end);
					});
				}),
			);

			let camera3DShotStopRunning = false;
			createEffect(() => {
				const stop = camera3DShotStop();
				if (!stop) {
					camera3DShotStopRunning = false;
					return;
				}
				if (!editorState.playing) {
					if (camera3DShotStopRunning) setCamera3DShotStop(null);
					return;
				}
				camera3DShotStopRunning = true;
				if (editorState.playbackTime < stop.end) return;
				setCamera3DShotStop(null);
				void commands.stopPlayback();
				setEditorState("playing", false);
			});

			let selectedStyleIdentity: StyleSegment | undefined;
			const selectedStyle = () =>
				editorState.styleEditIndex === null
					? undefined
					: project.timeline?.styleSegments[editorState.styleEditIndex];
			const styleScopeToken = createMemo(() => ({
				index: editorState.styleEditIndex,
				segment: selectedStyle(),
			}));
			const enterStyleScope = (index: number) => {
				selectedStyleIdentity = project.timeline?.styleSegments[index];
				setEditorState("styleEditIndex", selectedStyleIdentity ? index : null);
			};
			createEffect(
				on(
					() => {
						const selection = editorState.timeline.selection;
						return selection?.type === "style"
							? (selection.indices[0] ?? null)
							: null;
					},
					(index) => {
						if (index !== null) enterStyleScope(index);
						else {
							selectedStyleIdentity = undefined;
							setEditorState("styleEditIndex", null);
						}
					},
				),
			);
			createEffect(() => {
				if (
					editorState.styleEditIndex !== null &&
					(!selectedStyle() || selectedStyle() !== selectedStyleIdentity)
				)
					setEditorState("styleEditIndex", null);
			});
			const styleProject = new Proxy(project, {
				get(target, key, receiver) {
					if (key === "background" || key === "camera" || key === "cursor")
						return selectedStyle()?.overrides[key] ?? target[key];
					return Reflect.get(target, key, receiver);
				},
			});
			const setStyleProject = ((...args: unknown[]) => {
				const selected = selectedStyle();
				const index = editorState.styleEditIndex;
				if (index === null || args[0] === "timeline")
					return Reflect.apply(setProject, undefined, args);
				if (!selected) return;
				const group = args[0];
				if (group !== "background" && group !== "camera" && group !== "cursor")
					return;
				if (selected.overrides[group] == null) return;
				const [draft, setDraft] = createStore({
					background: structuredClone(unwrap(styleProject.background)),
					camera: structuredClone(unwrap(styleProject.camera)),
					cursor: structuredClone(unwrap(styleProject.cursor)),
				});
				Reflect.apply(setDraft, undefined, args);
				setProject(
					"timeline",
					"styleSegments",
					index,
					"overrides",
					produce((overrides) => {
						if (group === "background")
							overrides.background = unwrap(draft.background);
						if (group === "camera") overrides.camera = unwrap(draft.camera);
						if (group === "cursor") overrides.cursor = unwrap(draft.cursor);
					}),
				);
			}) as typeof setProject;
			const createStyleProjectSetter = () => {
				const token = styleScopeToken();
				return ((...args: unknown[]) => {
					if (token !== styleScopeToken()) return;
					return Reflect.apply(setStyleProject, undefined, args);
				}) as typeof setProject;
			};
			const toggleStyleGroup = (group: StyleGroup, enabled: boolean) => {
				const index = editorState.styleEditIndex;
				if (index === null) return;
				setProject(
					"timeline",
					"styleSegments",
					index,
					"overrides",
					produce((overrides) => {
						if (group === "background")
							overrides.background = enabled
								? structuredClone(unwrap(project.background))
								: null;
						if (group === "camera")
							overrides.camera = enabled
								? structuredClone(unwrap(project.camera))
								: null;
						if (group === "cursor")
							overrides.cursor = enabled
								? structuredClone(unwrap(project.cursor))
								: null;
					}),
				);
			};
			const exitStyleScope = () =>
				batch(() => {
					setEditorState("styleEditIndex", null);
					if (editorState.timeline.selection?.type === "style")
						setEditorState("timeline", "selection", null);
				});
			const activePreviewStyles = createMemo(
				() =>
					activeStyleSegments(
						project.timeline?.styleSegments ?? [],
						editorState.previewTime ?? editorState.playbackTime,
					),
				undefined,
				{
					equals: (previous, next) =>
						previous.length === next.length &&
						previous.every(
							(entry, index) =>
								entry.index === next[index]?.index &&
								entry.segment === next[index]?.segment,
						),
				},
			);
			const previewStyle = createMemo(() =>
				applyStyleSegments(project, activePreviewStyles()),
			);
			const [snapGuides, setSnapGuides] = createSignal<SnapGuide[]>([]);

			// Plain signals, not resources: audio decodes in the background after
			// the editor opens, so these can resolve late — they must never suspend
			// the editor UI back to the skeleton. Waveforms simply appear once
			// decoded.
			const [micWaveforms, setMicWaveforms] = createSignal<number[][]>();
			const [systemAudioWaveforms, setSystemAudioWaveforms] =
				createSignal<number[][]>();
			onMount(() => {
				commands
					.getMicWaveforms()
					.then(setMicWaveforms)
					.catch((error) =>
						console.error("Failed to load mic waveforms:", error),
					);
				commands
					.getSystemAudioWaveforms()
					.then(setSystemAudioWaveforms)
					.catch((error) =>
						console.error("Failed to load system audio waveforms:", error),
					);
			});
			const captionRecordingSegments = props.editorInstance.recordings.segments;

			// Legacy projects stored caption segments in already-edited output time; invert
			// them back to source time once so the render track can be derived from them.
			if (project.captions && !project.captions.sourceTimed) {
				const timeline = project.timeline;
				const segments = project.captions.segments ?? [];
				if (timeline && segments.length > 0) {
					const toSource = (time: number) =>
						mapEditedTimeToSource(
							time,
							timeline.segments,
							captionRecordingSegments,
							timeline.transitions ?? [],
							undefined,
							"incoming",
							timeline.textSegments,
						);
					const inverted = segments.flatMap((segment) => {
						const start = toSource(segment.start);
						const end = toSource(segment.end);
						if (start === null || end === null) return [];
						const words = (segment.words ?? []).flatMap((word) => {
							const wordStart = toSource(word.start);
							const wordEnd = toSource(word.end);
							return wordStart !== null && wordEnd !== null
								? [{ ...word, start: wordStart, end: wordEnd }]
								: [];
						});
						return [{ ...segment, start, end, words }];
					});
					inverted.sort((a, b) => a.start - b.start);
					setProject("captions", "segments", inverted);
				}
				if (project.captions) setProject("captions", "sourceTimed", true);
			}

			createEffect(
				on(
					() => {
						const segments = project.captions?.segments;
						const timeline = project.timeline;
						if (!segments || segments.length === 0 || !timeline) return null;
						const captionsSig = segments
							.map(
								(s) =>
									`${s.id}|${s.start}|${s.end}|${s.text}|${(s.words ?? [])
										.map((w) => `${w.start}:${w.end}:${w.text}`)
										.join("~")}`,
							)
							.join(",");
						const timelineSig = timeline.segments
							.map(
								(s) =>
									`${s.start}|${s.end}|${s.timescale}|${s.recordingSegment ?? 0}`,
							)
							.join(",");
						const transitionSig = (timeline.transitions ?? [])
							.map(
								(transition) =>
									`${transition.segmentIndex}|${transition.type}|${transition.duration}`,
							)
							.join(",");
						const holdSig = holdWindows(timeline.textSegments)
							.map(([start, end]) => `${start}|${end}`)
							.join(",");
						return `${captionsSig}@@${timelineSig}@@${transitionSig}@@${holdSig}`;
					},
					() => {
						const timeline = project.timeline;
						const segments = project.captions?.segments;
						if (!timeline || !segments) return;
						const derived = deriveCaptionTrackSegments(
							segments,
							timeline.segments,
							captionRecordingSegments,
							timeline.captionSegments ?? [],
							timeline.transitions ?? [],
							timeline.textSegments,
						);
						setProject(
							"timeline",
							"captionSegments",
							reconcile(derived, { key: "id" }),
						);

						// The renderer only reflects config that is explicitly pushed, and the config-push
						// effect doesn't run on initial load, so without this the frame keeps stale captions.
						if (!editorState.playing) {
							const frameNumber = Math.max(
								Math.floor(editorState.playbackTime * FPS),
								0,
							);
							commands
								.updateProjectConfigInMemory(
									serializeProjectConfiguration(project),
									frameNumber,
									FPS,
									previewResolutionBase(),
								)
								.catch((error) => {
									console.error(
										"Failed to refresh caption preview config",
										error,
									);
								});
						}
					},
				),
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

			return {
				...editorInstanceContext,
				playbackIntent: () => editorState.playing,
				meta() {
					return props.meta();
				},
				refetchMeta: () => props.refetchMeta(),
				editorInstance: props.editorInstance,
				dialog,
				setDialog,
				project,
				setProject,
				projectActions,
				flushProjectConfig: projectSave.flush,
				projectRevision: projectSave.revision,
				baseProject: project,
				styleProject,
				styleScopeToken,
				createStyleProjectSetter,
				setStyleProject,
				camera3DAutoScenePreview,
				selectedStyle,
				toggleStyleGroup,
				exitStyleScope,
				previewStyle,
				projectHistory: createStoreHistory(project, setProject, () => {
					exitStyleScope();
					setEditorState("timeline", "selection", null);
				}),
				editorState,
				setEditorState,
				snapGuides,
				setSnapGuides,
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

export const EditorStyleContext =
	createContext<ReturnType<typeof useBaseEditorContext>>();

export function useEditorContext() {
	return useContext(EditorStyleContext) ?? useBaseEditorContext();
}

export type {
	CanvasControls,
	FrameData,
} from "../../../engine/browser-frame-socket";
export type { EditorPreviewQuality } from "../../../engine/types";

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
		audioOnly: (rawMeta as { audioOnly?: boolean }).audioOnly === true,
	};
}

export type TransformedMeta = ReturnType<typeof transformMeta>;

const createEditorInstanceContext = () => {
	const [latestFrame, setLatestFrame] = createLazySignal<FrameData>();

	const [latestFrameLayout, setLatestFrameLayout] =
		createSignal<FrameLayoutEvent | null>(null);
	createEditorEventListener(events.frameLayoutEvent, setLatestFrameLayout);

	const [_isConnected, setIsConnected] = createSignal(false);
	const [isWorkerReady, setIsWorkerReady] = createSignal(false);
	const [canvasControls, setCanvasControls] =
		createSignal<CanvasControls | null>(null);
	let previewBase = getPreviewResolution(DEFAULT_PREVIEW_QUALITY);
	const [performanceMode, setPerformanceMode] = createSignal(false);

	let disposeWorkerReadyEffect: (() => void) | undefined;
	let activeInstanceId: string | undefined;
	let closeSocket: (() => void) | undefined;
	let alive = true;

	onCleanup(() => {
		alive = false;
		activeInstanceId = undefined;
		closeSocket?.();
		disposeWorkerReadyEffect?.();
		canvasControls()?.dispose();
	});

	const [editorInstance, { refetch: refetchEditorInstance }] = createResource(
		async () => {
			let instance: SerializedEditorInstance | undefined;
			let lastError: unknown;
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					instance = await commands.createEditorInstance();
					break;
				} catch (e) {
					lastError = e;
					if (attempt === 4) break;
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

			const instanceId = instance.instanceId;
			if (!alive) return instance;
			activeInstanceId = instanceId;
			closeSocket?.();
			disposeWorkerReadyEffect?.();
			canvasControls()?.dispose();
			const requestFrame = () => {
				if (!alive || activeInstanceId !== instanceId) return;
				events.renderFrameEvent.emit({
					frame_number: 0,
					fps: FPS,
					resolution_base: previewBase,
				});
			};

			const [ws, _wsConnected, workerReady, controls] = createPreviewConnection(
				(frame) => {
					if (alive && activeInstanceId === instanceId) setLatestFrame(frame);
				},
				requestFrame,
			);
			closeSocket = () => ws.close();

			setCanvasControls(controls);

			disposeWorkerReadyEffect = createRoot((dispose) => {
				createEffect(() => {
					setIsWorkerReady(workerReady());
				});
				return dispose;
			});

			ws.addEventListener("open", () => {
				if (!alive || activeInstanceId !== instanceId) return;
				setIsConnected(true);
				requestFrame();
			});

			ws.addEventListener("close", () => {
				if (!alive || activeInstanceId !== instanceId) return;
				setIsConnected(false);
			});

			return instance;
		},
	);

	const metaQuery = createQuery(() => ({
		queryKey: ["editor", "meta"],
		queryFn:
			!editorInstance.error && editorInstance.latest
				? () => commands.getEditorMeta().then(transformMeta)
				: skipToken,
		cacheTime: 0,
		staleTime: 0,
	}));

	return {
		editorInstance,
		refetchEditorInstance,
		latestFrame,
		latestFrameLayout,
		presets: createPresets(),
		metaQuery,
		isWorkerReady,
		canvasControls,
		performanceMode,
		setPerformanceMode,
		setPreviewBase: (base: XY<number>) => {
			previewBase = base;
		},
	};
};

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
	createContextProvider(
		createEditorInstanceContext,
		null as unknown as ReturnType<typeof createEditorInstanceContext>,
	);

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
		const bounds = createElementBounds(() => props.ref(), {
			trackMutation: false,
		});

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
