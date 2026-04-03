import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { platform } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	batch,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	Index,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import toast from "solid-toast";

import "./styles.css";

import Tooltip from "~/components/Tooltip";
import { defaultCaptionSettings } from "~/store/captions";
import { defaultKeyboardSettings } from "~/store/keyboard";
import { commands } from "~/utils/tauri";
import {
	applyCaptionResultToProject,
	getCaptionGenerationErrorMessage,
	getSelectedTranscriptionSettings,
	transcribeEditorCaptions,
} from "../captions";
import { FPS, type TimelineTrackType, useEditorContext } from "../context";
import type { MaskSegment } from "../masks";
import type { TextSegment } from "../text";
import { getTrackRowsWithCount, getUsedTrackCount } from "../timelineTracks";
import { formatTime } from "../utils";
import { type CaptionSegmentDragState, CaptionsTrack } from "./CaptionsTrack";
import { ClipTrack } from "./ClipTrack";
import { TimelineContextProvider, useTimelineContext } from "./context";
import { type KeyboardSegmentDragState, KeyboardTrack } from "./KeyboardTrack";
import { type MaskSegmentDragState, MaskTrack } from "./MaskTrack";
import { type SceneSegmentDragState, SceneTrack } from "./SceneTrack";
import { type TextSegmentDragState, TextTrack } from "./TextTrack";
import { TrackIcon, TrackManager } from "./TrackManager";
import { type ZoomSegmentDragState, ZoomTrack } from "./ZoomTrack";

const TIMELINE_PADDING = 16;
const TRACK_GUTTER = 64;
const TIMELINE_HEADER_HEIGHT = 32;
const PLAYHEAD_TOP_OFFSET = 24;

const trackIcons: Record<TimelineTrackType, () => JSX.Element> = {
	clip: () => <IconLucideClapperboard class="size-4" />,
	caption: () => <IconCapCaptions class="size-4" />,
	keyboard: () => <IconLucideKeyboard class="size-4" />,
	text: () => <IconLucideType class="size-4" />,
	mask: () => <IconLucideBoxSelect class="size-4" />,
	zoom: () => <IconLucideSearch class="size-4" />,
	scene: () => <IconLucideVideo class="size-4" />,
};

type TrackDefinition = {
	type: TimelineTrackType;
	label: string;
	icon: () => JSX.Element;
	locked: boolean;
};

const trackDefinitions: TrackDefinition[] = [
	{
		type: "clip",
		label: "Clip",
		icon: trackIcons.clip,
		locked: true,
	},
	{
		type: "caption",
		label: "Captions",
		icon: trackIcons.caption,
		locked: false,
	},
	{
		type: "keyboard",
		label: "Keyboard",
		icon: trackIcons.keyboard,
		locked: false,
	},
	{
		type: "text",
		label: "Text",
		icon: trackIcons.text,
		locked: false,
	},
	{
		type: "mask",
		label: "Mask",
		icon: trackIcons.mask,
		locked: false,
	},
	{
		type: "zoom",
		label: "Zoom",
		icon: trackIcons.zoom,
		locked: true,
	},
	{
		type: "scene",
		label: "Scene",
		icon: trackIcons.scene,
		locked: false,
	},
];

function deleteTrackLane<T extends { track?: number }>(
	segments: T[],
	laneIndex: number,
) {
	return segments
		.filter((segment) => (segment.track ?? 0) !== laneIndex)
		.map<T>((segment) => {
			const track = segment.track ?? 0;
			if (track <= laneIndex) return segment;
			return { ...segment, track: track - 1 };
		});
}

