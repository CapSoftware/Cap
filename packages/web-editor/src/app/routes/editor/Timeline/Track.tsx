import { mergeRefs } from "@solid-primitives/refs";
import { cx } from "cva";
import {
	type Accessor,
	type ComponentProps,
	createEffect,
	createMemo,
	createSignal,
	type JSX,
	Match,
	onCleanup,
	onMount,
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
import {
	type IndexedSelectionType,
	nextSegmentSelection,
} from "./segment-selection";

export const CAP_TRACK_FILL_CLASS = "cap-track-fill";

export function TrackRoot(props: ComponentProps<"div">) {
	const [ref, setRef] = createSignal<HTMLDivElement>();
	const height = "var(--track-height, 44px)";
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
				data-track-root
			>
				<div class="timeline-follow-shift absolute inset-0 flex flex-row">
					<CompactSegmentRuns />
					{props.children}
				</div>
			</div>
		</TrackContextProvider>
	);
}

const RUN_GAP_PX = 1;
const RUN_ZOOM_STEP = 8;
const RUN_HIT_SLOP_PX = 2;

function CompactSegmentRuns() {
	const { editorState } = useEditorContext();
	const { secsPerPixel, trackBounds, compactSegments } = useTrackContext();
	const { renderPosition, followExtent } = useTimelineContext();
	let canvas: HTMLCanvasElement | undefined;
	let runs: [number, number][] = [];

	const trackRoot = () => canvas?.closest<HTMLElement>("[data-track-root]");
	const runAt = (event: MouseEvent) => {
		const track = trackRoot();
		if (!canvas || event.target !== track) return null;
		const x = event.clientX - canvas.getBoundingClientRect().left;
		return runs.some(
			([start, end]) =>
				x >= start - RUN_HIT_SLOP_PX && x <= end + RUN_HIT_SLOP_PX,
		)
			? x
			: null;
	};

	onMount(() => {
		const track = trackRoot();
		if (!track) return;
		let hovering = false;
		const onMouseDown = (event: MouseEvent) => {
			if (event.button !== 0) return;
			const x = runAt(event);
			if (x === null) return;
			event.stopPropagation();
			event.preventDefault();
			const { transform } = editorState.timeline;
			transform.updateZoom(
				transform.zoom / RUN_ZOOM_STEP,
				renderPosition() + x * secsPerPixel(),
			);
		};
		const onMouseMove = (event: MouseEvent) => {
			const over = runAt(event) !== null;
			if (over === hovering) return;
			hovering = over;
			track.style.cursor = over ? "zoom-in" : "";
		};
		track.addEventListener("mousedown", onMouseDown, { capture: true });
		track.addEventListener("mousemove", onMouseMove);
		onCleanup(() => {
			track.removeEventListener("mousedown", onMouseDown, { capture: true });
			track.removeEventListener("mousemove", onMouseMove);
		});
	});

	createEffect(() => {
		const segments = compactSegments();
		const ctx = canvas?.getContext("2d");
		runs = [];
		if (!canvas || !ctx) return;
		const width =
			(trackBounds.width ?? 0) +
			(trackBounds.width ? followExtent() / secsPerPixel() : 0);
		const height = trackBounds.height ?? 0;
		if (segments.size === 0 || width <= 0 || height <= 0) {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		const pixelWidth = Math.round(width * dpr);
		const pixelHeight = Math.round(height * dpr);
		if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
		if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const position = renderPosition();
		const perPixel = secsPerPixel();
		const byColor = new Map<string | undefined, [number, number][]>();
		for (const segment of segments) {
			const x0 = (segment.start - position) / perPixel;
			const x1 = (segment.end - position) / perPixel;
			if (x1 < 0 || x0 > width) continue;
			let spans = byColor.get(segment.color);
			if (!spans) {
				spans = [];
				byColor.set(segment.color, spans);
			}
			spans.push([x0, x1]);
		}

		const style = getComputedStyle(canvas);
		const fallback = style.getPropertyValue("--ed-text-3").trim();
		ctx.lineWidth = 1;
		for (const [color, spans] of byColor) {
			const variable = color?.match(/var\((--[^)]+)\)/)?.[1];
			const resolved =
				(variable ? style.getPropertyValue(variable).trim() : color) ||
				fallback;
			ctx.fillStyle = resolved;
			ctx.strokeStyle = resolved;
			spans.sort((a, b) => a[0] - b[0]);
			let [runStart, runEnd] = spans[0] as [number, number];
			const fill = () => {
				const x = Math.max(runStart, 0);
				const w = Math.max(Math.min(runEnd, width) - x, 1);
				runs.push([x, x + w]);
				if (w < 4) {
					ctx.globalAlpha = 0.5;
					ctx.fillRect(x, 2, w, height - 4);
					return;
				}
				ctx.beginPath();
				ctx.roundRect(x + 0.5, 2.5, w - 1, height - 5, 6);
				ctx.globalAlpha = 0.18;
				ctx.fill();
				ctx.globalAlpha = 0.6;
				ctx.stroke();
			};
			for (const [x0, x1] of spans.slice(1)) {
				if (x0 <= runEnd + RUN_GAP_PX) runEnd = Math.max(runEnd, x1);
				else {
					fill();
					runStart = x0;
					runEnd = x1;
				}
			}
			fill();
		}
		ctx.globalAlpha = 1;
	});

	return (
		<canvas
			ref={canvas}
			class="absolute inset-y-0 left-0 h-full pointer-events-none rounded-lg"
			style={{
				width:
					followExtent() > 0
						? `calc(100% + ${followExtent() / secsPerPixel()}px)`
						: "100%",
			}}
		/>
	);
}

