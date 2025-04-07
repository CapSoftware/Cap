import { mergeRefs } from "@solid-primitives/refs";
import { cx } from "cva";
import { ComponentProps, createMemo, createSignal } from "solid-js";

import {
  SegmentContextProvider,
  TrackContextProvider,
  useSegmentContext,
  useTrackContext,
} from "./context";
import { useEditorContext } from "../context";

export function TrackRoot(props: ComponentProps<"div">) {
  const [ref, setRef] = createSignal<HTMLDivElement>();

  return (
    <TrackContextProvider ref={ref}>
      <div
        {...props}
        ref={mergeRefs(setRef, props.ref)}
        class={cx("flex flex-row relative h-14", props.class)}
      >
        {props.children}
      </div>
    </TrackContextProvider>
  );
}

export function SegmentRoot(
  props: ComponentProps<"div"> & {
    innerClass: string;
    segment: { start: number; end: number };
    onMouseDown?: (
      e: MouseEvent & { currentTarget: HTMLDivElement; target: Element }
    ) => void;
  }
) {
  const { secsPerPixel } = useTrackContext();
  const { state, project } = useEditorContext();

  const isSelected = createMemo(() => {
    const selection = state.timelineSelection;
    if (!selection || selection.type !== "zoom") return false;

    const segmentIndex = project.timeline?.zoomSegments?.findIndex(
      (s) => s.start === props.segment.start && s.end === props.segment.end
    );

    return segmentIndex === selection.index;
  });

  const translateX = createMemo(() => {
    const base = state.timelineTransform.position;

    const delta = props.segment.start;

    return (delta - base) / secsPerPixel();
  });

  const width = () => {
    return (props.segment.end - props.segment.start) / secsPerPixel();
  };

  return (
    <SegmentContextProvider width={width}>
      <div
        {...props}
        class={cx(
          "absolute border rounded-xl inset-y-0 w-full",
          props.class,
          isSelected() && "wobble-wrapper border border-gray-500"
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
            props.innerClass
          )}
        >
          {props.children}
        </div>
      </div>
    </SegmentContextProvider>
  );
}

export function SegmentContent(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      class={cx(
        "relative w-full h-full flex flex-row items-center px-[0.5rem] py-[0.25rem]",
        props.class
      )}
    />
  );
}

export function SegmentHandle(
  props: ComponentProps<"div"> & { position: "start" | "end" }
) {
  const ctx = useSegmentContext();
  const hidden = () => ctx.width() < 80;

  return (
    <div
      {...props}
      class={cx(
        "w-3 cursor-col-resize shrink-0 transition-opacity h-full flex flex-row items-center",
        props.position === "start"
          ? "left-0 justify-end"
          : "right-0 justify-start",
        hidden() ? "opacity-0" : "opacity-0 group-hover:opacity-100",
        props.class
      )}
      data-hidden={hidden()}
    >
      <div class="w-[3px] h-8 bg-solid-white rounded-full" />
    </div>
  );
}
