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
  cursor: "ew" | "ns" | "nesw" | "nwse";
};

const HANDLES: HandleSide[] = [
  { x: "l", y: "t", direction: "nw", cursor: "nwse" },
  { x: "r", y: "t", direction: "ne", cursor: "nesw" },
  { x: "l", y: "b", direction: "sw", cursor: "nesw" },
  { x: "r", y: "b", direction: "se", cursor: "nwse" },
  { x: "c", y: "t", direction: "n", cursor: "ns" },
  { x: "c", y: "b", direction: "s", cursor: "ns" },
  { x: "l", y: "c", direction: "w", cursor: "ew" },
  { x: "r", y: "c", direction: "e", cursor: "ew" },
];

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

export default function (
  props: ParentProps<{
    cropStore: [crop: Crop, setCrop: SetStoreFunction<Crop>];
    mappedSize?: XY<number>;
    minSize?: XY<number>;
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

  function handleResizeStart(event: MouseEvent, dir: Direction) {
    event.stopPropagation();
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
        borderRadius={10}
        guideLines={props.showGuideLines}
        handles={true}
      >
        {props.children}
      </AreaOccluder>
      <div
        class="absolute bg-transparent"
        style={styles()}
        onMouseDown={handleDragStart}
      >
        <Show when={props.showGuideLines}>
          <div class="before:absolute block absolute left-1/2 top-1/2 before:top-0 before:left-[-6px] before:w-[14px] before:h-[2px] before:bg-gray-400 after:absolute after:top-[-6px] after:left-0 after:w-[2px] after:h-[14px] after:bg-gray-400" />
        </Show>

        <For each={HANDLES}>
          {(handle) => {
            const isCorner = handle.x !== "c" && handle.y !== "c";

            if (isCorner)
              return (
                <div
                  class={`absolute z-10 flex items-center justify-center ${
                    isCorner ? "h-[30px] w-[30px]" : "h-[25px] w-[25px]"
                  }`}
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
                    cursor: `${handle.cursor}-resize`,
                  }}
                  onMouseDown={(e) => handleResizeStart(e, handle.direction)}
                />
              );
            else
              return (
                <div
                  class="absolute"
                  style={{
                    ...(handle.x === "l"
                      ? {
                          left: "0",
                          width: "16px",
                          transform: "translateX(-50%)",
                        }
                      : handle.x === "r"
                      ? {
                          right: "0",
                          width: "16px",
                          transform: "translateX(50%)",
                        }
                      : {
                          left: "0",
                          right: "0",
                          transform: "translateY(50%)",
                        }),
                    ...(handle.y === "t"
                      ? {
                          top: "0",
                          height: "16px",
                          transform: "translateY(-50%)",
                        }
                      : handle.y === "b"
                      ? {
                          bottom: "0",
                          height: "16px",
                        }
                      : { top: "0", bottom: "0" }),
                    cursor: `${handle.cursor}-resize`,
                  }}
                  onMouseDown={(e) => handleResizeStart(e, handle.direction)}
                />
              );
          }}
        </For>
      </div>
    </div>
  );
}
