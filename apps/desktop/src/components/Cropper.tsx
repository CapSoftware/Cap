import { createEventListenerMap } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import {
  type CheckMenuItemOptions,
  Menu,
  PredefinedMenuItemOptions,
  SubmenuOptions,
} from "@tauri-apps/api/menu";
import { type as ostype } from "@tauri-apps/plugin-os";
import {
  type ParentProps,
  batch,
  createComputed,
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
import { createStore } from "solid-js/store";
import { Transition } from "solid-transition-group";
import { generalSettingsStore } from "~/store";
import Box from "~/utils/box";
import { type Crop, type XY, commands } from "~/utils/tauri";
import CropAreaRenderer from "./CropAreaRenderer";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Direction = "n" | "e" | "s" | "w" | "nw" | "ne" | "se" | "sw";
type HandleSide = {
  x: "l" | "r" | "c";
  y: "t" | "b" | "c";
  direction: Direction;
  cursor: `${"ew" | "ns" | "nesw" | "nwse"}-resize`;
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

type Ratio = [number, number];
const COMMON_RATIOS: Ratio[] = [
  [1, 1],
  [4, 3],
  [3, 2],
  [16, 9],
  [2, 1],
  [21, 9],
];
const SNAP_RATIO_EL_WIDTH_PX = 40;

const KEY_MAPPINGS = new Map([
  ["ArrowRight", "e"],
  ["ArrowDown", "s"],
  ["ArrowLeft", "w"],
  ["ArrowUp", "n"],
]);

const ORIGIN_CENTER: XY<number> = { x: 0.5, y: 0.5 };

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

function distanceOf(firstPoint: Touch, secondPoint: Touch): number {
  const dx = firstPoint.clientX - secondPoint.clientX;
  const dy = firstPoint.clientY - secondPoint.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function calcCropFloor(value: Crop): Crop {
  return {
    size: {
      x: Math.floor(value.size.x),
      y: Math.floor(value.size.y),
    },
    position: {
      x: Math.floor(value.position.x),
      y: Math.floor(value.position.y),
    },
  };
}

export default function Cropper(
  props: ParentProps<{
    class?: string;
    onCropChange: (value: Crop) => void;
    value: Crop;
    mappedSize?: XY<number>;
    minSize?: XY<number>;
    initialSize?: XY<number>;
    aspectRatio?: number;
    showGuideLines?: boolean;
  }>
) {
  const crop = props.value;
  function setCrop(value: Crop) {
    props.onCropChange(value);
  }

  const [containerSize, setContainerSize] = createSignal({ x: 0, y: 0 });
  const [aspectRatio, setAspectRatio] = createSignal<number | null>(
    props.aspectRatio ?? null
  );
  createEffect(() => {
    if (props.aspectRatio) setAspectRatio(props.aspectRatio);
  });

  const logicalSize = createMemo(() => props.mappedSize || containerSize());
  const minSize = createMemo(() => {
    const logical = logicalSize();
    return {
      x: Math.min(100, logical.x * 0.1),
      y: Math.min(100, logical.y * 0.1),
    };
  });

  const logicalScale = createMemo(() => {
    const container = containerSize();
    const logical = logicalSize();
    return {
      x: container.x / logical.x,
      y: container.y / logical.y,
    };
  });

  const [scaledCrop, setScaledCrop] = createSignal(crop);
  createComputed(() => {
    const logical = logicalSize();
    const container = containerSize();
    const cpos = crop.position;
    const csize = crop.size;
    setScaledCrop({
      position: {
        x: (cpos.x / logical.x) * container.x,
        y: (cpos.y / logical.y) * container.y,
      },
      size: {
        x: (csize.x / logical.x) * container.x,
        y: (csize.y / logical.y) * container.y,
      },
    });
  });

  let containerRef: HTMLDivElement | undefined;
  let selAreaRef: HTMLDivElement | undefined;
  let snapRatioEl: HTMLDivElement | undefined;
  onMount(async () => {
    if (!containerRef || !selAreaRef) return;

    const updateContainerSize = () => {
      setContainerSize({
        x: containerRef!.clientWidth,
        y: containerRef!.clientHeight,
      });
    };

    updateContainerSize();
    const resizeObserver = new ResizeObserver(updateContainerSize);
    resizeObserver.observe(containerRef);

    let unlistenScaleFactor = await getCurrentWindow().onScaleChanged(
      () => updateContainerSize
    );

    onCleanup(() => {
      resizeObserver.disconnect();
      unlistenScaleFactor();
    });

    const logical = logicalSize();
    const initial = props.initialSize || {
      x: logical.x / 2,
      y: logical.y / 2,
    };

    let width = clamp(initial.x, minSize().x, logical.x);
    let height = clamp(initial.y, minSize().y, logical.y);

    const box = Box.from(
      { x: (logical.x - width) / 2, y: (logical.y - height) / 2 },
      { x: width, y: height }
    );
    box.constrainAll(
      box,
      containerSize(),
      ORIGIN_CENTER,
      aspectRatio() ?? undefined
    );

    setCrop({
      size: { x: box.width, y: box.height },
      position: {
        x: (logical.x - box.width) / 2,
        y: (logical.y - box.height) / 2,
      },
    });
  });

  createEffect(
    on(
      () => aspectRatio(),
      (ratio) => {
        if (!ratio) return;
        const box = Box.from(crop.position, crop.size);
        box.constrainToRatio(ratio, ORIGIN_CENTER);
        box.constrainToBoundary(
          logicalSize().x,
          logicalSize().y,
          ORIGIN_CENTER
        );
        setCrop(box.toBounds());
      }
    )
  );

  const [snapToRatioEnabled, setSnapToRatioEnabled] = makePersisted(
    createSignal(true),
    { name: "cropSnapsToRatio" }
  );
  const [selectedAspect, setSelectedAspect] = createSignal<Ratio | null>(null);
  createEffect(() => {
    const ratio = selectedAspect();
    if (!ratio) {
      setAspectRatio(null);
      return;
    }
    setAspectRatio(ratio[0] / ratio[1]);
  });
  const [snappedRatio, setSnappedRatio] = createSignal<Ratio | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const [resizing, setResizing] = createSignal(false);
  const [cursorStyle, setCursorStyle] = createSignal<string | null>(null);

  const [gestureState, setGestureState] = createStore({
    isTrackpadGesture: false,
    lastTouchCenter: null as XY<number> | null,
    initialPinchDistance: 0,
    initialSize: { width: 0, height: 0 },
  });

  createEffect(() => {
    if (resizing()) return;
    const selArea = selAreaRef;
    if (!selArea) return;
    const crop = scaledCrop();
    selArea.style.top = `${crop.position.y}px`;
    selArea.style.left = `${crop.position.x}px`;
    selArea.style.width = `${crop.size.x}px`;
    selArea.style.height = `${crop.size.y}px`;
    selArea.style.cursor = dragging() ? "grabbing" : "grab";
  });

  createEffect(() => {
    if (!resizing()) return;
    const crop = scaledCrop();
    const snapEl = snapRatioEl;
    if (!snapEl) return;

    snapEl.style.top = `${crop.position.y + 10}px`;
    snapEl.style.left = `${
      crop.position.x + crop.size.x / 2 - SNAP_RATIO_EL_WIDTH_PX / 2
    }px`;
  });

  function handleDragStart(event: MouseEvent) {
    if (gestureState.isTrackpadGesture) return; // Don't start drag if we're in a trackpad gesture
    event.stopPropagation();
    setDragging(true);
    setCursorStyle("grabbing");
    let lastValidPos = { x: event.clientX, y: event.clientY };
    const box = Box.from(crop.position, crop.size);
    const scaleFactors = logicalScale();

    createRoot((dispose) => {
      const logical = logicalSize();
      createEventListenerMap(window, {
        mouseup: () => {
          setDragging(false);
          setCursorStyle(null);
          dispose();
        },
        mousemove: (e) => {
          requestAnimationFrame(() => {
            const dx = (e.clientX - lastValidPos.x) / scaleFactors.x;
            const dy = (e.clientY - lastValidPos.y) / scaleFactors.y;

            box.move(
              clamp(box.x + dx, 0, logical.x - box.width),
              clamp(box.y + dy, 0, logical.y - box.height)
            );

            const newBox = box;
            if (newBox.x !== crop.position.x || newBox.y !== crop.position.y) {
              lastValidPos = { x: e.clientX, y: e.clientY };
              setCrop(newBox.toBounds());
            }
          });
        },
      });
    });
  }

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    const box = Box.from(crop.position, crop.size);
    const logical = logicalSize();

    if (event.ctrlKey) {
      setGestureState("isTrackpadGesture", true);

      const velocity = Math.max(0.001, Math.abs(event.deltaY) * 0.001);
      const scale = 1 - event.deltaY * velocity;

      box.resize(
        clamp(box.width * scale, minSize().x, logical.x),
        clamp(box.height * scale, minSize().y, logical.y),
        ORIGIN_CENTER
      );
      box.constrainAll(box, logical, ORIGIN_CENTER, props.aspectRatio);
      setTimeout(() => setGestureState("isTrackpadGesture", false), 100);
      setSnappedRatio(null);
    } else {
      const velocity = Math.max(1, Math.abs(event.deltaY) * 0.01);
      const scaleFactors = logicalScale();
      const dx = (-event.deltaX * velocity) / scaleFactors.x;
      const dy = (-event.deltaY * velocity) / scaleFactors.y;

      box.move(
        clamp(box.x + dx, 0, logical.x - box.width),
        clamp(box.y + dy, 0, logical.y - box.height)
      );
    }

    setCrop(box.toBounds());
  }

  function handleTouchStart(event: TouchEvent) {
    if (event.touches.length === 2) {
      // Initialize pinch zoom
      const distance = distanceOf(event.touches[0], event.touches[1]);

      // Initialize touch center
      const centerX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const centerY = (event.touches[0].clientY + event.touches[1].clientY) / 2;

      batch(() => {
        setGestureState("initialPinchDistance", distance);
        setGestureState("initialSize", {
          width: crop.size.x,
          height: crop.size.y,
        });
        setGestureState("lastTouchCenter", { x: centerX, y: centerY });
      });
    } else if (event.touches.length === 1) {
      // Handle single touch as drag
      batch(() => {
        setDragging(true);
        setGestureState("lastTouchCenter", {
          x: event.touches[0].clientX,
          y: event.touches[0].clientY,
        });
      });
    }
  }

  function handleTouchMove(event: TouchEvent) {
    if (event.touches.length === 2) {
      // Handle pinch zoom
      const currentDistance = distanceOf(event.touches[0], event.touches[1]);
      const scale = currentDistance / gestureState.initialPinchDistance;

      const box = Box.from(crop.position, crop.size);
      const logical = logicalSize();

      // Calculate new dimensions while maintaining aspect ratio
      const currentRatio = crop.size.x / crop.size.y;
      let newWidth = clamp(
        gestureState.initialSize.width * scale,
        minSize().x,
        logical.x
      );
      let newHeight = newWidth / currentRatio;

      // Adjust if height exceeds bounds
      if (newHeight < minSize().y || newHeight > logical.y) {
        newHeight = clamp(newHeight, minSize().y, logical.y);
        newWidth = newHeight * currentRatio;
      }

      // Resize from center
      box.resize(newWidth, newHeight, ORIGIN_CENTER);

      // Handle two-finger pan
      const centerX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const centerY = (event.touches[0].clientY + event.touches[1].clientY) / 2;

      if (gestureState.lastTouchCenter) {
        const scaleFactors = logicalScale();
        const dx = (centerX - gestureState.lastTouchCenter.x) / scaleFactors.x;
        const dy = (centerY - gestureState.lastTouchCenter.y) / scaleFactors.y;

        box.move(
          clamp(box.x + dx, 0, logical.x - box.width),
          clamp(box.y + dy, 0, logical.y - box.height)
        );
      }

      setGestureState("lastTouchCenter", { x: centerX, y: centerY });
      setCrop(box.toBounds());
    } else if (event.touches.length === 1 && dragging()) {
      // Handle single touch drag
      const box = Box.from(crop.position, crop.size);
      const scaleFactors = logicalScale();
      const logical = logicalSize();

      if (gestureState.lastTouchCenter) {
        const dx =
          (event.touches[0].clientX - gestureState.lastTouchCenter.x) /
          scaleFactors.x;
        const dy =
          (event.touches[0].clientY - gestureState.lastTouchCenter.y) /
          scaleFactors.y;

        box.move(
          clamp(box.x + dx, 0, logical.x - box.width),
          clamp(box.y + dy, 0, logical.y - box.height)
        );
      }

      setGestureState("lastTouchCenter", {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      });
      setCrop(box.toBounds());
    }
  }

  function handleTouchEnd(event: TouchEvent) {
    if (event.touches.length === 0) {
      setDragging(false);
      setGestureState("lastTouchCenter", null);
    } else if (event.touches.length === 1) {
      setGestureState("lastTouchCenter", {
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

  function findClosestRatio(
    width: number,
    height: number,
    threshold = 0.01
  ): Ratio | null {
    if (aspectRatio()) return null;
    const currentRatio = width / height;
    for (const ratio of COMMON_RATIOS) {
      if (Math.abs(currentRatio - ratio[0] / ratio[1]) < threshold) {
        return [ratio[0], ratio[1]];
      }
      if (Math.abs(currentRatio - ratio[1] / ratio[0]) < threshold) {
        return [ratio[1], ratio[0]];
      }
    }
    return null;
  }

  const [hapticsEnabled, setHapticsEnabled] = createSignal(false);
  if (ostype() === "macos") {
    generalSettingsStore
      .get()
      .then((s) => setHapticsEnabled(s?.hapticsEnabled || false));
  }

  function handleResizeStart(clientX: number, clientY: number, dir: Direction) {
    setResizing(true);
    const origin: XY<number> = {
      x: dir.includes("w") ? 1 : 0,
      y: dir.includes("n") ? 1 : 0,
    };

    let lastValidPos = { x: clientX, y: clientY };
    const box = Box.from(crop.position, crop.size);
    const scaleFactors = logicalScale();
    const logical = logicalSize();

    let rafId: number | null = null;
    createRoot((dispose) => {
      const cleanup = () => {
        rafId = null;
        setResizing(false);
        setCursorStyle(null);
        dispose();
      };

      createEventListenerMap(window, {
        mouseup: cleanup,
        touchend: cleanup,
        touchmove: (e) => {
          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              rafId = null;
              if (e.touches.length !== 1) return;
              handleResizeMove(e.touches[0].clientX, e.touches[0].clientY);
            });
          }
        },
        mousemove: (e) => {
          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              handleResizeMove(e.clientX, e.clientY, e.altKey);
              rafId = null;
            });
          }
        },
      });
    });

    function handleResizeMove(
      moveX: number,
      moveY: number,
      centerOrigin = false
    ) {
      const dx = (moveX - lastValidPos.x) / scaleFactors.x;
      const dy = (moveY - lastValidPos.y) / scaleFactors.y;

      const scaleMultiplier = centerOrigin ? 2 : 1;
      const currentBox = box.toBounds();

      let newWidth =
        dir.includes("e") || dir.includes("w")
          ? clamp(
              dir.includes("w")
                ? currentBox.size.x - dx * scaleMultiplier
                : currentBox.size.x + dx * scaleMultiplier,
              minSize().x,
              logical.x
            )
          : currentBox.size.x;

      let newHeight =
        dir.includes("n") || dir.includes("s")
          ? clamp(
              dir.includes("n")
                ? currentBox.size.y - dy * scaleMultiplier
                : currentBox.size.y + dy * scaleMultiplier,
              minSize().y,
              logical.y
            )
          : currentBox.size.y;

      const closest = findClosestRatio(newWidth, newHeight);
      if (dir.length === 2 && snapToRatioEnabled() && closest) {
        const ratio = closest[0] / closest[1];
        if (dir.includes("n") || dir.includes("s")) {
          newWidth = newHeight * ratio;
        } else {
          newHeight = newWidth / ratio;
        }
        if (!snappedRatio() && hapticsEnabled()) {
          commands.performHapticFeedback("Alignment", "Now");
        }
        setSnappedRatio(closest);
      } else {
        setSnappedRatio(null);
      }

      const newOrigin = centerOrigin ? ORIGIN_CENTER : origin;
      box.resize(newWidth, newHeight, newOrigin);

      if (aspectRatio()) {
        box.constrainToRatio(
          aspectRatio()!,
          newOrigin,
          dir.includes("n") || dir.includes("s") ? "width" : "height"
        );
      }
      box.constrainToBoundary(logical.x, logical.y, newOrigin);

      const newBox = box.toBounds();
      if (
        newBox.size.x !== crop.size.x ||
        newBox.size.y !== crop.size.y ||
        newBox.position.x !== crop.position.x ||
        newBox.position.y !== crop.position.y
      ) {
        lastValidPos = { x: moveX, y: moveY };
        setCrop(newBox);
      }
    }
  }

  let pressedKeys = new Set<string>([]);
  let lastKeyHandleFrame: number | null = null;
  function handleKeyDown(event: KeyboardEvent) {
    if (dragging()) return;
    const dir = KEY_MAPPINGS.get(event.key);
    if (!dir) return;
    event.preventDefault();
    pressedKeys.add(event.key);

    if (lastKeyHandleFrame) return;
    lastKeyHandleFrame = requestAnimationFrame(() => {
      const box = Box.from(crop.position, crop.size);
      const logical = logicalSize();
      const scaleFactors = logicalScale();

      const moveDelta = event.shiftKey ? 20 : 5;
      const origin = event.altKey ? ORIGIN_CENTER : { x: 0, y: 0 };

      for (const key of pressedKeys) {
        const dir = KEY_MAPPINGS.get(key);
        if (!dir) continue;

        const isUpKey = dir === "n";
        const isLeftKey = dir === "w";
        const isDownKey = dir === "s";
        const isRightKey = dir === "e";

        if (event.metaKey || event.ctrlKey) {
          const scaleMultiplier = event.altKey ? 2 : 1;
          const currentBox = box.toBounds();

          let newWidth = currentBox.size.x;
          let newHeight = currentBox.size.y;

          if (isLeftKey || isRightKey) {
            newWidth = clamp(
              isLeftKey
                ? currentBox.size.x - moveDelta * scaleMultiplier
                : currentBox.size.x + moveDelta * scaleMultiplier,
              minSize().x,
              logical.x
            );
          }

          if (isUpKey || isDownKey) {
            newHeight = clamp(
              isUpKey
                ? currentBox.size.y - moveDelta * scaleMultiplier
                : currentBox.size.y + moveDelta * scaleMultiplier,
              minSize().y,
              logical.y
            );
          }

          box.resize(newWidth, newHeight, origin);
        } else {
          const dx =
            (isRightKey ? moveDelta : isLeftKey ? -moveDelta : 0) /
            scaleFactors.x;
          const dy =
            (isDownKey ? moveDelta : isUpKey ? -moveDelta : 0) / scaleFactors.y;

          box.move(
            clamp(box.x + dx, 0, logical.x - box.width),
            clamp(box.y + dy, 0, logical.y - box.height)
          );
        }
      }

      if (aspectRatio()) box.constrainToRatio(aspectRatio()!, origin);
      box.constrainToBoundary(logical.x, logical.y, origin);
      setCrop(box.toBounds());

      pressedKeys.clear();
      lastKeyHandleFrame = null;
    });
  }

  async function menu() {
    const aspects = {
      id: "crop-options-aspect",
      text: "Aspect",
      enabled: !props.aspectRatio,
      items: [
        {
          id: "crop-options-aspect-none",
          text: "None",
          checked: !selectedAspect(),
          action: () => setSelectedAspect(null),
        } satisfies CheckMenuItemOptions,
        ...COMMON_RATIOS.map((ratio) => {
          return {
            id: `crop-options-aspect-${ratio[0]}-${ratio[1]}`,
            text: `${ratio[0]}:${ratio[1]}`,
            checked: selectedAspect() == ratio,
            action: () => setSelectedAspect(ratio),
          } satisfies CheckMenuItemOptions;
        }),
      ],
    } satisfies SubmenuOptions;

    const menu = await Menu.new({
      id: "crop-options",
      items: [
        {
          id: "enableRatioSnap",
          text: "Snap to aspect ratios",
          checked: snapToRatioEnabled(),
          action: () => {
            setSnapToRatioEnabled((v) => !v);
          },
        } satisfies CheckMenuItemOptions,
        {
          item: "Separator",
        } satisfies PredefinedMenuItemOptions,
        aspects,
      ],
    });

    menu.popup();
  }

  return (
    <div
      aria-label="Crop area"
      ref={containerRef}
      class={`relative h-full w-full overflow-hidden overscroll-contain *:overscroll-none ${props.class}`}
      style={{
        cursor: cursorStyle() ?? "auto",
      }}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      onContextMenu={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        menu();
      }}
    >
      <CropAreaRenderer
        bounds={{
          x: scaledCrop().position.x,
          y: scaledCrop().position.y,
          width: scaledCrop().size.x,
          height: scaledCrop().size.y,
        }}
        borderRadius={5}
        guideLines={props.showGuideLines}
        handles={true}
        highlighted={snappedRatio() !== null}
      >
        {props.children}
      </CropAreaRenderer>
      <div
        ref={selAreaRef}
        class="absolute"
        style={{
          visibility: resizing() ? "hidden" : "visible",
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
                  cursor: dragging() ? "grabbing" : handle.cursor,
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleResizeStart(e.clientX, e.clientY, handle.direction);
                  setCursorStyle(handle.cursor);
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
                  cursor: handle.cursor,
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleResizeStart(e.clientX, e.clientY, handle.direction);
                  setCursorStyle(handle.cursor);
                }}
                onTouchStart={(e) =>
                  handleResizeStartTouch(e, handle.direction)
                }
              />
            );
          }}
        </For>
      </div>
      <Transition
        name="slide"
        onEnter={(el, done) => {
          const animation = el.animate(
            [
              { opacity: 0, transform: "translateY(-8px)" },
              { opacity: 0.65, transform: "translateY(0)" },
            ],
            {
              duration: 150,
              easing: "cubic-bezier(0.65, 0, 0.35, 1)",
            }
          );
          animation.finished.then(done);
        }}
        onExit={(el, done) => {
          const animation = el.animate(
            [
              { opacity: 0.65, transform: "translateY(0)" },
              { opacity: 0, transform: "translateY(-8px)" },
            ],
            {
              duration: 150,
              easing: "ease-in",
            }
          );
          animation.finished.then(done);
        }}
      >
        <Show when={snappedRatio() !== null && !dragging()}>
          <div
            ref={snapRatioEl}
            style={{
              width: `${SNAP_RATIO_EL_WIDTH_PX}px`,
              top: `${scaledCrop().position.y + 10}px`,
              left: `${
                scaledCrop().position.x +
                scaledCrop().size.x / 2 -
                SNAP_RATIO_EL_WIDTH_PX / 2
              }px`,
            }}
            class="absolute bg-gray-3 opacity-90 h-6 rounded-[7px] text-center text-blue-11 text-sm border border-blue-9 outline-[#dedede] dark:outline-[#000]"
          >
            {snappedRatio()![0]}:{snappedRatio()![1]}
          </div>
        </Show>
      </Transition>
    </div>
  );
}