export function Timeline(props: {
	onViewportOverflowChange?: (value: {
		overflow: number;
		visibleTrackCount: number;
	}) => void;
}) {
	const {
		project,
		setProject,
		editorInstance,
		projectHistory,
		setEditorState,
		totalDuration,
		editorState,
		projectActions,
		meta,
		previewResolutionBase,
	} = useEditorContext();

	const duration = () => editorInstance.recordingDuration;
	const transform = () => editorState.timeline.transform;

	const [timelineContainerRef, setTimelineContainerRef] =
		createSignal<HTMLDivElement>();
	const [timelineScrollRef, setTimelineScrollRef] =
		createSignal<HTMLDivElement>();
	const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
	const timelineBounds = createElementBounds(timelineRef);

	const secsPerPixel = () => transform().zoom / (timelineBounds.width ?? 1);

	const trackState = () => editorState.timeline.tracks;
	const sceneAvailable = () => meta().hasCamera && !project.camera.hide;
	const captionTrackVisible = () => trackState().caption;
	const keyboardTrackVisible = () => trackState().keyboard;
	const trackOptions = createMemo(() =>
		trackDefinitions.map((definition) => ({
			...definition,
			active:
				definition.type === "caption"
					? trackState().caption
					: definition.type === "keyboard"
						? trackState().keyboard
						: definition.type === "scene"
							? trackState().scene
							: definition.type === "mask"
								? trackState().mask > 0
								: definition.type === "text"
									? trackState().text > 0
									: true,
			available: definition.type === "scene" ? sceneAvailable() : true,
			supportsMultiple:
				definition.type === "mask" || definition.type === "text",
		})),
	);
	const sceneTrackVisible = () => trackState().scene && sceneAvailable();
	const textTrackRows = createMemo(() =>
		getTrackRowsWithCount(
			project.timeline?.textSegments ?? [],
			trackState().text,
		),
	);
	const maskTrackRows = createMemo(() =>
		getTrackRowsWithCount(
			project.timeline?.maskSegments ?? [],
			trackState().mask,
		),
	);
	const visibleTrackCount = createMemo(
		() =>
			2 +
			(captionTrackVisible() ? 1 : 0) +
			(keyboardTrackVisible() ? 1 : 0) +
			textTrackRows().length +
			maskTrackRows().length +
			(sceneTrackVisible() ? 1 : 0),
	);
	const trackHeight = createMemo(() =>
		visibleTrackCount() > 2 ? "3rem" : "3.25rem",
	);

	createEffect(() => {
		const visibleTracks = visibleTrackCount();
		const scrollContainer = timelineScrollRef();
		if (!scrollContainer) return;

		const frame = requestAnimationFrame(() => {
			const currentScrollContainer = timelineScrollRef();
			if (!currentScrollContainer) return;
			props.onViewportOverflowChange?.({
				visibleTrackCount: visibleTracks,
				overflow: Math.ceil(
					Math.max(
						currentScrollContainer.scrollHeight -
							currentScrollContainer.clientHeight,
						0,
					),
				),
			});
		});

		onCleanup(() => cancelAnimationFrame(frame));
	});

	function handleToggleTrack(type: TimelineTrackType, next: boolean) {
		if (type === "caption") {
			batch(() => {
				if (!project.captions) {
					setProject("captions", {
						segments: [],
						settings: { ...defaultCaptionSettings, enabled: next },
					});
				} else {
					setProject("captions", "settings", "enabled", next);
				}
				setEditorState("timeline", "tracks", "caption", next);
				if (!next && editorState.timeline.selection?.type === "caption") {
					setEditorState("timeline", "selection", null);
				}
			});
			return;
		}

		if (type === "keyboard") {
			batch(() => {
				if (!project.keyboard) {
					setProject("keyboard", {
						settings: { ...defaultKeyboardSettings, enabled: next },
					});
				} else {
					setProject("keyboard", "settings", "enabled", next);
				}
				setEditorState("timeline", "tracks", "keyboard", next);
				if (!next && editorState.timeline.selection?.type === "keyboard") {
					setEditorState("timeline", "selection", null);
				}
			});
			return;
		}

		if (type === "scene") {
			setEditorState("timeline", "tracks", "scene", next);
			return;
		}

		if (type === "text") {
			setEditorState(
				"timeline",
				"tracks",
				"text",
				next
					? Math.max(getUsedTrackCount(project.timeline?.textSegments ?? []), 1)
					: 0,
			);
			if (!next && editorState.timeline.selection?.type === "text") {
				setEditorState("timeline", "selection", null);
			}
			return;
		}

		if (type === "mask") {
			setEditorState(
				"timeline",
				"tracks",
				"mask",
				next
					? Math.max(getUsedTrackCount(project.timeline?.maskSegments ?? []), 1)
					: 0,
			);
			if (!next && editorState.timeline.selection?.type === "mask") {
				setEditorState("timeline", "selection", null);
			}
		}
	}

	function handleAddTrack(type: TimelineTrackType) {
		if (type === "text") {
			setEditorState("timeline", "tracks", "text", trackState().text + 1);
			return;
		}

		if (type === "mask") {
			setEditorState("timeline", "tracks", "mask", trackState().mask + 1);
		}
	}

	function handleDeleteTrackLane(type: "text" | "mask", laneIndex: number) {
		const resumeHistory = projectHistory.pause();
		const currentTrackCount = trackState()[type];
		const nextTextSegments =
			type === "text"
				? deleteTrackLane<TextSegment>(
						project.timeline?.textSegments ?? [],
						laneIndex,
					)
				: null;
		const nextMaskSegments =
			type === "mask"
				? deleteTrackLane<MaskSegment>(
						project.timeline?.maskSegments ?? [],
						laneIndex,
					)
				: null;
		const nextTrackCount = Math.max(
			type === "text"
				? getUsedTrackCount(nextTextSegments ?? [])
				: getUsedTrackCount(nextMaskSegments ?? []),
			currentTrackCount - 1,
			0,
		);

		batch(() => {
			if (editorState.timeline.selection?.type === type) {
				setEditorState("timeline", "selection", null);
			}

			setProject(
				produce((project) => {
					const timeline = project.timeline;
					if (!timeline) return;

					if (type === "text" && nextTextSegments) {
						timeline.textSegments = nextTextSegments;
					} else if (nextMaskSegments) {
						timeline.maskSegments = nextMaskSegments;
					}
				}),
			);
			setEditorState("timeline", "tracks", type, nextTrackCount);
		});

		resumeHistory();
	}

	function handleDeleteSingleTrack(type: "caption" | "keyboard") {
		const resumeHistory = projectHistory.pause();

		batch(() => {
			if (editorState.timeline.selection?.type === type) {
				setEditorState("timeline", "selection", null);
			}

			if (type === "caption") {
				setProject(
					produce((project) => {
						if (project.captions) {
							project.captions.segments = [];
							project.captions.settings = {
								...defaultCaptionSettings,
								...project.captions.settings,
								enabled: false,
							};
						}
						project.timeline ??= {
							segments: [{ start: 0, end: duration(), timescale: 1 }],
							zoomSegments: [],
							sceneSegments: [],
							maskSegments: [],
							textSegments: [],
							captionSegments: [],
							keyboardSegments: [],
						};
						project.timeline.captionSegments = [];
					}),
				);
				setEditorState("timeline", "tracks", "caption", false);
			} else {
				setProject(
					produce((project) => {
						if (project.keyboard) {
							project.keyboard.settings = {
								...defaultKeyboardSettings,
								...project.keyboard.settings,
								enabled: false,
							};
						}
						project.timeline ??= {
							segments: [{ start: 0, end: duration(), timescale: 1 }],
							zoomSegments: [],
							sceneSegments: [],
							maskSegments: [],
							textSegments: [],
							captionSegments: [],
							keyboardSegments: [],
						};
						project.timeline.keyboardSegments = [];
					}),
				);
				setEditorState("timeline", "tracks", "keyboard", false);
			}
		});

		resumeHistory();
	}

	async function handleOpenTrackMenu(
		e: MouseEvent,
		type: "text" | "mask",
		laneIndex: number,
	) {
		e.preventDefault();
		e.stopPropagation();

		const menu = await Menu.new({
			items: [
				await MenuItem.new({
					text: `Delete ${type === "text" ? "text" : "mask"} track`,
					action: () => handleDeleteTrackLane(type, laneIndex),
				}),
			],
		});

		menu.popup(new LogicalPosition(e.clientX, e.clientY));
	}

	onMount(() => {
		if (!project.timeline) {
			const resume = projectHistory.pause();
			setProject("timeline", {
				segments: [
					{
						timescale: 1,
						start: 0,
						end: duration(),
					},
				],
				zoomSegments: [],
				sceneSegments: [],
				maskSegments: [],
				textSegments: [],
				captionSegments: [],
				keyboardSegments: [],
			});
			resume();
		}

		const checkBounds = () => {
			if (timelineBounds.width && timelineBounds.width > 0) {
				const minSegmentPixels = 80;
				const secondsPerPixel = 1 / minSegmentPixels;
				const desiredZoom = timelineBounds.width * secondsPerPixel;

				if (transform().zoom > desiredZoom) {
					transform().updateZoom(desiredZoom, 0);
				}
			} else {
				setTimeout(checkBounds, 10);
			}
		};

		checkBounds();
	});

	if (
		!project.timeline?.zoomSegments ||
		project.timeline.zoomSegments.length < 1 ||
		!project.timeline?.maskSegments ||
		!project.timeline?.textSegments
	) {
		setProject(
			produce((project) => {
				project.timeline ??= {
					segments: [
						{
							start: 0,
							end: duration(),
							timescale: 1,
						},
					],
					zoomSegments: [],
					sceneSegments: [],
					maskSegments: [],
					textSegments: [],
					captionSegments: [],
					keyboardSegments: [],
				};
				project.timeline.sceneSegments ??= [];
				project.timeline.captionSegments ??= [];
				project.timeline.keyboardSegments ??= [];
				project.timeline.maskSegments ??= [];
				project.timeline.textSegments ??= [];
				project.timeline.zoomSegments ??= [];
			}),
		);
	}

	let zoomSegmentDragState = { type: "idle" } as ZoomSegmentDragState;
	let sceneSegmentDragState = { type: "idle" } as SceneSegmentDragState;
	let maskSegmentDragState = { type: "idle" } as MaskSegmentDragState;
	let textSegmentDragState = { type: "idle" } as TextSegmentDragState;
	let captionSegmentDragState = { type: "idle" } as CaptionSegmentDragState;
	let keyboardSegmentDragState = { type: "idle" } as KeyboardSegmentDragState;

	let pendingZoomDelta = 0;
	let pendingZoomOrigin: number | null = null;
	let zoomRafId: number | null = null;

	let pendingScrollDelta = 0;
	let scrollRafId: number | null = null;

	function flushPendingZoom() {
		if (pendingZoomDelta === 0 || pendingZoomOrigin === null) {
			zoomRafId = null;
			return;
		}

		const newZoom = transform().zoom + pendingZoomDelta;
		transform().updateZoom(newZoom, pendingZoomOrigin);

		pendingZoomDelta = 0;
		pendingZoomOrigin = null;
		zoomRafId = null;
	}

	function flushPendingScroll() {
		if (pendingScrollDelta === 0) {
			scrollRafId = null;
			return;
		}

		const newPosition = transform().position + pendingScrollDelta;
		transform().setPosition(newPosition);

		pendingScrollDelta = 0;
		scrollRafId = null;
	}

	function scheduleZoomUpdate(delta: number, origin: number) {
		pendingZoomDelta += delta;
		pendingZoomOrigin = origin;

		if (zoomRafId === null) {
			zoomRafId = requestAnimationFrame(flushPendingZoom);
		}
	}

	function scheduleScrollUpdate(delta: number) {
		pendingScrollDelta += delta;

		if (scrollRafId === null) {
			scrollRafId = requestAnimationFrame(flushPendingScroll);
		}
	}

	function getTimelineContentMetrics() {
		const container = timelineContainerRef();
		if (!container) return null;

		const rect = container.getBoundingClientRect();

		return {
			left: rect.left + TIMELINE_PADDING + TRACK_GUTTER,
			width: Math.max(
				timelineBounds.width ??
					rect.width - TIMELINE_PADDING * 2 - TRACK_GUTTER,
				0,
			),
		};
	}

	async function handleUpdatePlayhead(e: MouseEvent) {
		const metrics = getTimelineContentMetrics();
		if (
			zoomSegmentDragState.type !== "moving" &&
			sceneSegmentDragState.type !== "moving" &&
			maskSegmentDragState.type !== "moving" &&
			textSegmentDragState.type !== "moving" &&
			captionSegmentDragState.type !== "moving" &&
			keyboardSegmentDragState.type !== "moving"
		) {
			if (!metrics) return;
			const rawTime =
				secsPerPixel() * (e.clientX - metrics.left) + transform().position;
			const newTime = Math.min(Math.max(0, rawTime), totalDuration());

			// If playing, some backends require restart to seek reliably
			if (editorState.playing) {
				try {
					await commands.stopPlayback();

					// Round to nearest frame to prevent off-by-one drift
					const targetFrame = Math.round(newTime * FPS);
					await commands.seekTo(targetFrame);

					// If the user paused during these async ops, bail out without restarting
					if (!editorState.playing) {
						setEditorState("playbackTime", newTime);
						return;
					}

					await commands.startPlayback(FPS, previewResolutionBase());
					setEditorState("playing", true);
				} catch (err) {
					console.error("Failed to seek during playback:", err);
				}
			}

			setEditorState("playbackTime", newTime);
		}
	}

	createEventListener(window, "keydown", (e) => {
		const hasNoModifiers = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;

		if (
			document.activeElement instanceof HTMLInputElement ||
			document.activeElement instanceof HTMLTextAreaElement
		) {
			return;
		}

		if (e.code === "Backspace" || (e.code === "Delete" && hasNoModifiers)) {
			const selection = editorState.timeline.selection;
			if (!selection) return;

			if (selection.type === "zoom") {
				projectActions.deleteZoomSegments(selection.indices);
			} else if (selection.type === "caption") {
				projectActions.deleteCaptionSegments(selection.indices);
			} else if (selection.type === "keyboard") {
				projectActions.deleteKeyboardSegments(selection.indices);
			} else if (selection.type === "mask") {
				projectActions.deleteMaskSegments(selection.indices);
			} else if (selection.type === "text") {
				projectActions.deleteTextSegments(selection.indices);
			} else if (selection.type === "clip") {
				// Delete all selected clips in reverse order
				[...selection.indices]
					.sort((a, b) => b - a)
					.forEach((idx) => {
						projectActions.deleteClipSegment(idx);
					});
			} else if (selection.type === "scene") {
				// Delete all selected scenes in reverse order
				[...selection.indices]
					.sort((a, b) => b - a)
					.forEach((idx) => {
						projectActions.deleteSceneSegment(idx);
					});
			}
		} else if (e.code === "KeyC" && hasNoModifiers) {
			// Allow cutting while playing: use playbackTime when previewTime is null
			const time = editorState.previewTime ?? editorState.playbackTime;
			if (time === null || time === undefined) return;

			projectActions.splitClipSegment(time);
		} else if (e.code === "Escape" && hasNoModifiers) {
			// Deselect all selected segments
			setEditorState("timeline", "selection", null);
		}
	});

	const generateCaptionsFromTrack = async () => {
		if (!editorInstance) return;

		setEditorState("captions", "isGenerating", true);

		try {
			const { model, language } = getSelectedTranscriptionSettings();
			const result = await transcribeEditorCaptions(
				editorInstance.path,
				model,
				language,
			);

			if (result.segments.length < 1) {
				toast.error(
					"No captions were generated. The audio might be too quiet or unclear.",
				);
				return;
			}

			setProject(
				produce((p) => {
					applyCaptionResultToProject(
						p,
						result.segments,
						editorInstance.recordings.segments,
						duration(),
					);
				}),
			);

			setEditorState("timeline", "tracks", "caption", true);
			setEditorState("captions", "isStale", false);
			toast.success("Captions generated successfully!");
		} catch (error) {
			console.error("Error generating captions:", error);
			const errorMessage = getCaptionGenerationErrorMessage(error);
			toast.error(`Failed to generate captions: ${errorMessage}`);
		} finally {
			setEditorState("captions", "isGenerating", false);
		}
	};

	const split = () => editorState.timeline.interactMode === "split";

	const maskImage = () => {
		const pos = transform().position;
		const zoom = transform().zoom;
		const total = totalDuration();
		const secPerPx = secsPerPixel();

		const FADE_WIDTH = 32;
		const FADE_RAMP_PX = 50;
		const LEFT_OFFSET = TRACK_GUTTER;
		const RIGHT_PADDING = 0;

		// Calculate alpha for left fade (0 = fully faded, 1 = no fade)
		// When pos is 0, we are at start -> no fade needed -> strength 0
		// When pos increases, we want fade to appear -> strength 1
		const scrollLeftPx = pos / secPerPx;
		const leftFadeStrength = Math.min(1, scrollLeftPx / FADE_RAMP_PX);

		// Calculate alpha for right fade
		// When at end, right scroll is 0 -> no fade -> strength 0
		const scrollRightPx = (total - (pos + zoom)) / secPerPx;
		const rightFadeStrength = Math.min(1, scrollRightPx / FADE_RAMP_PX);

		const leftStartColor = `rgba(0, 0, 0, ${1 - leftFadeStrength})`;
		const rightEndColor = `rgba(0, 0, 0, ${1 - rightFadeStrength})`;

		// Left stops:
		// 0px to LEFT_OFFSET: Always black (icons area)
		// LEFT_OFFSET: Starts fading. If strength is 0 (start), it's black. If strength is 1, it's transparent.
		// LEFT_OFFSET + FADE_WIDTH: Always black (content fully visible)
		const leftStops = `black 0px, black ${LEFT_OFFSET}px, ${leftStartColor} ${LEFT_OFFSET}px, black ${
			LEFT_OFFSET + FADE_WIDTH
		}px`;

		// Right stops:
		// calc(100% - (RIGHT_PADDING + FADE_WIDTH)): Always black (content fully visible)
		// calc(100% - RIGHT_PADDING): Ends fading. If strength is 0 (end), it's black. If strength is 1, it's transparent.
		// 100%: Transparent
		const rightStops = `black calc(100% - ${
			RIGHT_PADDING + FADE_WIDTH
		}px), ${rightEndColor} calc(100% - ${RIGHT_PADDING}px), transparent 100%`;

		return `linear-gradient(to right, ${leftStops}, ${rightStops})`;
	};

	return (
		<TimelineContextProvider
			duration={duration()}
			secsPerPixel={secsPerPixel()}
			timelineBounds={timelineBounds}
		>
			<div
				ref={setTimelineContainerRef}
				class="pt-[2rem] relative overflow-hidden flex flex-col gap-2 h-full"
				style={{
					"padding-left": `${TIMELINE_PADDING}px`,
					"padding-right": `${TIMELINE_PADDING}px`,
					"--track-height": trackHeight(),
				}}
				onMouseDown={(e) => {
					createRoot((dispose) => {
						createEventListener(e.currentTarget, "mouseup", () => {
							handleUpdatePlayhead(e);
							if (zoomSegmentDragState.type === "idle") {
								setEditorState("timeline", "selection", null);
							}
						});
						createEventListener(window, "mouseup", () => {
							dispose();
						});
					});
				}}
				onMouseMove={(e) => {
					const metrics = getTimelineContentMetrics();
					if (editorState.playing) return;
					if (!metrics || metrics.width <= 0) return;
					const offsetX = e.clientX - metrics.left;
					if (offsetX < 0 || offsetX > metrics.width) {
						setEditorState("previewTime", null);
						return;
					}
					setEditorState(
						"previewTime",
						transform().position + secsPerPixel() * offsetX,
					);
				}}
				onMouseEnter={() => setEditorState("timeline", "hoveredTrack", null)}
				onMouseLeave={() => {
					setEditorState("previewTime", null);
				}}
				onWheel={(e) => {
					if (e.ctrlKey) {
						const zoomDelta = (e.deltaY * Math.sqrt(transform().zoom)) / 30;
						const origin = editorState.previewTime ?? editorState.playbackTime;
						scheduleZoomUpdate(zoomDelta, origin);
					} else {
						let delta: number = 0;

						if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5) {
							delta = e.deltaX;
						} else if (platform() === "macos") {
							delta = e.shiftKey ? e.deltaX : e.deltaY;
						} else {
							delta = e.deltaY;
						}

						scheduleScrollUpdate(secsPerPixel() * delta);
					}
				}}
			>
				<div
					class="relative z-20"
					style={{ height: `${TIMELINE_HEADER_HEIGHT}px` }}
				>
					<div class="absolute inset-0 flex items-end">
						<TimelineMarkings />
					</div>
					<div class="absolute bottom-0 z-30">
						<Tooltip content="Add track">
							<TrackManager
								options={trackOptions()}
								onToggle={handleToggleTrack}
								onAdd={handleAddTrack}
							/>
						</Tooltip>
					</div>
				</div>
				<Show when={!editorState.playing && editorState.previewTime}>
					{(time) => (
						<div
							class={cx(
								"flex absolute bottom-0 z-20 justify-center items-center w-px pointer-events-none bg-gradient-to-b to-[120%]",
								split() ? "from-red-300" : "from-gray-400",
							)}
							style={{
								left: `${TIMELINE_PADDING + TRACK_GUTTER}px`,
								top: `${PLAYHEAD_TOP_OFFSET}px`,
								transform: `translateX(${
									(time() - transform().position) / secsPerPixel()
								}px)`,
							}}
						>
							<div
								class={cx(
									"absolute left-1/2 top-0 size-3 -translate-x-1/2 -translate-y-2 rounded-full",
									split() ? "bg-red-300" : "bg-gray-10",
								)}
							/>
						</div>
					)}
				</Show>
				<div
					class={cx(
						"absolute bottom-0 rounded-full z-20 w-px pointer-events-none bg-gradient-to-b to-[120%] from-[rgb(226,64,64)]",
						split() && "opacity-50",
					)}
					style={{
						left: `${TIMELINE_PADDING + TRACK_GUTTER}px`,
						top: `${PLAYHEAD_TOP_OFFSET}px`,
						transform: `translateX(${Math.min(
							(editorState.playbackTime - transform().position) /
								secsPerPixel(),
							timelineBounds.width ?? 0,
						)}px)`,
					}}
				>
					<div class="size-3 bg-[rgb(226,64,64)] rounded-full -mt-2 -ml-[calc(0.37rem-0.5px)]" />
				</div>
				<div
					class="relative flex-1 min-h-0"
					style={{
						"mask-image": maskImage(),
						"-webkit-mask-image": maskImage(),
					}}
				>
					<div
						ref={setTimelineScrollRef}
						class="absolute inset-0 overflow-y-auto overflow-x-hidden pr-1"
						onWheel={(e) => {
							if (!e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
								e.stopPropagation();
							}
						}}
					>
						<div class="flex flex-col gap-2 min-h-full">
							<TrackRow icon={trackIcons.clip}>
								<ClipTrack
									ref={setTimelineRef}
									handleUpdatePlayhead={handleUpdatePlayhead}
								/>
							</TrackRow>
							<Show when={captionTrackVisible()}>
								<TrackRow
									icon={trackIcons.caption}
									onDelete={() => handleDeleteSingleTrack("caption")}
								>
									<CaptionsTrack
										onDragStateChanged={(v) => {
											captionSegmentDragState = v;
										}}
										handleUpdatePlayhead={handleUpdatePlayhead}
										onGenerate={generateCaptionsFromTrack}
										isGenerating={editorState.captions.isGenerating}
									/>
								</TrackRow>
							</Show>
							<Show when={keyboardTrackVisible()}>
								<TrackRow
									icon={trackIcons.keyboard}
									onDelete={() => handleDeleteSingleTrack("keyboard")}
								>
									<KeyboardTrack
										onDragStateChanged={(v) => {
											keyboardSegmentDragState = v;
										}}
										handleUpdatePlayhead={handleUpdatePlayhead}
									/>
								</TrackRow>
							</Show>
							<For each={textTrackRows()}>
								{(laneIndex) => (
									<TrackRow
										icon={trackIcons.text}
										onDelete={() => handleDeleteTrackLane("text", laneIndex)}
										onContextMenu={(e) =>
											handleOpenTrackMenu(e, "text", laneIndex)
										}
									>
										<TextTrack
											laneIndex={laneIndex}
											onDragStateChanged={(v) => {
												textSegmentDragState = v;
											}}
											handleUpdatePlayhead={handleUpdatePlayhead}
										/>
									</TrackRow>
								)}
							</For>
							<For each={maskTrackRows()}>
								{(laneIndex) => (
									<TrackRow
										icon={trackIcons.mask}
										onDelete={() => handleDeleteTrackLane("mask", laneIndex)}
										onContextMenu={(e) =>
											handleOpenTrackMenu(e, "mask", laneIndex)
										}
									>
										<MaskTrack
											laneIndex={laneIndex}
											onDragStateChanged={(v) => {
												maskSegmentDragState = v;
											}}
											handleUpdatePlayhead={handleUpdatePlayhead}
										/>
									</TrackRow>
								)}
							</For>
							<TrackRow icon={trackIcons.zoom}>
								<ZoomTrack
									onDragStateChanged={(v) => {
										zoomSegmentDragState = v;
									}}
									handleUpdatePlayhead={handleUpdatePlayhead}
								/>
							</TrackRow>
							<Show when={sceneTrackVisible()}>
								<TrackRow icon={trackIcons.scene}>
									<SceneTrack
										onDragStateChanged={(v) => {
											sceneSegmentDragState = v;
										}}
										handleUpdatePlayhead={handleUpdatePlayhead}
									/>
								</TrackRow>
							</Show>
						</div>
					</div>
				</div>
			</div>
		</TimelineContextProvider>
	);
}

