import { For, onCleanup, Show } from "solid-js";
import { useEditorContext } from "../context";
import { editOverlayInterval } from "../style";
import { useTimelineContext } from "./context";
import { ImportedWaveformCanvas } from "./imported-waveform";
import {
	SegmentContent,
	SegmentHandle,
	SegmentLabel,
	SegmentRoot,
	TrackRoot,
} from "./Track";

export type OverlayDragState = { type: "idle" | "movePending" | "moving" };
export type OverlayTrackProps = {
	laneIndex: number;
	onDragStateChanged(value: OverlayDragState): void;
	handleUpdatePlayhead(event: MouseEvent): void;
};

export function StyleTrack(props: OverlayTrackProps) {
	return <OverlayTrack {...props} type="style" />;
}

export function OverlayTrack(
	props: OverlayTrackProps & { type: "style" | "image" | "video" },
) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		projectActions,
		projectHistory,
		importedWaveform,
		totalDuration,
	} = useEditorContext();
	const { secsPerPixel, timelineBounds } = useTimelineContext();
	const allSegments = () =>
		(props.type === "style"
			? project.timeline?.styleSegments
			: props.type === "video"
				? project.timeline?.videoSegments
				: project.timeline?.imageSegments) ?? [];
	const segments = () =>
		allSegments()
			.map((segment, index) => ({ segment, index }))
			.filter(({ segment }) => segment.track === props.laneIndex);
	const selected = (index: number) =>
		editorState.timeline.selection?.type === props.type &&
		editorState.timeline.selection.indices.includes(index);
	let endDrag: (() => void) | undefined;
	onCleanup(() => endDrag?.());

	const timeAt = (event: MouseEvent) =>
		Math.max(
			0,
			Math.min(
				totalDuration(),
				editorState.timeline.transform.position +
					(event.clientX - (timelineBounds.left ?? 0)) * secsPerPixel(),
			),
		);
	const add = (time: number) => {
		if (props.type === "style")
			projectActions.addStyleSegment(props.laneIndex, time);
		else if (props.type === "video")
			void projectActions.importVideoSegment(props.laneIndex, time);
		else void projectActions.importImageSegment(props.laneIndex, time);
	};
	function select(index: number, event: MouseEvent) {
		const previous = editorState.timeline.selection;
		let indices = [index];
		if (previous?.type === props.type) {
			if (event.metaKey || event.ctrlKey)
				indices = previous.indices.includes(index)
					? previous.indices.filter((value) => value !== index)
					: [...previous.indices, index];
			else if (event.shiftKey) {
				const anchor = previous.indices[previous.indices.length - 1] ?? index;
				indices = segments()
					.filter(
						(item) =>
							item.index >= Math.min(anchor, index) &&
							item.index <= Math.max(anchor, index),
					)
					.map((item) => item.index);
			}
		}
		setEditorState(
			"timeline",
			"selection",
			indices.length ? { type: props.type, indices } : null,
		);
		const segment = allSegments()[index];
		if (segment) {
			setEditorState("previewTime", null);
			setEditorState(
				"playbackTime",
				Math.min(
					Math.max(editorState.playbackTime, segment.start),
					segment.end - 0.001,
				),
			);
		}
	}
	function drag(
		event: MouseEvent,
		index: number,
		edge: "start" | "move" | "end",
	) {
		event.stopPropagation();
		if (event.button !== 0) return;
		if (editorState.timeline.interactMode === "split") {
			projectActions.splitOverlaySegment(props.type, index, timeAt(event));
			return;
		}
		event.preventDefault();
		select(index, event);
		if (event.metaKey || event.ctrlKey || event.shiftKey) return;
		endDrag?.();
		const segment = allSegments()[index];
		if (!segment) return;
		const initial = { start: segment.start, end: segment.end };
		const originalVideo =
			props.type === "video"
				? project.timeline?.videoSegments[index]
				: undefined;
		const initialSourceStart = originalVideo?.sourceStart ?? 0;
		const initialPlaybackTime = editorState.playbackTime;
		const lane = segments();
		const position = lane.findIndex((item) => item.index === index);
		const previousEnd = Math.max(
			lane[position - 1]?.segment.end ?? 0,
			props.type === "video" && edge === "start"
				? segment.start - initialSourceStart
				: 0,
		);
		const nextStart =
			props.type === "video"
				? Math.min(
						lane[position + 1]?.segment.start ?? Number.POSITIVE_INFINITY,
						edge === "end" && originalVideo
							? segment.start +
									originalVideo.sourceDuration -
									initialSourceStart
							: Number.POSITIVE_INFINITY,
					)
				: (lane[position + 1]?.segment.start ?? totalDuration());
		const resume = projectHistory.pause();
		let moved = false;
		props.onDragStateChanged({ type: "movePending" });
		const move = (next: MouseEvent) => {
			if (allSegments()[index] !== segment) return;
			if (!moved && Math.abs(next.clientX - event.clientX) < 2) return;
			moved = true;
			props.onDragStateChanged({ type: "moving" });
			const interval = editOverlayInterval(
				initial,
				(next.clientX - event.clientX) * secsPerPixel(),
				edge,
				previousEnd,
				nextStart,
			);
			if (props.type === "style")
				setProject("timeline", "styleSegments", index, interval);
			else if (props.type === "video")
				setProject("timeline", "videoSegments", index, {
					...interval,
					sourceStart:
						initialSourceStart +
						(edge === "start" ? interval.start - initial.start : 0),
				});
			else setProject("timeline", "imageSegments", index, interval);
			setEditorState("previewTime", null);
			setEditorState(
				"playbackTime",
				edge === "end" ? interval.end - 0.001 : interval.start,
			);
		};
		const finish = (next?: MouseEvent, cancelled = false) => {
			if (!endDrag) return;
			if (next) move(next);
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", finish);
			window.removeEventListener("blur", cancel);
			window.removeEventListener("keydown", keydown, true);
			endDrag = undefined;
			if (cancelled && moved && allSegments()[index] === segment) {
				if (props.type === "style")
					setProject("timeline", "styleSegments", index, initial);
				else if (props.type === "video")
					setProject("timeline", "videoSegments", index, {
						...initial,
						sourceStart: initialSourceStart,
					});
				else setProject("timeline", "imageSegments", index, initial);
				setEditorState("playbackTime", initialPlaybackTime);
			}
			resume();
			props.onDragStateChanged({ type: "idle" });
		};
		const cancel = () => finish(undefined, true);
		const keydown = (next: KeyboardEvent) => {
			if (next.key !== "Escape") return;
			next.preventDefault();
			next.stopImmediatePropagation();
			cancel();
		};
		endDrag = cancel;
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", finish);
		window.addEventListener("blur", cancel);
		window.addEventListener("keydown", keydown, true);
	}

	return (
		<TrackRoot
			onDblClick={(event) => {
				if (!(event.target as HTMLElement).closest("[data-overlay-segment]")) {
					event.stopPropagation();
					add(timeAt(event));
				}
			}}
		>
			<Show when={segments().length === 0}>
				<button
					type="button"
					disabled={
						(props.type === "image" && editorState.importingImage) ||
						(props.type === "video" && editorState.importingVideo)
					}
					class="cap-empty-lane pointer-events-auto"
					onMouseDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						add(editorState.playbackTime);
					}}
				>
					<Show
						when={props.type !== "style"}
						fallback={
							<>
								<span>
									Change background, camera and cursor for part of your video
								</span>
								<span class="cap-empty-lane-action">· Add style</span>
							</>
						}
					>
						<span>
							{props.type === "video"
								? "Add video to the timeline"
								: "Place images and logos on your video"}
						</span>
						<span class="cap-empty-lane-action">
							{props.type === "video"
								? editorState.importingVideo
									? "· Importing video…"
									: "· Add video"
								: editorState.importingImage
									? "· Importing image…"
									: "· Add image"}
						</span>
					</Show>
				</button>
			</Show>
			<For each={segments()}>
				{({ segment, index }) => (
					<SegmentRoot
						segment={segment}
						data-overlay-segment
						data-index={index}
						segColor={`var(--track-${props.type})`}
						class="group"
						selected={selected(index)}
						muted={!segment.enabled}
						title={`${segment.name} · ${(segment.end - segment.start).toFixed(2)}s`}
					>
						<SegmentHandle
							position="start"
							onMouseDown={(event) => drag(event, index, "start")}
						/>
						<SegmentContent
							class="cursor-grab overflow-hidden"
							onMouseDown={(event) => drag(event, index, "move")}
						>
							<Show when={props.type === "video"}>
								<ImportedWaveformCanvas
									waveform={importedWaveform(
										project.timeline?.videoSegments[index]?.path ?? "",
									)}
									start={segment.start}
									end={segment.end}
									sourceStart={
										project.timeline?.videoSegments[index]?.sourceStart ?? 0
									}
									volumeDb={
										project.timeline?.videoSegments[index]?.volumeDb ?? 0
									}
									enabled={
										segment.enabled &&
										!(project.timeline?.videoSegments[index]?.muted ?? true)
									}
									color="var(--track-video)"
								/>
							</Show>
							<SegmentLabel
								full={() => (
									<div class="cap-seg-labels">
										<span class="cap-seg-label truncate">{segment.name}</span>
										<span class="cap-seg-sublabel">
											{`${(segment.end - segment.start).toFixed(1)}s`}
										</span>
									</div>
								)}
								compact={() => (
									<span class="cap-seg-label truncate">{segment.name}</span>
								)}
							/>
						</SegmentContent>
						<SegmentHandle
							position="end"
							onMouseDown={(event) => drag(event, index, "end")}
						/>
					</SegmentRoot>
				)}
			</For>
		</TrackRoot>
	);
}
