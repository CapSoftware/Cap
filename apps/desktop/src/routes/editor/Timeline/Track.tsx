import { mergeRefs } from "@solid-primitives/refs";
import { cx } from "cva";
import {
	type Accessor,
	type ComponentProps,
	createMemo,
	createSignal,
	type JSX,
	Match,
	Show,
	Switch,
	splitProps,
} from "solid-js";
import { useEditorContext } from "../context";
import {
	SegmentContextProvider,
	TrackContextProvider,
	useSegmentContext,
	useTimelineContext,
	useTrackContext,
} from "./context";

export const CAP_TRACK_FILL_CLASS = "cap-track-fill";

export function TrackRoot(props: ComponentProps<"div">) {
	const [ref, setRef] = createSignal<HTMLDivElement>();
	const height = "var(--track-height, 3.25rem)";
	const style =
		typeof props.style === "string"
			? `${props.style};height:${height}`
			: { height, ...(props.style ?? {}) };

	return (
		<TrackContextProvider ref={ref}>
			<div
				{...props}
				ref={mergeRefs(setRef, props.ref)}
				class={cx("flex flex-row relative", props.class)}
				style={style}
			>
				{props.children}
			</div>
		</TrackContextProvider>
	);
}

export function useSegmentTranslateX(
	segment: () => { start: number; end: number },
) {
	const { editorState: state } = useEditorContext();
	const { secsPerPixel } = useTrackContext();

	return createMemo(() => {
		const base = state.timeline.transform.position;

		const delta = segment().start;

		return (delta - base) / secsPerPixel();
	});
}

export function useSegmentWidth(segment: () => { start: number; end: number }) {
	const { secsPerPixel } = useTrackContext();

	return () => (segment().end - segment().start) / secsPerPixel();
}

export function SegmentRoot(
	props: ComponentProps<"div"> & {
		innerClass: string;
		segColor?: string;
		segment: { start: number; end: number };
		forceVisible?: boolean;
		onMouseDown?: (
			e: MouseEvent & { currentTarget: HTMLDivElement; target: Element },
		) => void;
	},
) {
	const [local, rest] = splitProps(props, [
		"innerClass",
		"segColor",
		"segment",
		"forceVisible",
		"onMouseDown",
		"class",
		"style",
		"ref",
		"children",
	]);
	const { editorState } = useEditorContext();
	const { isSegmentVisible } = useTimelineContext();
	const translateX = useSegmentTranslateX(() => local.segment);
	const width = useSegmentWidth(() => local.segment);
	const visible = createMemo(
		() =>
			local.forceVisible ||
			isSegmentVisible(local.segment.start, local.segment.end),
	);

	return (
		<Show when={visible()}>
			<SegmentContextProvider width={width} segment={() => local.segment}>
				<div
					{...rest}
					class={cx(
						"absolute overflow-visible border rounded-xl inset-y-0",
						editorState.timeline.interactMode === "split" &&
							"timeline-scissors-cursor",
						local.class,
					)}
					style={{
						"--segment-x": `${translateX()}px`,
						transform: "translateX(var(--segment-x))",
						width: `${width()}px`,
						...(typeof local.style === "object" ? local.style : {}),
					}}
					onMouseDown={local.onMouseDown}
					ref={local.ref}
				>
					<div
						class={cx(
							CAP_TRACK_FILL_CLASS,
							"relative h-full flex flex-row rounded-xl overflow-hidden group",
							local.innerClass,
						)}
						style={
							local.segColor
								? ({ "--seg-color": local.segColor } as Record<string, string>)
								: undefined
						}
					>
						{local.children}
					</div>
				</div>
			</SegmentContextProvider>
		</Show>
	);
}

export const SEGMENT_LABEL_FULL_PX = 100;
export const SEGMENT_LABEL_COMPACT_PX = 48;

