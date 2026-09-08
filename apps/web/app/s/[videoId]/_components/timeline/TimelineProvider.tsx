"use client";

import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	clampWindow,
	fullWindow,
	isFullWindow,
	panWindowBy,
	type TimelineWindow,
	zoomWindowAt,
} from "./timeline-window";

/** Where the composer is anchored on the rail. */
export interface ComposerAnchor {
	t: number;
}

interface TimelineState {
	hoveredId: string | null;
	/** Pinned card; survives pointer-out until dismissed. */
	expandedId: string | null;
	composerAnchor: ComposerAnchor | null;
}

interface TimelineActions {
	setHoveredId: (id: string | null) => void;
	setExpandedId: (id: string | null) => void;
	toggleExpandedId: (id: string) => void;
	openComposer: (t: number) => void;
	closeComposer: () => void;
	/** Above 1 zooms in. `focusT` keeps its place under the pointer. */
	zoomAtTime: (factor: number, focusT: number) => void;
	panBy: (deltaSeconds: number) => void;
	resetZoom: () => void;
	setWindow: (window: TimelineWindow) => void;
}

/** Viewport facts the band branches on. Changes are rare. */
interface TimelineEnv {
	/** Below `lg`: nodes open a bottom sheet instead of a hover card. */
	compact: boolean;
	/** Real hover pointer; gates the hover card and the "add here" ghost. */
	hasHover: boolean;
}

interface TimelineWindowValue extends TimelineWindow {
	zoomed: boolean;
}

const StateContext = createContext<TimelineState | null>(null);
const ActionsContext = createContext<TimelineActions | null>(null);
const EnvContext = createContext<TimelineEnv | null>(null);
const WindowContext = createContext<TimelineWindowValue | null>(null);
const WindowRefContext = createContext<RefObject<TimelineWindow> | null>(null);

interface TimelineProviderProps extends TimelineEnv {
	/** Latest known video duration; the window is always a slice of it. */
	duration: number;
	children: ReactNode;
}

/**
 * Timeline-local UI state, split so the pieces that only dispatch (nodes, rail,
 * ghost) never re-render when the pieces that read (cards, sheet, composer)
 * change.
 *
 * The zoom window lives here in two forms: a context value for the components
 * that re-lay out when it moves, and a ref mirror written in the same tick, so
 * playback-store subscribers can turn a time into an x position without
 * subscribing to React at all.
 */
