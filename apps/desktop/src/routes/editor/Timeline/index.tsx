import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { platform } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	createRoot,
	createSignal,
	Index,
	type JSX,
	onMount,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";

import "./styles.css";

import Tooltip from "~/components/Tooltip";
import { commands } from "~/utils/tauri";
import { FPS, type TimelineTrackType, useEditorContext } from "../context";
import { formatTime } from "../utils";
import { ClipTrack } from "./ClipTrack";
import { TimelineContextProvider, useTimelineContext } from "./context";
import { type MaskSegmentDragState, MaskTrack } from "./MaskTrack";
import { type SceneSegmentDragState, SceneTrack } from "./SceneTrack";
import { type TextSegmentDragState, TextTrack } from "./TextTrack";
import { TrackIcon, TrackManager } from "./TrackManager";
import { type ZoomSegmentDragState, ZoomTrack } from "./ZoomTrack";

const TIMELINE_PADDING = 16;
const TRACK_GUTTER = 64;
const TIMELINE_HEADER_HEIGHT = 32;

const trackIcons: Record<TimelineTrackType, JSX.Element> = {
	clip: <IconLucideClapperboard class="size-4" />,
	text: <IconLucideType class="size-4" />,
	mask: <IconLucideBoxSelect class="size-4" />,
	zoom: <IconLucideSearch class="size-4" />,
	scene: <IconLucideVideo class="size-4" />,
};