// Pixel box of the segment's intersection with the viewport, in
// segment-local coordinates, with a clamped center for label anchoring.
// A zoomed-in segment can extend well past the viewport, so its true
// centre is often off-screen; labels anchor to this instead.
export function useSegmentVisibleBox(): Accessor<{
	width: number;
	centerX: number;
}> {
	const { width, segment } = useSegmentContext();
	const { secsPerPixel } = useTrackContext();
	const { editorState } = useEditorContext();

	return createMemo(() => {
		const segmentWidth = width();
		const { transform } = editorState.timeline;

		const leftPx = (segment().start - transform.position) / secsPerPixel();
		const viewportPx = transform.zoom / secsPerPixel();

		const visibleStart = Math.max(0, -leftPx);
		const visibleEnd = Math.min(segmentWidth, viewportPx - leftPx);
		const visibleWidth = Math.max(0, visibleEnd - visibleStart);

		// Keep the label inside the segment box, but when only a small slice
		// of a wide segment is on screen the margin must shrink with it, or
		// the clamp would push the label out of view past the viewport edge.
		const margin = Math.min(
			60,
			segmentWidth / 2,
			Math.max(visibleWidth / 2, 4),
		);
		const centerX = Math.min(
			Math.max((visibleStart + visibleEnd) / 2, margin),
			segmentWidth - margin,
		);

		return { width: visibleWidth, centerX };
	});
}

// Progressive disclosure for segment labels: the label degrades from its
// full form down to a compact row and then to a state glyph as the visible
// slice of the segment shrinks, rather than vanishing at a hard cliff.
export function SegmentLabel(props: {
	full: () => JSX.Element;
	compact?: () => JSX.Element;
	glyph?: () => JSX.Element;
	fullAt?: number;
	compactAt?: number;
}) {
	const visibleBox = useSegmentVisibleBox();

	const fullAt = () => props.fullAt ?? SEGMENT_LABEL_FULL_PX;
	const compactAt = () => props.compactAt ?? SEGMENT_LABEL_COMPACT_PX;

	return (
		<div
			class="absolute pointer-events-none"
			style={{
				left: `${visibleBox().centerX}px`,
				top: "50%",
				transform: "translate(-50%, -50%)",
				"max-width": `${Math.max(0, visibleBox().width - 8)}px`,
				overflow: "hidden",
			}}
		>
			<Switch>
				<Match when={visibleBox().width >= fullAt()}>{props.full()}</Match>
				<Match when={visibleBox().width >= compactAt() && !!props.compact}>
					{props.compact?.()}
				</Match>
				<Match when={visibleBox().width >= 16 && !!props.glyph}>
					{props.glyph?.()}
				</Match>
			</Switch>
		</div>
	);
}

export function SegmentContent(props: ComponentProps<"div">) {
	const ctx = useSegmentContext();
	return (
		<div
			{...props}
			class={cx(
				"relative w-full h-full flex flex-row items-center py-1",
				ctx.width() < 100 ? "px-0" : "px-2",
				props.class,
			)}
		/>
	);
}

export function SegmentHandle(
	props: ComponentProps<"div"> & { position: "start" | "end" },
) {
	const ctx = useSegmentContext();
	const compact = () => ctx.width() < 40;

	return (
		<div
			{...props}
			class={cx(
				"absolute inset-y-0 z-10 flex w-5 cursor-col-resize items-center justify-center transition-opacity",
				props.position === "start"
					? "left-0 -translate-x-1/2"
					: "right-0 translate-x-1/2",
				compact() ? "opacity-55" : "opacity-35 group-hover:opacity-100",
				props.class,
			)}
			data-compact={compact()}
		>
			<div class="w-[3px] h-8 bg-solid-white rounded-full" />
		</div>
	);
}

export function useSetPreviewTime() {
	const { totalDuration, setEditorState } = useEditorContext();

	return (time: number) => {
		setEditorState("previewTime", Math.min(Math.max(0, time), totalDuration()));
	};
}