export function TimelineProvider({
	compact,
	hasHover,
	duration,
	children,
}: TimelineProviderProps) {
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [composerAnchor, setComposerAnchor] = useState<ComposerAnchor | null>(
		null,
	);

	// null means "the whole video", which is not the same as [0, duration]
	// before the duration is known.
	const [zoomWindow, setZoomWindow] = useState<TimelineWindow | null>(null);
	const durationRef = useRef(duration);
	durationRef.current = duration;

	const windowRef = useRef<TimelineWindow>(fullWindow(duration));
	const pendingRef = useRef<TimelineWindow | null>(null);
	const hasPendingRef = useRef(false);
	const frameRef = useRef(0);

	// Gestures fire far faster than React should re-render, so the ref moves
	// immediately and the state catches up once per frame.
	const applyWindow = useCallback((next: TimelineWindow | null) => {
		windowRef.current = next ?? fullWindow(durationRef.current);
		pendingRef.current = next;
		hasPendingRef.current = true;
		if (frameRef.current !== 0) return;
		if (typeof requestAnimationFrame !== "function") {
			hasPendingRef.current = false;
			setZoomWindow(next);
			return;
		}
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = 0;
			if (!hasPendingRef.current) return;
			hasPendingRef.current = false;
			setZoomWindow(pendingRef.current);
		});
	}, []);

	useEffect(
		() => () => {
			if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
		},
		[],
	);

	const resolved = useMemo<TimelineWindowValue>(() => {
		const window = zoomWindow
			? clampWindow(zoomWindow, duration)
			: fullWindow(duration);
		return { ...window, zoomed: !isFullWindow(window, duration) };
	}, [zoomWindow, duration]);

	// Duration arrives after the first paint and a full window has to grow with
	// it. The gesture path writes the ref itself, so this only covers that case.
	useEffect(() => {
		windowRef.current = { start: resolved.start, end: resolved.end };
	}, [resolved]);

	const toggleExpandedId = useCallback((id: string) => {
		setExpandedId((prev) => (prev === id ? null : id));
	}, []);

	const openComposer = useCallback((t: number) => {
		setExpandedId(null);
		setComposerAnchor({ t });
	}, []);

	const closeComposer = useCallback(() => setComposerAnchor(null), []);

	const zoomAtTime = useCallback(
		(factor: number, focusT: number) => {
			const total = durationRef.current;
			const next = zoomWindowAt(windowRef.current, factor, focusT, total);
			applyWindow(isFullWindow(next, total) ? null : next);
		},
		[applyWindow],
	);

	const panBy = useCallback(
		(deltaSeconds: number) => {
			const total = durationRef.current;
			if (isFullWindow(windowRef.current, total)) return;
			applyWindow(panWindowBy(windowRef.current, deltaSeconds, total));
		},
		[applyWindow],
	);

	const resetZoom = useCallback(() => applyWindow(null), [applyWindow]);

	const setWindow = useCallback(
		(next: TimelineWindow) => {
			const total = durationRef.current;
			const clamped = clampWindow(next, total);
			applyWindow(isFullWindow(clamped, total) ? null : clamped);
		},
		[applyWindow],
	);

	const actions = useMemo<TimelineActions>(
		() => ({
			setHoveredId,
			setExpandedId,
			toggleExpandedId,
			openComposer,
			closeComposer,
			zoomAtTime,
			panBy,
			resetZoom,
			setWindow,
		}),
		[
			toggleExpandedId,
			openComposer,
			closeComposer,
			zoomAtTime,
			panBy,
			resetZoom,
			setWindow,
		],
	);

	const state = useMemo<TimelineState>(
		() => ({ hoveredId, expandedId, composerAnchor }),
		[hoveredId, expandedId, composerAnchor],
	);

	const env = useMemo<TimelineEnv>(
		() => ({ compact, hasHover }),
		[compact, hasHover],
	);

	return (
		<EnvContext.Provider value={env}>
			<ActionsContext.Provider value={actions}>
				<WindowRefContext.Provider value={windowRef}>
					<WindowContext.Provider value={resolved}>
						<StateContext.Provider value={state}>
							{children}
						</StateContext.Provider>
					</WindowContext.Provider>
				</WindowRefContext.Provider>
			</ActionsContext.Provider>
		</EnvContext.Provider>
	);
}

const required = <T,>(value: T | null, name: string): T => {
	if (!value)
		throw new Error(`${name} must be used inside a <TimelineProvider>`);
	return value;
};

export const useTimelineState = () =>
	required(useContext(StateContext), "useTimelineState");

export const useTimelineActions = () =>
	required(useContext(ActionsContext), "useTimelineActions");

export const useTimelineEnv = () =>
	required(useContext(EnvContext), "useTimelineEnv");

/** Re-renders when the window moves. For anything that re-lays out. */
export const useTimelineWindow = () =>
	required(useContext(WindowContext), "useTimelineWindow");

/** Never re-renders. For playback subscribers writing straight to the DOM. */
export const useTimelineWindowRef = () =>
	required(useContext(WindowRefContext), "useTimelineWindowRef");

const noopSubscribe = () => () => {};

/** `matchMedia` as an external store, so it never renders twice on mount. */
export function useMediaQuery(query: string, serverValue = false): boolean {
	const subscribe = useMemo(() => {
		if (typeof window === "undefined" || !window.matchMedia)
			return noopSubscribe;
		return (onChange: () => void) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		};
	}, [query]);

	const getSnapshot = useCallback(() => {
		if (typeof window === "undefined" || !window.matchMedia) return serverValue;
		return window.matchMedia(query).matches;
	}, [query, serverValue]);

	const getServerSnapshot = useCallback(() => serverValue, [serverValue]);

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
