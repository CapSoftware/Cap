"use client";

import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import { useEditorContext } from "../context";

export const MAX_TIMELINE_MARKINGS = 20;
const TIMELINE_MARKING_RESOLUTIONS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const SEGMENT_RENDER_PADDING = 2;

interface TimelineBounds {
	width: number;
	height: number;
	left: number;
	top: number;
}

interface TimelineContextValue {
	duration: number;
	secsPerPixel: number;
	timelineBounds: TimelineBounds | null;
	setTimelineBounds: (bounds: TimelineBounds | null) => void;
	markingResolution: number;
	visibleTimeRange: { start: number; end: number };
	isSegmentVisible: (segmentStart: number, segmentEnd: number) => boolean;
}

const TimelineContext = createContext<TimelineContextValue | null>(null);

export function useTimelineContext() {
	const context = useContext(TimelineContext);
	if (!context) {
		throw new Error(
			"useTimelineContext must be used within TimelineContextProvider",
		);
	}
	return context;
}

interface TimelineProviderProps {
	children: React.ReactNode;
	duration: number;
}

export function TimelineContextProvider({
	children,
	duration,
}: TimelineProviderProps) {
	const { editorState } = useEditorContext();
	const [timelineBounds, setTimelineBounds] = useState<TimelineBounds | null>(
		null,
	);

	const secsPerPixel = useMemo(() => {
		if (!timelineBounds?.width) return 1;
		return editorState.timeline.transform.zoom / timelineBounds.width;
	}, [editorState.timeline.transform.zoom, timelineBounds?.width]);

	const markingResolution = useMemo(() => {
		const zoom = editorState.timeline.transform.zoom;
		return (
			TIMELINE_MARKING_RESOLUTIONS.find(
				(r) => zoom / r <= MAX_TIMELINE_MARKINGS,
			) ?? 30
		);
	}, [editorState.timeline.transform.zoom]);

	const visibleTimeRange = useMemo(() => {
		const { position, zoom } = editorState.timeline.transform;
		const start = position - SEGMENT_RENDER_PADDING;
		const end = position + zoom + SEGMENT_RENDER_PADDING;
		return { start: Math.max(0, start), end };
	}, [editorState.timeline.transform]);

	const isSegmentVisible = useCallback(
		(segmentStart: number, segmentEnd: number) => {
			return (
				segmentEnd >= visibleTimeRange.start &&
				segmentStart <= visibleTimeRange.end
			);
		},
		[visibleTimeRange],
	);

	const value: TimelineContextValue = useMemo(
		() => ({
			duration,
			secsPerPixel,
			timelineBounds,
			setTimelineBounds,
			markingResolution,
			visibleTimeRange,
			isSegmentVisible,
		}),
		[
			duration,
			secsPerPixel,
			timelineBounds,
			markingResolution,
			visibleTimeRange,
			isSegmentVisible,
		],
	);

	return (
		<TimelineContext.Provider value={value}>
			{children}
		</TimelineContext.Provider>
	);
}

interface TrackState {
	draggingSegment: boolean;
}

interface TrackContextValue {
	secsPerPixel: number;
	trackBounds: TimelineBounds | null;
	trackState: TrackState;
	setTrackState: React.Dispatch<React.SetStateAction<TrackState>>;
}

const TrackContext = createContext<TrackContextValue | null>(null);

export function useTrackContext() {
	const context = useContext(TrackContext);
	if (!context) {
		throw new Error("useTrackContext must be used within TrackContextProvider");
	}
	return context;
}

interface TrackProviderProps {
	children: React.ReactNode;
	trackRef: React.RefObject<HTMLElement | null>;
}

export function TrackContextProvider({
	children,
	trackRef,
}: TrackProviderProps) {
	const { editorState } = useEditorContext();
	const [trackState, setTrackState] = useState<TrackState>({
		draggingSegment: false,
	});
	const [trackBounds, setTrackBounds] = useState<TimelineBounds | null>(null);

	const updateBounds = useCallback(() => {
		if (trackRef.current) {
			const rect = trackRef.current.getBoundingClientRect();
			setTrackBounds({
				width: rect.width,
				height: rect.height,
				left: rect.left,
				top: rect.top,
			});
		}
	}, [trackRef]);

	const secsPerPixel = useMemo(() => {
		if (!trackBounds?.width) return 1;
		return editorState.timeline.transform.zoom / trackBounds.width;
	}, [editorState.timeline.transform.zoom, trackBounds?.width]);

	const value: TrackContextValue = useMemo(
		() => ({
			secsPerPixel,
			trackBounds,
			trackState,
			setTrackState,
		}),
		[secsPerPixel, trackBounds, trackState],
	);

	return (
		<TrackContext.Provider value={value}>
			<TrackBoundsObserver trackRef={trackRef} onBoundsChange={updateBounds} />
			{children}
		</TrackContext.Provider>
	);
}

function TrackBoundsObserver({
	trackRef,
	onBoundsChange,
}: {
	trackRef: React.RefObject<HTMLElement | null>;
	onBoundsChange: () => void;
}) {
	const observerRef = useRef<ResizeObserver | null>(null);

	useMemo(() => {
		if (typeof window === "undefined") return;

		observerRef.current = new ResizeObserver(onBoundsChange);

		if (trackRef.current) {
			observerRef.current.observe(trackRef.current);
		}

		return () => {
			observerRef.current?.disconnect();
		};
	}, [trackRef, onBoundsChange]);

	return null;
}

interface SegmentContextValue {
	width: number;
}

const SegmentContext = createContext<SegmentContextValue | null>(null);

export function useSegmentContext() {
	const context = useContext(SegmentContext);
	if (!context) {
		throw new Error(
			"useSegmentContext must be used within SegmentContextProvider",
		);
	}
	return context;
}

interface SegmentProviderProps {
	children: React.ReactNode;
	width: number;
}

export function SegmentContextProvider({
	children,
	width,
}: SegmentProviderProps) {
	const value: SegmentContextValue = useMemo(() => ({ width }), [width]);

	return (
		<SegmentContext.Provider value={value}>{children}</SegmentContext.Provider>
	);
}
