import { mergeRefs } from "@solid-primitives/refs";
import { cx } from "cva";
import { type ComponentProps, createMemo, createSignal } from "solid-js";
import { useEditorContext } from "../context";
import {
	SegmentContextProvider,
	TrackContextProvider,
	useSegmentContext,
	useTrackContext,
} from "./context";

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
		segment: { start: number; end: number };
		onMouseDown?: (
			e: MouseEvent & { currentTarget: HTMLDivElement; target: Element },
		) => void;
	},
) {
	const { editorState } = useEditorContext();
	const translateX = useSegmentTranslateX(() => props.segment);
	const width = useSegmentWidth(() => props.segment);

	return (
		<SegmentContextProvider width={width}>
			<div
				{...props}
				class={cx(
					"absolute overflow-hidden border rounded-xl inset-y-0",
					editorState.timeline.interactMode === "split" &&
						"timeline-scissors-cursor",
					props.class,
				)}
				style={{
					"--segment-x": `${translateX()}px`,
					transform: "translateX(var(--segment-x))",
					width: `${width()}px`,
				}}
				ref={props.ref}
			>
				<div
					class={cx(
						"h-full flex flex-row rounded-xl overflow-hidden group",
						props.innerClass,
					)}
				>
					{props.children}
				</div>
			</div>
		</SegmentContextProvider>
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
	const hidden = () => ctx.width() < 80;

	return (
		<div
			{...props}
			class={cx(
				"w-3 cursor-col-resize transition-opacity h-full flex flex-row items-center",
				props.position === "start"
					? "left-0 justify-end"
					: "right-0 justify-start",
				hidden() ? "opacity-0" : "opacity-0 group-hover:opacity-100",
				props.class,
			)}
			data-hidden={hidden()}
		>
			<div class="w-[3px] h-8 bg-solid-white rounded-full" />
		</div>
	);
}
