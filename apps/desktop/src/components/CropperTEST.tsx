import {
  createSignal,
  type Component,
  type ParentProps,
  onMount,
} from "solid-js";
import type { Bounds } from "~/utils/tauri";
import AreaOccluder from "./AreaOccluder";

type HandlePosition = {
  x: "left" | "right" | "center";
  y: "top" | "bottom" | "center";
  cursor: string;
};

const HANDLE_POSITIONS: HandlePosition[] = [
  { x: "left", y: "top", cursor: "nw-resize" },
  { x: "right", y: "top", cursor: "ne-resize" },
  { x: "left", y: "bottom", cursor: "sw-resize" },
  { x: "right", y: "bottom", cursor: "se-resize" },
  { x: "center", y: "top", cursor: "n-resize" },
  { x: "center", y: "bottom", cursor: "s-resize" },
  { x: "left", y: "center", cursor: "w-resize" },
  { x: "right", y: "center", cursor: "e-resize" },
];

interface CropperProps {
  bounds: Bounds;
  minSize?: { width: number; height: number };
  aspectRatio?: number;
  borderRadius?: number;
  onBoundsChange?: (bounds: Bounds) => void;
}

const Cropper: Component<ParentProps<CropperProps>> = (props) => {
  const [isDragging, setIsDragging] = createSignal<string | null>(null);
  const [startPos, setStartPos] = createSignal<{ x: number; y: number } | null>(
    null
  );
  const [initialBounds, setInitialBounds] = createSignal<Bounds | null>(null);
  const [containerSize, setContainerSize] = createSignal<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!containerRef) return;
    const updateSize = () => {
      const rect = containerRef!.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };
    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(containerRef);

    return () => resizeObserver.disconnect();
  });

  const handleMouseDown = (e: MouseEvent, handle: string) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(handle);
    setStartPos({ x: e.clientX, y: e.clientY });
    setInitialBounds(props.bounds);
  };

  const constrainBounds = (bounds: Bounds): Bounds => {
    const container = containerSize();
    const minWidth = props.minSize?.width ?? 100;
    const minHeight = props.minSize?.height ?? 100;

    bounds.width = Math.max(
      minWidth,
      Math.min(bounds.width, container.width - bounds.x)
    );
    bounds.height = Math.max(
      minHeight,
      Math.min(bounds.height, container.height - bounds.y)
    );
    bounds.x = Math.max(0, Math.min(bounds.x, container.width - bounds.width));
    bounds.y = Math.max(
      0,
      Math.min(bounds.y, container.height - bounds.height)
    );

    return bounds;
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging() || !startPos() || !initialBounds()) return;

    const dx = e.clientX - startPos()!.x;
    const dy = e.clientY - startPos()!.y;
    const bounds = { ...initialBounds()! };

    if (isDragging() === "move") {
      bounds.x += dx;
      bounds.y += dy;
    } else {
      const minWidth = props.minSize?.width ?? 100;
      const minHeight = props.minSize?.height ?? 100;

      switch (isDragging()) {
        case "top-left":
          bounds.x = Math.min(
            bounds.x + bounds.width - minWidth,
            bounds.x + dx
          );
          bounds.y = Math.min(
            bounds.y + bounds.height - minHeight,
            bounds.y + dy
          );
          bounds.width = Math.max(minWidth, initialBounds()!.width - dx);
          bounds.height = Math.max(minHeight, initialBounds()!.height - dy);
          break;
        case "top-right":
          bounds.y = Math.min(
            bounds.y + bounds.height - minHeight,
            bounds.y + dy
          );
          bounds.width = Math.max(minWidth, initialBounds()!.width + dx);
          bounds.height = Math.max(minHeight, initialBounds()!.height - dy);
          break;
        case "bottom-left":
          bounds.x = Math.min(
            bounds.x + bounds.width - minWidth,
            bounds.x + dx
          );
          bounds.width = Math.max(minWidth, initialBounds()!.width - dx);
          bounds.height = Math.max(minHeight, initialBounds()!.height + dy);
          break;
        case "bottom-right":
          bounds.width = Math.max(minWidth, initialBounds()!.width + dx);
          bounds.height = Math.max(minHeight, initialBounds()!.height + dy);
          break;
        case "top":
          bounds.y = Math.min(
            bounds.y + bounds.height - minHeight,
            bounds.y + dy
          );
          bounds.height = Math.max(minHeight, initialBounds()!.height - dy);
          break;
        case "right":
          bounds.width = Math.max(minWidth, initialBounds()!.width + dx);
          break;
        case "bottom":
          bounds.height = Math.max(minHeight, initialBounds()!.height + dy);
          break;
        case "left":
          bounds.x = Math.min(
            bounds.x + bounds.width - minWidth,
            bounds.x + dx
          );
          bounds.width = Math.max(minWidth, initialBounds()!.width - dx);
          break;
      }
    }

    const constrained = constrainBounds(bounds);

    if (props.aspectRatio) {
      const ratio = props.aspectRatio;
      if (constrained.width / constrained.height > ratio) {
        constrained.width = constrained.height * ratio;
      } else {
        constrained.height = constrained.width / ratio;
      }
    }

    props.onBoundsChange?.(constrained);
  };

  const handleMouseUp = () => {
    setIsDragging(null);
    setStartPos(null);
    setInitialBounds(null);
  };

  return (
    <div
      ref={containerRef}
      class="relative h-full w-full"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <AreaOccluder
        bounds={props.bounds}
        borderRadius={props.borderRadius}
        guideLines
      >
        {props.children}
        <div
          class="absolute h-full w-full cursor-move border border-dashed border-white/40"
          style={{
            "border-radius": props.borderRadius
              ? `${props.borderRadius}px`
              : undefined,
          }}
          onMouseDown={(e) => handleMouseDown(e, "move")}
        >
          {/* Corner and edge handles */}
          {HANDLE_POSITIONS.map((handle) => {
            const isCorner = handle.x !== "center" && handle.y !== "center";
            const handleId = `${handle.y}-${handle.x}`.replace("center-", "");

            return (
              <div
                class={`absolute ${
                  isCorner ? "h-6 w-6" : "pointer-events-none h-6 w-6"
                } group z-10 flex items-center justify-center`}
                style={{
                  left:
                    handle.x === "left"
                      ? "-12px"
                      : handle.x === "right"
                      ? undefined
                      : "50%",
                  right: handle.x === "right" ? "-12px" : undefined,
                  top:
                    handle.y === "top"
                      ? "-12px"
                      : handle.y === "bottom"
                      ? undefined
                      : "50%",
                  bottom: handle.y === "bottom" ? "-12px" : undefined,
                  transform:
                    handle.x === "center" && handle.y === "center"
                      ? "translate(-50%, -50%)"
                      : handle.x === "center"
                      ? "translateX(-50%)"
                      : handle.y === "center"
                      ? "translateY(-50%)"
                      : undefined,
                  cursor: handle.cursor,
                }}
                onMouseDown={(e) => handleMouseDown(e, handleId)}
              >
                <div
                  class={`${
                    isCorner ? "h-2 w-2" : "h-1.5 w-1.5"
                  } rounded-full border border-white bg-[#929292] transition-transform duration-150 group-hover:scale-150`}
                />
              </div>
            );
          })}

          {/* Side handles for better interaction */}
          <div
            class="absolute left-0 top-0 h-full w-3 cursor-w-resize hover:bg-black/10"
            onMouseDown={(e) => handleMouseDown(e, "left")}
          />
          <div
            class="absolute right-0 top-0 h-full w-3 cursor-e-resize hover:bg-black/10"
            onMouseDown={(e) => handleMouseDown(e, "right")}
          />
          <div
            class="absolute left-0 top-0 h-3 w-full cursor-n-resize hover:bg-black/10"
            onMouseDown={(e) => handleMouseDown(e, "top")}
          />
          <div
            class="absolute bottom-0 left-0 h-3 w-full cursor-s-resize hover:bg-black/10"
            onMouseDown={(e) => handleMouseDown(e, "bottom")}
          />
        </div>
      </AreaOccluder>
    </div>
  );
};

export default Cropper;
