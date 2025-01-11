import { createEventListenerMap } from "@solid-primitives/event-listener";
import {
  batch,
  createMemo,
  createRoot,
  createSignal,
  For,
  onCleanup,
  onMount,
  type ParentProps,
} from "solid-js";
import { type Crop } from "~/utils/tauri";
import AreaOccluder from "./AreaOccluder";
import type { SetStoreFunction } from "solid-js/store";

type HandlePosition = "nw" | "ne" | "se" | "sw";

const HANDLES: { position: HandlePosition; cursor: string }[] = [
  { position: "nw", cursor: "nw-resize" },
  { position: "ne", cursor: "ne-resize" },
  { position: "se", cursor: "se-resize" },
  { position: "sw", cursor: "sw-resize" },
];

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

export default function (
  props: ParentProps<{
    cropStore: [crop: Crop, setCrop: SetStoreFunction<Crop>];
    mappedSize?: { x: number; y: number };
    minSize?: { x: number; y: number };
  }>
) {
  const [crop, setCrop] = props.cropStore;
  const minSize = props.minSize || { x: 50, y: 50 };
  const [containerSize, setContainerSize] = createSignal({ x: 0, y: 0 });
  const mappedSize = createMemo(() => props.mappedSize || containerSize());

  // Convert between screen coordinates and container coordinates
  const scaledCrop = createMemo(() => {
    const mapped = mappedSize();
    const container = containerSize();
    return {
      position: {
        x: (crop.position.x / mapped.x) * container.x,
        y: (crop.position.y / mapped.y) * container.y,
      },
      size: {
        x: (crop.size.x / mapped.x) * container.x,
        y: (crop.size.y / mapped.y) * container.y,
      },
    };
  });

  let containerRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!containerRef) return;

    const rect = containerRef.getBoundingClientRect();
    setContainerSize({ x: rect.width, y: rect.height });

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === containerRef) {
          setContainerSize({
            x: entry.contentRect.width,
            y: entry.contentRect.height,
          });
        }
      }
    });
    resizeObserver.observe(containerRef);
    onCleanup(() => resizeObserver.disconnect());

    // Set initial crop area to center
    const mapped = mappedSize();
    const width = Math.min(mapped.x / 2, mapped.x - minSize.x);
    const height = Math.min(mapped.y / 2, mapped.y - minSize.y);

    setCrop({
      size: { x: width, y: height },
      position: {
        x: (mapped.x - width) / 2,
        y: (mapped.y - height) / 2,
      },
    });
  });

  const [isDragging, setIsDragging] = createSignal(false);

  const styles = createMemo(() => {
    const scaled = scaledCrop();
    return {
      left: `${scaled.position.x}px`,
      top: `${scaled.position.y}px`,
      width: `${scaled.size.x}px`,
      height: `${scaled.size.y}px`,
      cursor: isDragging() ? "grabbing" : "grab",
    };
  });

  // Handle dragging the selection area
  function handleDragStart(event: MouseEvent) {
    event.stopPropagation();
    setIsDragging(true);
    const startPos = { x: event.clientX, y: event.clientY };
    const startCrop = { ...crop };

    createRoot((dispose) => {
      const mapped = mappedSize();
      createEventListenerMap(window, {
        mouseup: () => {
          setIsDragging(false);
          dispose();
        },
        mousemove: (e) => {
          const dx =
            ((e.clientX - startPos.x) / containerRef!.clientWidth) * mapped.x;
          const dy =
            ((e.clientY - startPos.y) / containerRef!.clientHeight) * mapped.y;

          setCrop("position", {
            x: clamp(startCrop.position.x + dx, 0, mapped.x - crop.size.x),
            y: clamp(startCrop.position.y + dy, 0, mapped.y - crop.size.y),
          });
        },
      });
    });
  }

  // Handle resizing from corners
  function handleResizeStart(event: MouseEvent, handle: HandlePosition) {
    event.stopPropagation();
    const startPos = { x: event.clientX, y: event.clientY };
    const startCrop = { ...crop };

    createRoot((dispose) => {
      const mapped = mappedSize();
      createEventListenerMap(window, {
        mouseup: dispose,
        mousemove: (e) => {
          const dx =
            ((e.clientX - startPos.x) / containerRef!.clientWidth) * mapped.x;
          const dy =
            ((e.clientY - startPos.y) / containerRef!.clientHeight) * mapped.y;

          batch(() => {
            let newSize = { ...startCrop.size };
            let newPos = { ...startCrop.position };

            if (handle.includes("w")) {
              newSize.x = clamp(
                startCrop.size.x - dx,
                minSize.x,
                startCrop.position.x + startCrop.size.x
              );
              newPos.x = clamp(
                startCrop.position.x + dx,
                0,
                startCrop.position.x + startCrop.size.x - minSize.x
              );
            } else if (handle.includes("e")) {
              newSize.x = clamp(
                startCrop.size.x + dx,
                minSize.x,
                mapped.x - startCrop.position.x
              );
            }

            if (handle.includes("n")) {
              newSize.y = clamp(
                startCrop.size.y - dy,
                minSize.y,
                startCrop.position.y + startCrop.size.y
              );
              newPos.y = clamp(
                startCrop.position.y + dy,
                0,
                startCrop.position.y + startCrop.size.y - minSize.y
              );
            } else if (handle.includes("s")) {
              newSize.y = clamp(
                startCrop.size.y + dy,
                minSize.y,
                mapped.y - startCrop.position.y
              );
            }

            setCrop({
              position: newPos,
              size: newSize,
            });
          });
        },
      });
    });
  }

  return (
    <div ref={containerRef} class="relative h-full w-full overflow-hidden">
      <div class="-z-10">{props.children}</div>
      <AreaOccluder
        bounds={{
          x: crop.position.x,
          y: crop.position.y,
          width: crop.size.x,
          height: crop.size.y,
        }}
      >
        {props.children}
      </AreaOccluder>
      <div
        class="absolute bg-transparent border-2 border-white shadow-lg"
        style={styles()}
        onMouseDown={handleDragStart}
      >
        <For each={HANDLES}>
          {(handle) => (
            <div
              class="absolute w-4 h-4 bg-white rounded-full shadow-md border border-gray-200 -translate-x-1/2 -translate-y-1/2"
              style={{
                cursor: handle.cursor,
                ...(handle.position.includes("n")
                  ? { top: "0" }
                  : { bottom: "100%" }),
                ...(handle.position.includes("w")
                  ? { left: "0" }
                  : { right: "100%" }),
              }}
              onMouseDown={(e) => handleResizeStart(e, handle.position)}
            />
          )}
        </For>
      </div>
    </div>
  );
}
