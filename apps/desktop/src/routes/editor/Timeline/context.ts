import {
	createElementBounds,
	type NullableBounds,
} from "@solid-primitives/bounds";
import { createContextProvider } from "@solid-primitives/context";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import { useEditorContext } from "../context";

export const MAX_TIMELINE_MARKINGS = 20;
const TIMELINE_MARKING_RESOLUTIONS = [
	0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

const SEGMENT_RENDER_PADDING = 2;

/// Narrower than this, a segment is drawn as part of its track's runs
/// instead of as its own element.
const MIN_SEGMENT_PX = 2;

type TimelineContextValue = {
	duration: Accessor<number>;
	secsPerPixel: Accessor<number>;
	/// The scroll position the tracks and ruler are laid out at. While the
	/// timeline follows playback it moves in steps, and the rest of the scroll
	/// is a translate on their content (see `timeline-follow-shift`).
	renderPosition: Accessor<number>;
	/// How far past the view, in seconds, that content must reach meanwhile.
	followExtent: Accessor<number>;
	timelineBounds: Readonly<NullableBounds>;
	markingResolution: Accessor<number>;
	visibleTimeRange: Accessor<{ start: number; end: number }>;
	isSegmentVisible(segmentStart: number, segmentEnd: number): boolean;
};

/// A segment too narrow to render on its own; the track draws these as runs.
export type CompactSegment = {
	start: number;
	end: number;
	color: string | undefined;
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
	compactSegments: Accessor<ReadonlySet<CompactSegment>>;
	registerCompactSegment(segment: CompactSegment): () => void;
	/// Segments shorter than this many seconds are compact.
	compactBelow: Accessor<number>;
};

type SegmentContextValue = {
	width: Accessor<number>;
	segment: Accessor<{ start: number; end: number }>;
};

export const [TimelineContextProvider, useTimelineContext] =
	createContextProvider(
		(props: {
			duration: number;
			secsPerPixel: number;
			timelineBounds: Readonly<NullableBounds>;
			renderPosition: number;
			followExtent: number;
		}) => {
			const { editorState: state } = useEditorContext();

			const markingResolution = createMemo(
				() =>
					TIMELINE_MARKING_RESOLUTIONS.find(
						(r) => state.timeline.transform.zoom / r <= MAX_TIMELINE_MARKINGS,
					) ?? 3600,
			);

			// Snapped outwards to a power-of-two step of about a quarter screen,
			// so segments check whether they're on screen when a scroll or pinch
			// crosses a step, not every frame.
			const visibleTimeRange = createMemo(
				() => {
					const { zoom } = state.timeline.transform;
					const position = props.renderPosition;
					const step =
						2 **
						Math.floor(Math.log2(Math.max(zoom / 4, SEGMENT_RENDER_PADDING)));
					const start =
						Math.floor((position - SEGMENT_RENDER_PADDING) / step) * step;
					const end =
						Math.ceil(
							(position + zoom + props.followExtent + SEGMENT_RENDER_PADDING) /
								step,
						) * step;
					return { start: Math.max(0, start), end };
				},
				undefined,
				{ equals: (a, b) => a.start === b.start && a.end === b.end },
			);

			const isSegmentVisible = (segmentStart: number, segmentEnd: number) => {
				const range = visibleTimeRange();
				return segmentEnd >= range.start && segmentStart <= range.end;
			};

			return {
				duration: () => props.duration,
				secsPerPixel: () => props.secsPerPixel,
				renderPosition: () => props.renderPosition,
				followExtent: () => props.followExtent,
				timelineBounds: props.timelineBounds,
				markingResolution,
				visibleTimeRange,
				isSegmentVisible,
			};
		},
		null as unknown as TimelineContextValue,
	);

export const [TrackContextProvider, useTrackContext] = createContextProvider(
	(props: { ref: Accessor<Element | undefined> }) => {
		const { editorState: state } = useEditorContext();

		const [trackState, setTrackState] = createStore({
			draggingSegment: false,
		});
		const bounds = createElementBounds(() => props.ref(), {
			trackMutation: false,
		});

		const secsPerPixel = () =>
			state.timeline.transform.zoom / (bounds.width ?? 1);

		// Quarter-octave steps: segments recheck a few dozen times across a
		// full pinch rather than every frame.
		const compactBelow = createMemo(
			() =>
				2 ** (Math.round(Math.log2(MIN_SEGMENT_PX * secsPerPixel()) * 4) / 4),
		);

		const compact = new Set<CompactSegment>();
		const [compactSegments, setCompactSegments] = createSignal<
			ReadonlySet<CompactSegment>
		>(compact, { equals: false });

		return {
			secsPerPixel,
			trackBounds: bounds,
			trackState,
			setTrackState,
			compactSegments,
			compactBelow,
			registerCompactSegment(segment: CompactSegment) {
				compact.add(segment);
				setCompactSegments(compact);
				return () => {
					compact.delete(segment);
					setCompactSegments(compact);
				};
			},
		};
	},
	null as unknown as TrackContextValue,
);

export const [SegmentContextProvider, useSegmentContext] =
	createContextProvider(
		(props: {
			width: Accessor<number>;
			segment: Accessor<{ start: number; end: number }>;
		}) => {
			return props;
		},
		null as unknown as SegmentContextValue,
	);
