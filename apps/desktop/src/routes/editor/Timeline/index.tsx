import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { platform } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { batch, createRoot, createSignal, For, onMount, Show } from "solid-js";
import { produce } from "solid-js/store";

import "./styles.css";

import { commands } from "~/utils/tauri";
import { FPS, OUTPUT_SIZE, useEditorContext } from "../context";
import { formatTime } from "../utils";
import { ClipTrack } from "./ClipTrack";
import { TimelineContextProvider, useTimelineContext } from "./context";
import { type SceneSegmentDragState, SceneTrack } from "./SceneTrack";
import { type ZoomSegmentDragState, ZoomTrack } from "./ZoomTrack";

const TIMELINE_PADDING = 16;

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
				projectActions.deleteClipSegment(selection.index);
			} else if (selection.type === "scene") {
				projectActions.deleteSceneSegment(selection.index);
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
					setEditorState(
						"previewTime",
						transform().position + secsPerPixel() * (e.clientX - left!),
					);
				}}
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
				<TimelineMarkings />
				<Show when={!editorState.playing && editorState.previewTime}>
					{(time) => (
						<div
							class={cx(
								"flex absolute bottom-0 top-4 left-5 z-10 justify-center items-center w-px pointer-events-none bg-gradient-to-b to-[120%]",
								split() ? "from-red-300" : "from-gray-400",
							)}
							style={{
								left: `${TIMELINE_PADDING}px`,
								transform: `translateX(${
									(time() - transform().position) / secsPerPixel()
								}px)`,
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
						"absolute bottom-0 top-4 h-full rounded-full z-10 w-px pointer-events-none bg-gradient-to-b to-[120%] from-[rgb(226,64,64)]",
						split() && "opacity-50",
					)}
					style={{
						left: `${TIMELINE_PADDING}px`,
						transform: `translateX(${Math.min(
							(editorState.playbackTime - transform().position) /
								secsPerPixel(),
							timelineBounds.width ?? 0,
						)}px)`,
					}}
				>
					<div class="size-3 bg-[rgb(226,64,64)] rounded-full -mt-2 -ml-[calc(0.37rem-0.5px)]" />
				</div>
				<ClipTrack
					ref={setTimelineRef}
					handleUpdatePlayhead={handleUpdatePlayhead}
				/>
				<ZoomTrack
					onDragStateChanged={(v) => {
						zoomSegmentDragState = v;
					}}
					handleUpdatePlayhead={handleUpdatePlayhead}
				/>
				<Show when={meta().hasCamera && !project.camera.hide}>
					<SceneTrack
						onDragStateChanged={(v) => {
							sceneSegmentDragState = v;
						}}
						handleUpdatePlayhead={handleUpdatePlayhead}
					/>
				</Show>
			</div>
		</TimelineContextProvider>
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
		<div class="relative h-4 text-xs text-gray-9">
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
