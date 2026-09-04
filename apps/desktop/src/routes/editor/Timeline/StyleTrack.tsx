import { For, onCleanup, Show } from "solid-js";
import { useEditorContext } from "../context";
import { editOverlayInterval } from "../style";
import { useTimelineContext } from "./context";
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
	props: OverlayTrackProps & { type: "style" | "image" },
) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		projectActions,
		projectHistory,
		totalDuration,
	} = useEditorContext();
	const { secsPerPixel, timelineBounds } = useTimelineContext();
	const allSegments = () =>
		(props.type === "style"
			? project.timeline?.styleSegments
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
		const lane = segments();
		const position = lane.findIndex((item) => item.index === index);
		const previousEnd = lane[position - 1]?.segment.end ?? 0;
		const nextStart = lane[position + 1]?.segment.start ?? totalDuration();
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
			else setProject("timeline", "imageSegments", index, interval);
			setEditorState("previewTime", null);
			setEditorState(
				"playbackTime",
				edge === "end" ? interval.end - 0.001 : interval.start,
			);
		};
		const finish = (next?: MouseEvent) => {
			if (!endDrag) return;
			if (next) move(next);
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", finish);
			window.removeEventListener("blur", cancel);
			endDrag = undefined;
			resume();
			props.onDragStateChanged({ type: "idle" });
		};
		const cancel = () => finish();
		endDrag = cancel;
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", finish);
		window.addEventListener("blur", cancel);
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
					disabled={props.type === "image" && editorState.importingImage}
					class="sticky left-3 self-center mx-3 rounded-md border border-gray-5 bg-gray-2 px-3 py-1 text-xs text-gray-12 hover:bg-gray-3 disabled:opacity-50"
					onMouseDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						add(editorState.playbackTime);
					}}
				>
					{props.type === "image"
						? editorState.importingImage
							? "Importing image…"
							: "+ Add image"
						: "+ Add style"}
				</button>
			</Show>
			<For each={segments()}>
				{({ segment, index }) => (
					<SegmentRoot
						segment={segment}
						data-overlay-segment
						data-index={index}
						segColor={`var(--track-${props.type})`}
						innerClass="ring-blue-6"
						class={`border ${selected(index) ? "border-blue-7" : "border-transparent"} ${segment.enabled ? "" : "opacity-50"}`}
						title={`${segment.name} · ${(segment.end - segment.start).toFixed(2)}s`}
					>
						<SegmentHandle
							position="start"
							onMouseDown={(event) => drag(event, index, "start")}
						/>
						<SegmentContent
							class="cursor-grab overflow-hidden px-3"
							onMouseDown={(event) => drag(event, index, "move")}
						>
							<SegmentLabel
								full={() => (
									<span class="truncate text-xs text-white">
										{segment.name}
									</span>
								)}
								compact={() => (
									<span class="truncate text-[10px] text-white">
										{segment.name}
									</span>
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