type TrackDefinition = {
	type: TimelineTrackType;
	label: string;
	icon: JSX.Element;
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

export function Timeline() {
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

	const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
	const timelineBounds = createElementBounds(timelineRef);

	const secsPerPixel = () => transform().zoom / (timelineBounds.width ?? 1);

	const trackState = () => editorState.timeline.tracks;
	const sceneAvailable = () => meta().hasCamera && !project.camera.hide;
	const trackOptions = () =>
		trackDefinitions.map((definition) => ({
			...definition,
			active:
				definition.type === "scene"
					? trackState().scene
					: definition.type === "mask"
						? trackState().mask
						: definition.type === "text"
							? trackState().text
							: true,
			available: definition.type === "scene" ? sceneAvailable() : true,
		}));
	const sceneTrackVisible = () => trackState().scene && sceneAvailable();
	const visibleTrackCount = () =>
		2 +
		(trackState().text ? 1 : 0) +
		(trackState().mask ? 1 : 0) +
		(sceneTrackVisible() ? 1 : 0);
	const trackHeight = () => (visibleTrackCount() > 2 ? "3rem" : "3.25rem");

	function handleToggleTrack(type: TimelineTrackType, next: boolean) {
		if (type === "scene") {
			setEditorState("timeline", "tracks", "scene", next);
			return;
		}

		if (type === "text") {
			setEditorState("timeline", "tracks", "text", next);
			if (!next && editorState.timeline.selection?.type === "text") {
				setEditorState("timeline", "selection", null);
			}
			return;
		}

		if (type === "mask") {
			setEditorState("timeline", "tracks", "mask", next);
			if (!next && editorState.timeline.selection?.type === "mask") {
				setEditorState("timeline", "selection", null);
			}
		}
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
				project.timeline.maskSegments ??= [];
				project.timeline.textSegments ??= [];
				project.timeline.zoomSegments ??= [];
				project.timeline.captionSegments ??= [];
				project.timeline.keyboardSegments ??= [];
			}),
		);
	}

	let zoomSegmentDragState = { type: "idle" } as ZoomSegmentDragState;
	let sceneSegmentDragState = { type: "idle" } as SceneSegmentDragState;
	let maskSegmentDragState = { type: "idle" } as MaskSegmentDragState;
	let textSegmentDragState = { type: "idle" } as TextSegmentDragState;

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

	async function handleUpdatePlayhead(e: MouseEvent) {
		const { left } = timelineBounds;
		if (
			zoomSegmentDragState.type !== "moving" &&
			sceneSegmentDragState.type !== "moving" &&
			maskSegmentDragState.type !== "moving" &&
			textSegmentDragState.type !== "moving"
		) {
			// Guard against missing bounds and clamp computed time to [0, totalDuration()]
			if (left == null) return;
			const rawTime =
				secsPerPixel() * (e.clientX - left) + transform().position;
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

	const split = () => editorState.timeline.interactMode === "split";

	const maskImage = () => {
		const pos = transform().position;
		const zoom = transform().zoom;
		const total = totalDuration();
		const secPerPx = secsPerPixel();

		const FADE_WIDTH = 32;
		const FADE_RAMP_PX = 50;
		const LEFT_OFFSET = TIMELINE_PADDING + TRACK_GUTTER;
		const RIGHT_PADDING = TIMELINE_PADDING;

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
				class="pt-[2rem] relative overflow-hidden flex flex-col gap-2 h-full"
				style={{
					"padding-left": `${TIMELINE_PADDING}px`,
					"padding-right": `${TIMELINE_PADDING}px`,
					"mask-image": maskImage(),
					"-webkit-mask-image": maskImage(),
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
					const { left, width } = timelineBounds;
					if (editorState.playing) return;
					if (left == null || !width || width <= 0) return;
					const offsetX = e.clientX - left;
					if (offsetX < 0 || offsetX > width) {
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
				<div class="relative" style={{ height: `${TIMELINE_HEADER_HEIGHT}px` }}>
					<div class="absolute inset-0 flex items-end">
						<TimelineMarkings />
					</div>
					<div class="absolute bottom-0">
						<Tooltip content="Add track">
							<TrackManager
								options={trackOptions()}
								onToggle={handleToggleTrack}
							/>
						</Tooltip>
					</div>
				</div>
				<div class="relative flex-1 min-h-0">
					<Show when={!editorState.playing && editorState.previewTime}>
						{(time) => (
							<div
								class={cx(
									"flex absolute bottom-0 z-10 justify-center items-center w-px pointer-events-none bg-gradient-to-b to-[120%]",
									split() ? "from-red-300" : "from-gray-400",
								)}
								style={{
									left: `${TRACK_GUTTER}px`,
									transform: `translateX(${
										(time() - transform().position) / secsPerPixel() - 0.5
									}px)`,
									top: "0px",
								}}
							>
								<div
									class={cx(
										"absolute -top-2 rounded-full size-3 -ml-[calc(0.37rem-0.5px)]",
										split() ? "bg-red-300" : "bg-gray-10",
									)}
								/>
							</div>
						)}
					</Show>
					<div
						class={cx(
							"absolute bottom-0 h-full rounded-full z-10 w-px pointer-events-none bg-gradient-to-b to-[120%] from-[rgb(226,64,64)]",
							split() && "opacity-50",
						)}
						style={{
							left: `${TRACK_GUTTER}px`,
							transform: `translateX(${Math.min(
								(editorState.playbackTime - transform().position) /
									secsPerPixel(),
								timelineBounds.width ?? 0,
							)}px)`,
							top: "0px",
						}}
					>
						<div class="size-3 bg-[rgb(226,64,64)] rounded-full -mt-2 -ml-[calc(0.37rem-0.5px)]" />
					</div>
					<div
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
							<Show when={trackState().text}>
								<TrackRow icon={trackIcons.text}>
									<TextTrack
										onDragStateChanged={(v) => {
											textSegmentDragState = v;
										}}
										handleUpdatePlayhead={handleUpdatePlayhead}
									/>
								</TrackRow>
							</Show>
							<Show when={trackState().mask}>
								<TrackRow icon={trackIcons.mask}>
									<MaskTrack
										onDragStateChanged={(v) => {
											maskSegmentDragState = v;
										}}
										handleUpdatePlayhead={handleUpdatePlayhead}
									/>
								</TrackRow>
							</Show>
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

function TrackRow(props: { icon: JSX.Element; children: JSX.Element }) {
	return (
		<div class="flex items-stretch gap-2">
			<TrackIcon icon={props.icon} />
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
