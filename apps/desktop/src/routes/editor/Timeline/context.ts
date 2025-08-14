import {
	createElementBounds,
	type NullableBounds,
} from "@solid-primitives/bounds";
import { createContextProvider } from "@solid-primitives/context";
import type { Accessor } from "solid-js";
import { createStore } from "solid-js/store";

import { useEditorContext } from "../context";

export const MAX_TIMELINE_MARKINGS = 20;
const TIMELINE_MARKING_RESOLUTIONS = [0.5, 1, 2.5, 5, 10, 30];

export const [TimelineContextProvider, useTimelineContext] =
	createContextProvider(
		(props: {
			duration: number;
			secsPerPixel: number;
			timelineBounds: Readonly<NullableBounds>;
		}) => {
			const { editorState: state } = useEditorContext();

			const markingResolution = () =>
				TIMELINE_MARKING_RESOLUTIONS.find(
					(r) => state.timeline.transform.zoom / r <= MAX_TIMELINE_MARKINGS,
				) ?? 30;

			return {
				duration: () => props.duration,
				secsPerPixel: () => props.secsPerPixel,
				timelineBounds: props.timelineBounds,
				markingResolution,
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