function TrackRow(props: {
	icon: () => JSX.Element;
	children: JSX.Element;
	onDelete?: () => void;
	onContextMenu?: (e: MouseEvent) => void;
}) {
	return (
		<div
			class="group/track flex items-stretch gap-2"
			onContextMenu={props.onContextMenu}
		>
			<div class="relative">
				<TrackIcon
					icon={props.icon()}
					class={
						props.onDelete
							? "transition-opacity group-hover/track:pointer-events-none group-hover/track:opacity-0"
							: undefined
					}
				/>
				<Show when={props.onDelete}>
					<button
						class="absolute inset-0 z-20 pointer-events-none flex items-center justify-center rounded-xl border border-red-400/70 bg-red-500/90 text-white opacity-0 transition-opacity group-hover/track:pointer-events-auto group-hover/track:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							props.onDelete?.();
						}}
						onMouseDown={(e) => e.stopPropagation()}
						title="Delete track"
					>
						<IconCapTrash class="size-4" />
					</button>
				</Show>
			</div>
			<div class="flex-1 relative overflow-hidden min-w-0">
				{props.children}
			</div>
		</div>
	);
}

function TimelineMarkings() {
	const { editorState } = useEditorContext();
	const { secsPerPixel, markingResolution } = useTimelineContext();
	const transform = () => editorState.timeline.transform;

	const markingCount = () =>
		Math.ceil(2 + (transform().zoom + 5) / markingResolution());

	const markingOffset = () => transform().position % markingResolution();

	const getMarkingTime = (index: number) =>
		transform().position - markingOffset() + index * markingResolution();

	return (
		<div
			class="relative flex-1 h-4 text-xs text-gray-9"
			style={{ "margin-left": `${TRACK_GUTTER}px` }}
		>
			<Index each={Array.from({ length: markingCount() })}>
				{(_, index) => {
					const second = () => getMarkingTime(index);
					const isVisible = () => second() > 0;
					const showLabel = () => second() % 1 === 0;
					const translateX = () =>
						(second() - transform().position) / secsPerPixel() - 1;

					return (
						<div
							class="absolute left-0 bottom-1 w-1 h-1 text-center bg-current rounded-full"
							style={{
								transform: `translateX(${translateX()}px)`,
								visibility: isVisible() ? "visible" : "hidden",
							}}
						>
							<Show when={showLabel()}>
								<div class="absolute -top-[1.125rem] -translate-x-1/2">
									{formatTime(second())}
								</div>
							</Show>
						</div>
					);
				}}
			</Index>
		</div>
	);
}
