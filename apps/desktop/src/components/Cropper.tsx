import { createEventListenerMap } from "@solid-primitives/event-listener";
import {
  type ParentProps,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import AreaOccluder from "./AreaOccluder";
import Box from "~/utils/box";
import type { XY, Crop } from "~/utils/tauri";
import { createStore } from "solid-js/store";

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

function distanceOf(firstPoint: Touch, secondPoint: Touch): number {
  const dx = firstPoint.clientX - secondPoint.clientX;
  const dy = firstPoint.clientY - secondPoint.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export default function (
  props: ParentProps<{
    onCropChange: (value: Crop) => void;
    value: Crop;
    mappedSize?: XY<number>;
    minSize?: XY<number>;
    initialSize?: XY<number>;
    aspectRatio?: number;
    showGuideLines?: boolean;
  }>,
) {
  const minSize = props.minSize || { x: 100, y: 100 };
  const crop = props.value;
  console.log(`value ${crop}`);

  const [containerSize, setContainerSize] = createSignal({ x: 0, y: 0 });
  const mappedSize = createMemo(() => props.mappedSize || containerSize());

  const containerToMappedSizeScale = createMemo(() => {
    const container = containerSize();
    const mapped = mappedSize();
    return {
      x: container.x / mapped.x,
      y: container.y / mapped.y,
    };
  });

  const displayCrop = createMemo(() => {
    const mapped = mappedSize();
    const container = containerSize();
    return {
      x: (crop.position.x / mapped.x) * container.x,
      y: (crop.position.y / mapped.y) * container.y,
      width: (crop.size.x / mapped.x) * container.x,
      height: (crop.size.y / mapped.y) * container.y,
    };
  });

  let containerRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!containerRef) return;

    const updateContainerSize = () => {
      setContainerSize({
        x: containerRef!.clientWidth,
        y: containerRef!.clientHeight,
      });
    };

    updateContainerSize();
    const resizeObserver = new ResizeObserver(updateContainerSize);
    resizeObserver.observe(containerRef);
    onCleanup(() => resizeObserver.disconnect());

    const mapped = mappedSize();
    const initial = props.initialSize || {
      x: mapped.x / 2,
      y: mapped.y / 2,
    };

    let width = clamp(initial.x, minSize.x, mapped.x);
    let height = clamp(initial.y, minSize.y, mapped.y);

    const box = Box.from(
      { x: (mapped.x - width) / 2, y: (mapped.y - height) / 2 },
      { x: width, y: height },
    );

    if (props.aspectRatio) {
      // if (width / height > props.aspectRatio) {
      //   width = height * props.aspectRatio;
      // } else {
      //   height = width / props.aspectRatio;
      // }
      box.constrainToRatio(props.aspectRatio, { x: 0.5, y: 0.5 });
    }

    box.constrainToSize(
      containerSize().x,
      containerSize().y,
      minSize.x,
      minSize.y,
      { x: 0.5, y: 0.5 },
      props.aspectRatio,
    );
    box.constrainToBoundary(containerSize().x, containerSize().x, {
      x: 0.5,
      y: 0.5,
    });

    props.onCropChange({
      size: { x: width, y: height },
      position: {
        x: (mapped.x - width) / 2,
        y: (mapped.y - height) / 2,
      },
    });

    console.log(
      `crop: ${JSON.stringify(crop)} display: ${JSON.stringify(displayCrop())}`,
    );
  });

  createEffect(
    on(
      () => props.aspectRatio,
      () => {
        if (!props.aspectRatio) return;
        const box = Box.from(crop.position, crop.size);
        box.constrainToRatio(props.aspectRatio, { x: 0.5, y: 0.5 });
        props.onCropChange(box.toBounds());
      },
    ),
  );

  const [isDragging, setIsDragging] = createSignal(false);
  const [initialPinchDistance, setInitialPinchDistance] = createSignal(0);
  const [initialSize, setInitialSize] = createSignal({ width: 0, height: 0 });
  const [lastTouchCenter, setLastTouchCenter] = createSignal<XY<number> | null>(
    null,
  );
  const [isTrackpadGesture, setIsTrackpadGesture] = createSignal(false);

  function handleDragStart(event: MouseEvent) {
    if (isTrackpadGesture()) return; // Don't start drag if we're in a trackpad gesture
    event.stopPropagation();
    setIsDragging(true);
    let lastValidPos = { x: event.clientX, y: event.clientY };
    const box = Box.from(crop.position, crop.size);
    const scaleFactors = containerToMappedSizeScale();

    createRoot((dispose) => {
      const mapped = mappedSize();
      createEventListenerMap(window, {
        mouseup: () => {
          setIsDragging(false);
          dispose();
        },
        mousemove: (e) => {
          const dx = (e.clientX - lastValidPos.x) / scaleFactors.x;
          const dy = (e.clientY - lastValidPos.y) / scaleFactors.y;

          box.move(
            clamp(box.x + dx, 0, mapped.x - box.width),
            clamp(box.y + dy, 0, mapped.y - box.height),
          );

          const newBox = box;
          if (newBox.x !== crop.position.x || newBox.y !== crop.position.y) {
            lastValidPos = { x: e.clientX, y: e.clientY };
            props.onCropChange(newBox.toBounds());
          }
        },
      });
    });
  }

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    const box = Box.from(crop.position, crop.size);
    const mapped = mappedSize();

    if (event.ctrlKey) {
      setIsTrackpadGesture(true);

      const velocity = Math.max(0.001, Math.abs(event.deltaY) * 0.001);
      const scale = 1 - event.deltaY * velocity;
      const origin = { x: 0.5, y: 0.5 };

      box.resize(box.width * scale, box.height * scale, origin);

      if (props.aspectRatio) box.constrainToRatio(props.aspectRatio, origin);
      box.constrainToSize(
        mapped.x,
        mapped.y,
        minSize.x,
        minSize.y,
        origin,
        props.aspectRatio,
      );
      box.constrainToBoundary(mapped.x, mapped.y, origin);

      props.onCropChange(box.toBounds());

      setTimeout(() => setIsTrackpadGesture(false), 100);
    } else {
      const velocity = Math.max(1, Math.abs(event.deltaY) * 0.01);
      const scaleFactors = containerToMappedSizeScale();
      const dx = (-event.deltaX * velocity) / scaleFactors.x;
      const dy = (-event.deltaY * velocity) / scaleFactors.y;

      box.move(
        clamp(box.x + dx, 0, mapped.x - box.width),
        clamp(box.y + dy, 0, mapped.y - box.height),
      );

      props.onCropChange(box.toBounds());
    }
  }

  function handleTouchStart(event: TouchEvent) {
    if (event.touches.length === 2) {
      // Initialize pinch zoom
      const distance = distanceOf(event.touches[0], event.touches[1]);
      setInitialPinchDistance(distance);
      setInitialSize({
        width: crop.size.x,
        height: crop.size.y,
      });

      // Initialize touch center
      const centerX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const centerY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      setLastTouchCenter({ x: centerX, y: centerY });
    } else if (event.touches.length === 1) {
      // Handle single touch as drag
      setIsDragging(true);
      setLastTouchCenter({
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      });
    }
  }

  function handleTouchMove(event: TouchEvent) {
    if (event.touches.length === 2) {
      // Handle pinch zoom
      const currentDistance = distanceOf(event.touches[0], event.touches[1]);
      const scale = currentDistance / initialPinchDistance();

      const box = Box.from(crop.position, crop.size);
      const mapped = mappedSize();

      // Calculate new dimensions while maintaining aspect ratio
      const currentRatio = crop.size.x / crop.size.y;
      let newWidth = clamp(initialSize().width * scale, minSize.x, mapped.x);
      let newHeight = newWidth / currentRatio;

      // Adjust if height exceeds bounds
      if (newHeight < minSize.y || newHeight > mapped.y) {
        newHeight = clamp(newHeight, minSize.y, mapped.y);
        newWidth = newHeight * currentRatio;
      }

      // Resize from center
      box.resize(newWidth, newHeight, { x: 0.5, y: 0.5 });

      // Handle two-finger pan
      const centerX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const centerY = (event.touches[0].clientY + event.touches[1].clientY) / 2;

      if (lastTouchCenter()) {
        const scaleFactors = containerToMappedSizeScale();
        const dx = (centerX - lastTouchCenter()!.x) / scaleFactors.x;
        const dy = (centerY - lastTouchCenter()!.y) / scaleFactors.y;

        box.move(
          clamp(box.x + dx, 0, mapped.x - box.width),
          clamp(box.y + dy, 0, mapped.y - box.height),
        );
      }

      setLastTouchCenter({ x: centerX, y: centerY });
      props.onCropChange(box.toBounds());
    } else if (event.touches.length === 1 && isDragging()) {
      // Handle single touch drag
      const box = Box.from(crop.position, crop.size);
      const scaleFactors = containerToMappedSizeScale();
      const mapped = mappedSize();

      const dx =
        (event.touches[0].clientX - lastTouchCenter()!.x) / scaleFactors.x;
      const dy =
        (event.touches[0].clientY - lastTouchCenter()!.y) / scaleFactors.y;

      box.move(
        clamp(box.x + dx, 0, mapped.x - box.width),
        clamp(box.y + dy, 0, mapped.y - box.height),
      );

      setLastTouchCenter({
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      });
      props.onCropChange(box.toBounds());
    }
  }

  function handleTouchEnd(event: TouchEvent) {
    if (event.touches.length === 0) {
      setIsDragging(false);
      setLastTouchCenter(null);
    } else if (event.touches.length === 1) {
      // Reset for single touch drag
      setLastTouchCenter({
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      });
    }
  }

  function handleResizeStartTouch(event: TouchEvent, dir: Direction) {
    if (event.touches.length !== 1) return;
    event.stopPropagation();
    const touch = event.touches[0];
    handleResizeStart(touch.clientX, touch.clientY, dir);
  }

  function handleResizeStart(clientX: number, clientY: number, dir: Direction) {
    const origin: XY<number> = {
      x: dir.includes("w") ? 1 : 0,
      y: dir.includes("n") ? 1 : 0,
    };
    let lastValidPos = { x: clientX, y: clientY };
    const box = Box.from(crop.position, crop.size);
    const scaleFactors = containerToMappedSizeScale();
    const mapped = mappedSize();

    createRoot((dispose) => {
      createEventListenerMap(window, {
        mouseup: dispose,
        touchend: dispose,
        touchmove: (e) => {
          if (e.touches.length !== 1) return;
          handleMove(e.touches[0].clientX, e.touches[0].clientY);
        },
        mousemove: (e) => handleMove(e.clientX, e.clientY),
      });
    });

    function handleMove(moveX: number, moveY: number) {
      const dx = (moveX - lastValidPos.x) / scaleFactors.x;
      const dy = (moveY - lastValidPos.y) / scaleFactors.y;

      const currentBox = box.toBounds();
      const newWidth =
        dir.includes("e") || dir.includes("w")
          ? clamp(
              dir.includes("w")
                ? currentBox.size.x - dx
                : currentBox.size.x + dx,
              minSize.x,
              mapped.x,
            )
          : currentBox.size.x;

      const newHeight =
        dir.includes("n") || dir.includes("s")
          ? clamp(
              dir.includes("n")
                ? currentBox.size.y - dy
                : currentBox.size.y + dy,
              minSize.y,
              mapped.y,
            )
          : currentBox.size.y;

      box.resize(newWidth, newHeight, origin);

      if (props.aspectRatio) {
        box.constrainToRatio(
          props.aspectRatio,
          origin,
          dir.includes("n") || dir.includes("s") ? "width" : "height",
        );
      }

      box.constrainToBoundary(mapped.x, mapped.y, origin);

      const newBox = box.toBounds();
      if (
        newBox.size.x !== crop.size.x ||
        newBox.size.y !== crop.size.y ||
        newBox.position.x !== crop.position.x ||
        newBox.position.y !== crop.position.y
      ) {
        lastValidPos = { x: moveX, y: moveY };
        props.onCropChange(newBox);
      }
    }
  }

  return (
    <div
      ref={containerRef}
      class="relative h-full w-full overflow-hidden"
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <AreaOccluder
        bounds={{
          x: displayCrop().x,
          y: displayCrop().y,
          width: displayCrop().width,
          height: displayCrop().height,
        }}
        borderRadius={9}
        // guideLines={props.showGuideLines}
        // handles={true}
      >
        {props.children}
      </AreaOccluder>
      <div
        class="absolute"
        style={{
          top: `${displayCrop().y}px`,
          left: `${displayCrop().x}px`,
          width: `${displayCrop().width}px`,
          height: `${displayCrop().height}px`,
          cursor: isDragging() ? "grabbing" : "grab",
        }}
        onMouseDown={handleDragStart}
      >
        <For each={HANDLES}>
          {(handle) => {
            const isCorner = handle.x !== "c" && handle.y !== "c";

            return isCorner ? (
              <div
                role="slider"
                class="absolute z-10 flex h-[30px] w-[30px] items-center justify-center"
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
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleResizeStart(e.clientX, e.clientY, handle.direction);
                }}
                onTouchStart={(e) =>
                  handleResizeStartTouch(e, handle.direction)
                }
              />
            ) : (
              <div
                role="slider"
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
                      ? { bottom: "0", height: "16px" }
                      : { top: "0", bottom: "0" }),
                  cursor: `${handle.cursor}-resize`,
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleResizeStart(e.clientX, e.clientY, handle.direction);
                }}
                onTouchStart={(e) =>
                  handleResizeStartTouch(e, handle.direction)
                }
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}
