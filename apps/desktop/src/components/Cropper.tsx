import { createEventListenerMap } from "@solid-primitives/event-listener";
import {
  type ParentProps,
  createMemo,
  createRoot,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import AreaOccluder from "./AreaOccluder";
import Box from "~/utils/box";
import type { XY, Crop } from "~/utils/tauri";
import type { SetStoreFunction } from "solid-js/store";

type Direction = "n" | "e" | "s" | "w" | "nw" | "ne" | "se" | "sw";
type HandleSide = {
  x: "l" | "r" | "c";
  y: "t" | "b" | "c";
  direction: Direction;
  cursor: string;
};

const HANDLES: HandleSide[] = [
  { x: "l", y: "t", direction: "nw", cursor: "nwse-resize" },
  { x: "r", y: "t", direction: "ne", cursor: "nesw-resize" },
  { x: "l", y: "b", direction: "sw", cursor: "nesw-resize" },
  { x: "r", y: "b", direction: "se", cursor: "nwse-resize" },
  { x: "c", y: "t", direction: "n", cursor: "ns-resize" },
  { x: "c", y: "b", direction: "s", cursor: "ns-resize" },
  { x: "l", y: "c", direction: "w", cursor: "ew-resize" },
  { x: "r", y: "c", direction: "e", cursor: "ew-resize" },
];

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

export default function (
  props: ParentProps<{
    cropStore: [crop: Crop, setCrop: SetStoreFunction<Crop>];
    mappedSize?: { x: number; y: number };
    minSize?: { x: number; y: number };
    aspectRatio?: number;
    showGuideLines?: boolean;
  }>
) {
  const [crop, setCrop] = props.cropStore;
  const minSize = props.minSize || { x: 50, y: 50 };
  const [containerSize, setContainerSize] = createSignal({
    x: window.innerWidth,
    y: window.innerHeight,
  });
  const mappedSize = createMemo(() => props.mappedSize || containerSize());

  let containerRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!containerRef) return;

    const handleResize = () => {
      setContainerSize({ x: window.innerWidth, y: window.innerHeight });
    };
    window.addEventListener("resize", handleResize);
    onCleanup(() => window.removeEventListener("resize", handleResize));

    const mapped = mappedSize();
    let width = Math.min(mapped.x / 2, mapped.x - minSize.x);
    let height = Math.min(mapped.y / 2, mapped.y - minSize.y);

    const ratio = props.aspectRatio;
    if (ratio) {
      if (width / height > ratio) width = height * ratio;
      else height = width / ratio;
    }

    setCrop({
      size: { x: width, y: height },
      position: {
        x: (mapped.x - width) / 2,
        y: (mapped.y - height) / 2,
      },
    });
  });

  const [isDragging, setIsDragging] = createSignal(false);

  const styles = createMemo(() => ({
    transform: `translate(${crop.position.x}px, ${crop.position.y}px)`,
    width: `${crop.size.x}px`,
    height: `${crop.size.y}px`,
    cursor: isDragging() ? "grabbing" : "grab",
  }));

  function handleDragStart(event: MouseEvent) {
    event.stopPropagation();
    setIsDragging(true);
    let lastValidPos = { x: event.clientX, y: event.clientY };
    const box = Box.from(crop.position, crop.size);

    createRoot((dispose) => {
      const mapped = mappedSize();
      createEventListenerMap(window, {
        mouseup: () => {
          setIsDragging(false);
          dispose();
        },
        mousemove: (e) => {
          const dx = e.clientX - lastValidPos.x;
          const dy = e.clientY - lastValidPos.y;

          box.move(
            clamp(
              box.toPositionAndSize().position.x + dx,
              0,
              mapped.x - box.width()
            ),
            clamp(
              box.toPositionAndSize().position.y + dy,
              0,
              mapped.y - box.height()
            )
          );

          const newBox = box.toPositionAndSize();
          if (
            newBox.position.x !== crop.position.x ||
            newBox.position.y !== crop.position.y
          ) {
            lastValidPos = { x: e.clientX, y: e.clientY };
            setCrop(newBox);
          }
        },
      });
    });
  }

  function handleResizeStart(event: MouseEvent, handle: HandleSide) {
    event.stopPropagation();
    const dir = handle.direction;
    const origin: XY<number> = {
      x: dir.includes("w") ? 1 : 0,
      y: dir.includes("n") ? 1 : 0,
    };
    let lastValidPos = { x: event.clientX, y: event.clientY };
    const box = Box.from(crop.position, crop.size);

    createRoot((dispose) => {
      const mapped = mappedSize();
      createEventListenerMap(window, {
        mouseup: dispose,
        mousemove: (e) => {
          const dx = e.clientX - lastValidPos.x;
          const dy = e.clientY - lastValidPos.y;

          const currentBox = box.toPositionAndSize();
          let newWidth = currentBox.size.x;
          let newHeight = currentBox.size.y;

          if (dir.includes("e") || dir.includes("w")) {
            newWidth = clamp(
              dir.includes("w")
                ? currentBox.size.x - dx
                : currentBox.size.x + dx,
              minSize.x,
              mapped.x
            );
          }
          if (dir.includes("n") || dir.includes("s")) {
            newHeight = clamp(
              dir.includes("n")
                ? currentBox.size.y - dy
                : currentBox.size.y + dy,
              minSize.y,
              mapped.y
            );
          }

          box.resize(newWidth, newHeight, origin);

          if (props.aspectRatio) {
            box.constrainToRatio(
              props.aspectRatio,
              origin,
              dir.includes("n") || dir.includes("s") ? "width" : "height"
            );
          }

          box.constrainToBoundary(mapped.x, mapped.y, origin);

          const newBox = box.toPositionAndSize();
          if (
            newBox.size.x !== crop.size.x ||
            newBox.size.y !== crop.size.y ||
            newBox.position.x !== crop.position.x ||
            newBox.position.y !== crop.position.y
          ) {
            lastValidPos = { x: e.clientX, y: e.clientY };
            setCrop(newBox);
          }
        },
      });
    });
  }

  return (
    <div ref={containerRef} class="relative h-full w-full overflow-hidden">
      <AreaOccluder
        bounds={{
          x: crop.position.x,
          y: crop.position.y,
          width: crop.size.x,
          height: crop.size.y,
        }}
        borderRadius={0}
        // guideLines={true}
      >
        {props.children}
      </AreaOccluder>
      <div
        class="absolute bg-transparent border-dashed border"
        style={styles()}
        onMouseDown={handleDragStart}
      >
        <Show when={props.showGuideLines}>
          <div class="*:border-dashed *:border *:opacity-50 *:absolute border-[#eee]">
            <div class="border-b-[1px] border-t-[1px] left-0 w-full h-[calc(100%/3)] top-[calc(100%/3)]" />
            <div class="border-l-[1px] border-r-[1px] left-[calc(100%/3)] w-[calc(100%/3)] h-full top-0" />
          </div>
        </Show>

        <For each={HANDLES}>
          {(handle) => {
            const isCorner = handle.x !== "c" && handle.y !== "c";
            return (
              <div
                class={`absolute ${
                  isCorner ? "h-[26px] w-[26px]" : "h-[24px] w-[24px]"
                } group z-10 flex items-center justify-center`}
                style={{
                  ...(handle.x === "l"
                    ? { left: "-12px" }
                    : handle.x === "r"
                    ? { right: "-12px" }
                    : { left: "50%", transform: "translateX(-50%)" }),
                  ...(handle.y === "t"
                    ? { top: "-12px" }
                    : handle.y === "b"
                    ? { bottom: "-12px" }
                    : { top: "50%", transform: "translateY(-50%)" }),
                  cursor: handle.cursor,
                }}
                onMouseDown={(e) => handleResizeStart(e, handle)}
              >
                <div
                  class={`${
                    isCorner ? "h-[8px] w-[8px]" : "h-[6px] w-[6px]"
                  } rounded-full border border-[#FFFFFF] bg-[#929292] transition-transform duration-150 group-hover:scale-150`}
                />
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
