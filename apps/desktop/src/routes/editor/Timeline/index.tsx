import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { platform } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	batch,
	createRoot,
	createSignal,
	For,
	type JSX,
	onMount,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";

import "./styles.css";

import Tooltip from "~/components/Tooltip";
import { commands } from "~/utils/tauri";
import {
	FPS,
	OUTPUT_SIZE,
	type TimelineTrackType,
	useEditorContext,
} from "../context";
import { formatTime } from "../utils";
import { ClipTrack } from "./ClipTrack";
import { TimelineContextProvider, useTimelineContext } from "./context";
import { type SceneSegmentDragState, SceneTrack } from "./SceneTrack";
import { TrackIcon, TrackManager } from "./TrackManager";
import { type ZoomSegmentDragState, ZoomTrack } from "./ZoomTrack";

const TIMELINE_PADDING = 16;
const TRACK_GUTTER = 64;
const TIMELINE_HEADER_HEIGHT = 32;
const TRACK_MANAGER_BUTTON_SIZE = 36;

const trackIcons: Record<TimelineTrackType, JSX.Element> = {
	clip: <IconLucideClapperboard class="size-4" />,
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
			active: definition.type === "scene" ? trackState().scene : true,
			available: definition.type === "scene" ? sceneAvailable() : true,
		}));
	const sceneTrackVisible = () => trackState().scene && sceneAvailable();

	function handleToggleTrack(type: TimelineTrackType, next: boolean) {
		if (type !== "scene") return;
		setEditorState("timeline", "tracks", "scene", next);
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
		project.timeline.zoomSegments.length < 1
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
				};
			}),
		);
	}

	let zoomSegmentDragState = { type: "idle" } as ZoomSegmentDragState;
	let sceneSegmentDragState = { type: "idle" } as SceneSegmentDragState;

	async function handleUpdatePlayhead(e: MouseEvent) {
		const { left } = timelineBounds;
		if (
			zoomSegmentDragState.type !== "moving" &&
			sceneSegmentDragState.type !== "moving"
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

					await commands.startPlayback(FPS, OUTPUT_SIZE);
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

		if (e.code === "Backspace" || (e.code === "Delete" && hasNoModifiers)) {
			const selection = editorState.timeline.selection;
			if (!selection) return;

			if (selection.type === "zoom") {
				projectActions.deleteZoomSegments(selection.indices);
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

	return (
		<TimelineContextProvider
			duration={duration()}
			secsPerPixel={secsPerPixel()}
			timelineBounds={timelineBounds}
		>
			<div
				class="pt-[2rem] relative overflow-hidden flex flex-col gap-2"
				style={{
					"padding-left": `${TIMELINE_PADDING}px`,
					"padding-right": `${TIMELINE_PADDING}px`,
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
					const { left } = timelineBounds;
					if (editorState.playing) return;
					if (left == null) return;
					setEditorState(
						"previewTime",
						transform().position + secsPerPixel() * (e.clientX - left),
					);
				}}
				onMouseEnter={() => setEditorState("timeline", "hoveredTrack", null)}
				onMouseLeave={() => {
					setEditorState("previewTime", null);
				}}
				onWheel={(e) => {
					// pinch zoom or ctrl + scroll
					if (e.ctrlKey) {
						batch(() => {
							const zoomDelta = (e.deltaY * Math.sqrt(transform().zoom)) / 30;

							const newZoom = transform().zoom + zoomDelta;

							transform().updateZoom(
								newZoom,
								editorState.previewTime ?? editorState.playbackTime,
							);
						});
					}
					// scroll
					else {
						let delta: number = 0;

						// Prioritize horizontal scrolling for touchpads
						// For touchpads, both deltaX and deltaY can be used
						// If deltaX is significant, use it (horizontal scrolling)
						if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5) {
							delta = e.deltaX;
						}
						// Otherwise use platform-specific defaults
						else if (platform() === "macos") {
							delta = e.shiftKey ? e.deltaX : e.deltaY;
						} else {
							delta = e.deltaY;
						}

						const newPosition = transform().position + secsPerPixel() * delta;

						transform().setPosition(newPosition);
					}
				}}
			>
				<div class="relative" style={{ height: `${TIMELINE_HEADER_HEIGHT}px` }}>
					<div class="absolute inset-0 flex items-end">
						<TimelineMarkings />
					</div>
					<div
						class="absolute bottom-0"
						style={{ left: `${TRACK_GUTTER - TRACK_MANAGER_BUTTON_SIZE}px` }}
					>
						<Tooltip content="Add track">
							<TrackManager
								options={trackOptions()}
								onToggle={handleToggleTrack}
							/>
						</Tooltip>
					</div>
				</div>
				<Show when={!editorState.playing && editorState.previewTime}>
					{(time) => (
						<div
							class={cx(
								"flex absolute bottom-0 z-10 justify-center items-center w-px pointer-events-none bg-gradient-to-b to-[120%]",
								split() ? "from-red-300" : "from-gray-400",
							)}
							style={{
								left: `${TIMELINE_PADDING + TRACK_GUTTER}px`,
								transform: `translateX(${
									(time() - transform().position) / secsPerPixel() - 0.5
								}px)`,
								top: `${TIMELINE_HEADER_HEIGHT}px`,
							}}
						>
							<div
								class={cx(
									"absolute -top-2 rounded-full size-3",
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
						left: `${TIMELINE_PADDING + TRACK_GUTTER}px`,
						transform: `translateX(${Math.min(
							(editorState.playbackTime - transform().position) /
								secsPerPixel(),
							timelineBounds.width ?? 0,
						)}px)`,
						top: `${TIMELINE_HEADER_HEIGHT}px`,
					}}
				>
					<div class="size-3 bg-[rgb(226,64,64)] rounded-full -mt-2 -ml-[calc(0.37rem-0.5px)]" />
				</div>
				<TrackRow icon={trackIcons.clip}>
					<ClipTrack
						ref={setTimelineRef}
						handleUpdatePlayhead={handleUpdatePlayhead}
					/>
				</TrackRow>
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

	const timelineMarkings = () => {
		const diff = transform().position % markingResolution();

		return Array.from(
			{ length: 2 + (transform().zoom + 5) / markingResolution() },
			(_, i) => transform().position - diff + (i + 0) * markingResolution(),
		);
	};

	return (
		<div
			class="relative flex-1 h-4 text-xs text-gray-9"
			style={{ "margin-left": `${TRACK_GUTTER}px` }}
		>
			<For each={timelineMarkings()}>
				{(second) => (
					<Show when={second > 0}>
						<div
							class="absolute left-0 bottom-1 w-1 h-1 text-center bg-current rounded-full"
							style={{
								transform: `translateX(${
									(second - transform().position) / secsPerPixel() - 1
								}px)`,
							}}
						>
							<Show when={second % 1 === 0}>
								<div class="absolute -top-[1.125rem] -translate-x-1/2">
									{formatTime(second)}
								</div>
							</Show>
						</div>
					</Show>
				)}
			</For>
		</div>
	);
}