export function useSegmentTranslateX(
	segment: () => { start: number; end: number },
) {
	const { secsPerPixel } = useTrackContext();
	const { renderPosition } = useTimelineContext();

	return createMemo(() => {
		const base = renderPosition();

		const delta = segment().start;

		return (delta - base) / secsPerPixel();
	});
}

export function useSegmentWidth(segment: () => { start: number; end: number }) {
	const { secsPerPixel } = useTrackContext();

	return () => (segment().end - segment().start) / secsPerPixel();
}

export function SegmentRoot(
	props: ComponentProps<"fieldset"> & {
		segColor?: string;
		segment: { start: number; end: number };
		forceVisible?: boolean;
		selected?: boolean;
		muted?: boolean;
		ghost?: boolean;
		selection?: { type: IndexedSelectionType; index: number };
		onMouseDown?: (
			e: MouseEvent & { currentTarget: HTMLFieldSetElement; target: Element },
		) => void;
	},
) {
	const [local, rest] = splitProps(props, [
		"segColor",
		"segment",
		"forceVisible",
		"selected",
		"muted",
		"ghost",
		"selection",
		"onMouseDown",
		"class",
		"style",
		"ref",
		"children",
	]);
	const { editorState, setEditorState } = useEditorContext();
	const { isSegmentVisible } = useTimelineContext();
	const { compactBelow, registerCompactSegment } = useTrackContext();
	const compact = createMemo(
		() =>
			!local.forceVisible &&
			!local.selected &&
			local.segment.end - local.segment.start < compactBelow(),
	);
	const visible = createMemo(
		() =>
			local.forceVisible ||
			(!compact() && isSegmentVisible(local.segment.start, local.segment.end)),
	);
	createEffect(() => {
		if (!compact()) return;
		const { start, end } = local.segment;
		onCleanup(registerCompactSegment({ start, end, color: local.segColor }));
	});

	return (
		<Show when={visible()}>
			{(_) => {
				const translateX = useSegmentTranslateX(() => local.segment);
				const width = useSegmentWidth(() => local.segment);
				return (
					<SegmentContextProvider width={width} segment={() => local.segment}>
						<fieldset
							{...rest}
							aria-label={rest.title}
							data-timeline-segment
							class={cx(
								"absolute overflow-visible inset-y-0 min-w-0",
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
							<Show when={local.selection}>
								{(target) => (
									<button
										type="button"
										aria-label={`Select ${rest.title ?? "segment"}`}
										aria-pressed={!!local.selected}
										class="absolute inset-0 size-full z-30 rounded-lg pointer-events-none outline-hidden focus-visible:ring-2 focus-visible:ring-ed-accent"
										onClick={(event) =>
											setEditorState(
												"timeline",
												"selection",
												nextSegmentSelection(
													editorState.timeline.selection,
													target(),
													event,
												),
											)
										}
									/>
								)}
							</Show>
							<div
								class={cx(
									CAP_TRACK_FILL_CLASS,
									"relative h-full flex flex-row overflow-hidden group",
								)}
								data-selected={local.selected ? "" : undefined}
								data-muted={local.muted ? "" : undefined}
								data-ghost={local.ghost ? "" : undefined}
								style={
									local.segColor
										? ({ "--seg-color": local.segColor } as Record<
												string,
												string
											>)
										: undefined
								}
							>
								{local.children}
							</div>
						</fieldset>
					</SegmentContextProvider>
				);
			}}
		</Show>
	);
}

export const SEGMENT_LABEL_FULL_PX = 100;
export const SEGMENT_LABEL_COMPACT_PX = 48;
const SEGMENT_LABEL_INSET_PX = 13;
const SEGMENT_LABEL_TAIL_PX = 10;

export function useSegmentVisibleBox(): Accessor<{
	width: number;
	centerX: number;
	startX: number;
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

		const margin = Math.min(
			60,
			segmentWidth / 2,
			Math.max(visibleWidth / 2, 4),
		);
		const centerX = Math.min(
			Math.max((visibleStart + visibleEnd) / 2, margin),
			segmentWidth - margin,
		);

		return { width: visibleWidth, centerX, startX: visibleStart };
	});
}

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

	const leftAligned = () => {
		const visibleWidth = visibleBox().width;
		return (
			visibleWidth >= fullAt() ||
			(visibleWidth >= compactAt() && !!props.compact)
		);
	};

	return (
		<div
			class="absolute pointer-events-none"
			style={
				leftAligned()
					? {
							left: `${visibleBox().startX + SEGMENT_LABEL_INSET_PX}px`,
							top: "50%",
							transform: "translateY(-50%)",
							"max-width": `${Math.max(
								0,
								visibleBox().width -
									SEGMENT_LABEL_INSET_PX -
									SEGMENT_LABEL_TAIL_PX,
							)}px`,
							overflow: "hidden",
						}
					: {
							left: `${visibleBox().centerX}px`,
							top: "50%",
							transform: "translate(-50%, -50%)",
							"max-width": `${Math.max(0, visibleBox().width - 8)}px`,
							overflow: "hidden",
						}
			}
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
				"relative w-full h-full flex flex-row items-center",
				ctx.width() < 100 ? "px-0" : "pl-[13px] pr-[10px]",
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
				"absolute inset-y-0 z-10 flex w-5 cursor-col-resize items-center transition-opacity",
				props.position === "start"
					? "left-0 -translate-x-1/2 justify-end pr-[2px]"
					: "right-0 translate-x-1/2 justify-start pl-[2px]",
				compact() ? "opacity-55" : "opacity-0 group-hover:opacity-90",
				props.class,
			)}
			data-compact={compact()}
		>
			<div class="cap-seg-handle" />
		</div>
	);
}

export function useSetPreviewTime() {
	const { totalDuration, setEditorState } = useEditorContext();

	return (time: number) => {
		setEditorState("previewTime", Math.min(Math.max(0, time), totalDuration()));
	};
}
