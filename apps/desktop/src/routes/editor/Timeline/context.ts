import {
	createElementBounds,
	type NullableBounds,
} from "@solid-primitives/bounds";
import { createContextProvider } from "@solid-primitives/context";
import { type Accessor, createMemo } from "solid-js";
import { createStore } from "solid-js/store";

import { useEditorContext } from "../context";

export const MAX_TIMELINE_MARKINGS = 20;
const TIMELINE_MARKING_RESOLUTIONS = [0.5, 1, 2.5, 5, 10, 30];

const SEGMENT_RENDER_PADDING = 2;

export const [TimelineContextProvider, useTimelineContext] =
	createContextProvider(
		(props: {
			duration: number;
			secsPerPixel: number;
			timelineBounds: Readonly<NullableBounds>;
		}) => {
			const { editorState: state } = useEditorContext();

			const markingResolution = createMemo(
				() =>
					TIMELINE_MARKING_RESOLUTIONS.find(
						(r) => state.timeline.transform.zoom / r <= MAX_TIMELINE_MARKINGS,
					) ?? 30,
			);

			const visibleTimeRange = createMemo(() => {
				const { transform } = state.timeline;
				const start = transform.position - SEGMENT_RENDER_PADDING;
				const end =
					transform.position + transform.zoom + SEGMENT_RENDER_PADDING;
				return { start: Math.max(0, start), end };
			});

			const isSegmentVisible = (segmentStart: number, segmentEnd: number) => {
				const range = visibleTimeRange();
				return segmentEnd >= range.start && segmentStart <= range.end;
			};

			return {
				duration: () => props.duration,
				secsPerPixel: () => props.secsPerPixel,
				timelineBounds: props.timelineBounds,
				markingResolution,
				visibleTimeRange,
				isSegmentVisible,
			};
		},
		null!,
	);

export const [TrackContextProvider, useTrackContext] = createContextProvider(
	(props: { ref: Accessor<Element | undefined> }) => {
		const { editorState: state } = useEditorContext();

		const [trackState, setTrackState] = createStore({
			draggingSegment: false,
		});
		const bounds = createElementBounds(() => props.ref());

		const secsPerPixel = () =>
			state.timeline.transform.zoom / (bounds.width ?? 1);

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
