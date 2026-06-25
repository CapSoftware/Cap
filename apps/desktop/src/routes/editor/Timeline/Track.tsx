import { mergeRefs } from "@solid-primitives/refs";
import { cx } from "cva";
import {
	type ComponentProps,
	createMemo,
	createSignal,
	Show,
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
			<SegmentContextProvider width={width}>
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
