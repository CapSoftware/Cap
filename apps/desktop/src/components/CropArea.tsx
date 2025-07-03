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
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Transition } from "solid-transition-group";
import { generalSettingsStore } from "~/store";
import { Box, type Ratio } from "~/utils/cropController";
import { type XY, commands } from "~/utils/tauri";
import CropAreaRenderer from "./CropAreaRenderer";
import { CropController } from "~/utils/cropController";

type Direction = "n" | "e" | "s" | "w" | "nw" | "ne" | "se" | "sw";
type HandleSide = {
  x: "l" | "r" | "c";
  y: "t" | "b" | "c";
  direction: Direction;
  cursor: `${"ew" | "ns" | "nesw" | "nwse"}-resize`;
};

const CURSOR_STYLE = {
  onDrag: "grabbing",
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

const COMMON_RATIOS: Ratio[] = [
  [1, 1],
  [4, 3],
  [3, 2],
  [16, 9],
  [2, 1],
  [21, 9],
];

const KEY_MAPPINGS = new Map([
  ["ArrowRight", "e"],
  ["ArrowDown", "s"],
  ["ArrowLeft", "w"],
  ["ArrowUp", "n"],
]);

const ORIGIN_CENTER = { x: 0.5, y: 0.5 };

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

function distanceOf(firstPoint: Touch, secondPoint: Touch): number {
  const dx = firstPoint.clientX - secondPoint.clientX;
  const dy = firstPoint.clientY - secondPoint.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function ratiosEqual(a: Ratio | null, b: Ratio): boolean {
  return a?.[0] === b[0] && a?.[1] === b[1];
}

export default function Cropper(
  props: ParentProps<{
    class?: string;
    controller: CropController;
  }>
) {
  const controller = props.controller;
  let containerRef: HTMLDivElement | undefined;
  let selAreaRef: HTMLDivElement | undefined;
  let snapRatioEl: HTMLDivElement | undefined;

  onMount(() => {
    if (!containerRef || !selAreaRef) return;
    controller._internalInitController(containerRef);
    onCleanup(controller._internalCleanupController);
  });

  const [ratioSnappingEnabled, setRatioSnappingEnabled] = makePersisted(
    createSignal(true),
    { name: "cropSnapsToRatio" }
  );

  const [interactionState, setInteractionState] = createStore({
    dragging: false,
    resizing: false,
    cursorStyle: "" as string | null,
  });

  const [aspectState, setAspectState] = createStore({
    snappedRatio: null as Ratio | null,
    selectedRatio: null as Ratio | null,
  });

  createEffect(() => {
    if (!interactionState.resizing) return;
    setAspectState("snappedRatio", null);
  });

  createEffect(
    on(
      () => aspectState.selectedRatio,
      (ratio) => {
        if (!ratio) return;
        const box = Box.fromBounds(controller.crop());
        box.constrainToRatio(ratio[0] / ratio[1], ORIGIN_CENTER);
        box.constrainToBoundary(
          controller.logicalMaxSize().x,
          controller.logicalMaxSize().y,
          ORIGIN_CENTER
        );
        controller.uncheckedSetCrop(box.toBounds());
      }
    )
  );

  // Reset aspect state when controller resets
  createEffect(() => {
    controller.resetTrigger();
    setAspectState({
      snappedRatio: null,
      selectedRatio: null,
    });
  });

  const effectiveAspectRatio = createMemo(() => {
    if (controller.options.aspectRatio) {
      return (
        controller.options.aspectRatio[0] / controller.options.aspectRatio[1]
      );
    }
    if (aspectState.selectedRatio) {
      return aspectState.selectedRatio[0] / aspectState.selectedRatio[1];
    }

    return null;
  });

  const [gestureState, setGestureState] = createStore({
    isTrackpadGesture: false,
    lastTouchCenter: null as XY<number> | null,
    initialPinchDistance: 0,
    initialSize: { width: 0, height: 0 },
  });

  async function menu() {
    const aspects = {
      id: "crop-options-aspect",
      text: controller.options.aspectRatio
        ? `Aspect (${controller.options.aspectRatio[0]}:${controller.options.aspectRatio[1]})`
        : "Aspect",
      enabled: !controller.options.aspectRatio,
      items: [
        {
          id: "crop-options-aspect-none",
          text: "None",
          checked: !aspectState.selectedRatio,
          action: () => setAspectState("selectedRatio", null),
        } satisfies CheckMenuItemOptions,
        ...COMMON_RATIOS.map((ratio) => {
          return {
            id: `crop-options-aspect-${ratio[0]}-${ratio[1]}`,
            text: `${ratio[0]}:${ratio[1]}`,
            checked: ratiosEqual(aspectState.selectedRatio, ratio),
            action: () => setAspectState("selectedRatio", ratio),
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
          checked: ratioSnappingEnabled(),
          action: () => {
            setRatioSnappingEnabled((v) => !v);
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

  const logicalScale = createMemo(() => {
    const container = controller.containerSize();
    const logical = controller.logicalMaxSize();
    return {
      x: container.x / logical.x,
      y: container.y / logical.y,
    };
  });

  const scaledCrop = createMemo(() => {
    const logical = controller.logicalMaxSize();
    const container = controller.containerSize();
    const crop = controller.crop();

    return {
      x: (crop.x / logical.x) * container.x,
      y: (crop.y / logical.y) * container.y,
      width: (crop.width / logical.x) * container.x,
      height: (crop.height / logical.y) * container.y,
    };
  });

  createEffect(() => {
    if (interactionState.resizing || !selAreaRef) return;
    const scaled = scaledCrop();
    selAreaRef.style.top = `${scaled.y}px`;
    selAreaRef.style.left = `${scaled.x}px`;
    selAreaRef.style.width = `${scaled.width}px`;
    selAreaRef.style.height = `${scaled.height}px`;
    selAreaRef.style.cursor = interactionState.dragging ? "grabbing" : "grab";
  });

  const snapRatioElementWidthPx = createMemo(() =>
    controller.options.aspectRatio ? 60 : 40
  );

  createEffect(() => {
    if (!interactionState.dragging) return;
    const snapEl = snapRatioEl;
    if (!snapEl) return;

    const scaled = scaledCrop();
    snapEl.style.top = `${scaled.y + 10}px`;
    snapEl.style.left = `${
      scaled.x + scaled.width / 2 - snapRatioElementWidthPx() / 2
    }px`;
  });

  function handleDragStart(e: MouseEvent) {
    if (gestureState.isTrackpadGesture) return; // Don't start drag if we're in a trackpad gesture
    e.stopPropagation();
    setInteractionState({
      dragging: true,
      cursorStyle: CURSOR_STYLE.onDrag,
    });

    createRoot((dispose) => {
      const box = Box.fromBounds(controller.crop());
      const logical = controller.logicalMaxSize();
      const scale = logicalScale();
      let lastValidPos = { x: e.clientX, y: e.clientY };

      createEventListenerMap(window, {
        mouseup: () => {
          setInteractionState({ dragging: false, cursorStyle: null });
          dispose();
        },
        mousemove: (e) => {
          const crop = controller.crop();
          const dx = (e.clientX - lastValidPos.x) / scale.x;
          const dy = (e.clientY - lastValidPos.y) / scale.y;

          box.move(
            Math.round(clamp(box.x + dx, 0, logical.x - box.width)),
            Math.round(clamp(box.y + dy, 0, logical.y - box.height))
          );

          const newBox = box;
          if (newBox.x !== crop.x || newBox.y !== crop.y) {
            lastValidPos = { x: e.clientX, y: e.clientY };
            controller.uncheckedSetCrop(newBox.toBounds());
          }
        },
      });
    });
  }

  const [hapticsEnabled, setHapticsEnabled] = createSignal(false);
  if (ostype() === "macos") {
    generalSettingsStore
      .get()
      .then((s) => setHapticsEnabled(s?.hapticsEnabled || false));
  }

  function findClosestRatio(
    width: number,
    height: number,
    threshold = 0.01
  ): Ratio | null {
    if (controller.options.aspectRatio) return null;

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

  function handleResizeStart(clientX: number, clientY: number, dir: Direction) {
    setInteractionState("resizing", true);
    const origin = {
      x: dir.includes("w") ? 1 : 0,
      y: dir.includes("n") ? 1 : 0,
    };

    let lastValidPos = { x: clientX, y: clientY };
    const box = Box.fromBounds(controller.crop());
    const scaleFactors = logicalScale();
    const logicalMax = controller.logicalMaxSize();
    const logicalMin = controller.logicalMinSize();

    function handleResizeMove(
      moveX: number,
      moveY: number,
      centerOrigin = false
    ) {
      const crop = controller.crop();
      const scaleMultiplier = centerOrigin ? 2 : 1;
      const dx = (moveX - lastValidPos.x) / scaleFactors.x;
      const dy = (moveY - lastValidPos.y) / scaleFactors.y;

      let newWidth =
        dir.includes("e") || dir.includes("w")
          ? clamp(
              dir.includes("w")
                ? box.width - dx * scaleMultiplier
                : box.width + dx * scaleMultiplier,
              logicalMin.x,
              logicalMax.x
            )
          : box.width;

      let newHeight =
        dir.includes("n") || dir.includes("s")
          ? clamp(
              dir.includes("n")
                ? box.height - dy * scaleMultiplier
                : box.height + dy * scaleMultiplier,
              logicalMin.y,
              logicalMax.y
            )
          : box.height;

      if (!aspectState.selectedRatio) {
        const closestRatio = findClosestRatio(newWidth, newHeight);
        if (dir.length === 2 && ratioSnappingEnabled() && closestRatio) {
          const ratio = closestRatio[0] / closestRatio[1];
          if (dir.includes("n") || dir.includes("s")) {
            newWidth = newHeight * ratio;
          } else {
            newHeight = newWidth / ratio;
          }
          if (!aspectState.snappedRatio && hapticsEnabled()) {
            commands.performHapticFeedback("Alignment", "Now");
          }
          setAspectState("snappedRatio", closestRatio);
        } else {
          setAspectState("snappedRatio", null);
        }
      }

      const newOrigin = centerOrigin ? ORIGIN_CENTER : origin;
      box.resize(newWidth, newHeight, newOrigin);

      const aspectRatio = effectiveAspectRatio();
      if (aspectRatio) {
        box.constrainToRatio(
          aspectRatio,
          newOrigin,
          dir.includes("n") || dir.includes("s") ? "width" : "height"
        );
      }
      box.constrainToBoundary(logicalMax.x, logicalMax.y, newOrigin);

      const newBounds = box.toBounds();
      if (
        newBounds.x !== crop.x ||
        newBounds.y !== crop.y ||
        newBounds.width !== crop.width ||
        newBounds.height !== crop.height
      ) {
        lastValidPos = { x: moveX, y: moveY };
        controller.uncheckedSetCrop(newBounds);
      }
    }

    createRoot((dispose) => {
      const cleanup = () => {
        setInteractionState({ resizing: false, cursorStyle: null });
        dispose();
      };

      createEventListenerMap(window, {
        mouseup: cleanup,
        touchend: cleanup,
        touchmove: (e) => {
          if (e.touches.length === 1) {
            handleResizeMove(e.touches[0].clientX, e.touches[0].clientY);
          }
        },
        mousemove: (e) => handleResizeMove(e.clientX, e.clientY, e.altKey),
      });
    });
  }

  function handleResizeStartTouch(event: TouchEvent, dir: Direction) {
    if (event.touches.length !== 1) return;
    event.stopPropagation();
    const touch = event.touches[0];
    handleResizeStart(touch.clientX, touch.clientY, dir);
  }

  function handleTouchStart(event: TouchEvent) {
    if (event.touches.length === 2) {
      // Initialize pinch zoom
      const distance = distanceOf(event.touches[0], event.touches[1]);

      // Initialize touch center
      const centerX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const centerY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      const crop = controller.crop();

      batch(() => {
        setInteractionState("resizing", true);
        setGestureState("initialPinchDistance", distance);
        setGestureState("initialSize", {
          width: crop.width,
          height: crop.height,
        });
        setGestureState("lastTouchCenter", { x: centerX, y: centerY });
      });
    } else if (event.touches.length === 1) {
      // Handle single touch as drag
      batch(() => {
        setInteractionState("dragging", true);
        setGestureState("lastTouchCenter", {
          x: event.touches[0].clientX,
          y: event.touches[0].clientY,
        });
      });
    }
  }

  function handleTouchMove(event: TouchEvent) {
    const box = Box.fromBounds(controller.crop());
    const crop = controller.crop();
    const logicalMax = controller.logicalMaxSize();

    if (event.touches.length === 2) {
      // Handle pinch zoom
      const currentDistance = distanceOf(event.touches[0], event.touches[1]);
      const scale = currentDistance / gestureState.initialPinchDistance;
      const logicalMin = controller.logicalMinSize();

      // Calculate new dimensions while maintaining aspect ratio
      const currentRatio = crop.width / crop.height;
      let newWidth = clamp(
        gestureState.initialSize.width * scale,
        logicalMin.x,
        logicalMax.x
      );
      let newHeight = newWidth / currentRatio;

      // Adjust if height exceeds bounds
      if (newHeight < logicalMin.y || newHeight > logicalMax.y) {
        newHeight = clamp(newHeight, logicalMin.y, logicalMax.y);
        newWidth = newHeight * currentRatio;
      }

      box.resize(Math.round(newWidth), Math.round(newHeight), ORIGIN_CENTER);

      // Handle two-finger pan
      const centerX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const centerY = (event.touches[0].clientY + event.touches[1].clientY) / 2;

      if (gestureState.lastTouchCenter) {
        const scaleFactors = logicalScale();
        const dx = (centerX - gestureState.lastTouchCenter.x) / scaleFactors.x;
        const dy = (centerY - gestureState.lastTouchCenter.y) / scaleFactors.y;

        box.move(
          Math.round(clamp(box.x + dx, 0, logicalMax.x - box.width)),
          Math.round(clamp(box.y + dy, 0, logicalMax.y - box.height))
        );
      }

      setGestureState("lastTouchCenter", { x: centerX, y: centerY });
    } else if (event.touches.length === 1 && interactionState.dragging) {
      // Handle single touch drag
      const scaleFactors = logicalScale();

      if (gestureState.lastTouchCenter) {
        const dx =
          (event.touches[0].clientX - gestureState.lastTouchCenter.x) /
          scaleFactors.x;
        const dy =
          (event.touches[0].clientY - gestureState.lastTouchCenter.y) /
          scaleFactors.y;

        box.move(
          Math.round(clamp(box.x + dx, 0, logicalMax.x - box.width)),
          Math.round(clamp(box.y + dy, 0, logicalMax.y - box.height))
        );
      }

      setGestureState("lastTouchCenter", {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      });
    }

    controller.uncheckedSetCrop(box.toBounds());
  }

  function handleTouchEnd(event: TouchEvent) {
    if (event.touches.length === 0) {
      batch(() => {
        setInteractionState("dragging", false);
        setGestureState("lastTouchCenter", null);
      });
    } else if (event.touches.length === 1) {
      setInteractionState("resizing", false);
      setGestureState("lastTouchCenter", {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      });
    }
  }

  let pressedKeys = new Set<string>([]);
  let lastKeyHandleFrame: number | null = null;

  function handleKeyUp() {
    pressedKeys.clear();
    lastKeyHandleFrame = null;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (interactionState.dragging) return;
    const dir = KEY_MAPPINGS.get(e.key);
    if (!dir) return;
    e.preventDefault();
    pressedKeys.add(e.key);
    const logicalMax = controller.logicalMaxSize();
    const logicalMin = controller.logicalMinSize();
    const scaleFactors = logicalScale();

    if (lastKeyHandleFrame) return;
    lastKeyHandleFrame = requestAnimationFrame(() => {
      const box = Box.fromBounds(controller.crop());
      const moveDelta = e.shiftKey ? 50 : 5;
      const origin = e.altKey ? ORIGIN_CENTER : { x: 0, y: 0 };

      for (const key of pressedKeys) {
        const dir = KEY_MAPPINGS.get(key);
        if (!dir) continue;

        const isUpKey = dir === "n";
        const isLeftKey = dir === "w";
        const isDownKey = dir === "s";
        const isRightKey = dir === "e";

        if (e.metaKey || e.ctrlKey) {
          const scaleMultiplier = e.altKey ? 2 : 1;

          let newWidth = box.width;
          let newHeight = box.height;

          if (isLeftKey || isRightKey) {
            newWidth = clamp(
              isLeftKey
                ? box.width - moveDelta * scaleMultiplier
                : box.width + moveDelta * scaleMultiplier,
              logicalMin.x,
              logicalMax.x
            );
          }

          if (isUpKey || isDownKey) {
            newHeight = clamp(
              isUpKey
                ? box.height - moveDelta * scaleMultiplier
                : box.height + moveDelta * scaleMultiplier,
              logicalMin.y,
              logicalMax.y
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
            clamp(box.x + dx, 0, logicalMax.x - box.width),
            clamp(box.y + dy, 0, logicalMax.y - box.height)
          );
        }
      }

      if (effectiveAspectRatio())
        box.constrainToRatio(effectiveAspectRatio()!, origin);
      box.constrainToBoundary(logicalMax.x, logicalMax.y, origin);

      controller.uncheckedSetCrop(box.toBounds());

      pressedKeys.clear();
      lastKeyHandleFrame = null;
    });
  }

  return (
    <div
      aria-label="Crop area"
      ref={containerRef}
      class={`relative h-full w-full overflow-hidden overscroll-contain *:overscroll-none ${props.class}`}
      style={{ cursor: interactionState.cursorStyle ?? "auto" }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      tabIndex={0}
      onContextMenu={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        menu();
      }}
    >
      <CropAreaRenderer
        bounds={scaledCrop()}
        borderRadius={6}
        guideLines={interactionState.dragging || interactionState.resizing}
        handles={true}
        highlighted={aspectState.snappedRatio !== null}
      >
        {props.children}
      </CropAreaRenderer>
      <div
        ref={selAreaRef}
        class="absolute"
        style={{
          visibility: interactionState.resizing ? "hidden" : "visible",
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
                  cursor: interactionState.dragging
                    ? "grabbing"
                    : handle.cursor,
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleResizeStart(e.clientX, e.clientY, handle.direction);
                  setInteractionState("cursorStyle", handle.cursor);
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
                  setInteractionState("cursorStyle", handle.cursor);
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
        <Switch>
          <Match
            when={
              aspectState.snappedRatio !== null && !interactionState.dragging
            }
          >
            <div
              ref={snapRatioEl}
              style={{
                width: `${snapRatioElementWidthPx()}px`,
                top: `${scaledCrop().y + 10}px`,
                left: `${
                  scaledCrop().x +
                  scaledCrop().width / 2 -
                  snapRatioElementWidthPx() / 2
                }px`,
              }}
              class="absolute bg-gray-3 opacity-90 h-6 rounded-[7px] text-center text-blue-11 text-sm border border-blue-9 outline-[#dedede] dark:outline-[#000]"
            >
              {aspectState.snappedRatio![0]}:{aspectState.snappedRatio![1]}
            </div>
          </Match>
          <Match
            when={
              interactionState.dragging || interactionState.resizing
                ? false
                : controller.options.aspectRatio
                ? controller.options.aspectRatio
                : aspectState.selectedRatio
            }
          >
            {(ratio) => {
              return (
                <div
                  ref={snapRatioEl}
                  style={{
                    width: `${snapRatioElementWidthPx()}px`,
                    top: `${scaledCrop().y + 10}px`,
                    left: `${
                      scaledCrop().x +
                      scaledCrop().width / 2 -
                      snapRatioElementWidthPx() / 2
                    }px`,
                  }}
                  class="absolute bg-gray-3 opacity-80 h-6 rounded-[7px] text-center text-neutral-300 text-sm border border-neutral-300 outline-[#dedede] dark:outline-[#000] flex items-center justify-evenly"
                >
                  <Show
                    when={
                      controller.options.aspectRatio !== null &&
                      !aspectState.selectedRatio
                    }
                  >
                    <IconLucideLock class="size-4" />
                  </Show>
                  {ratio()[0]}:{ratio()[1]}
                </div>
              );
            }}
          </Match>
        </Switch>
      </Transition>
    </div>
  );
}
