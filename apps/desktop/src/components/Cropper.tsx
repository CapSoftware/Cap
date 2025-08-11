import {
  createEventListener,
  createEventListenerMap,
} from "@solid-primitives/event-listener";
import {
  type ParentProps,
  Accessor,
  batch,
  children,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { createStore, SetStoreFunction } from "solid-js/store";
import { Transition } from "solid-transition-group";
import { commands } from "~/utils/tauri";
import { createResizeObserver } from "@solid-primitives/resize-observer";

export interface CropBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const CROP_ZERO: CropBounds = { x: 0, y: 0, width: 0, height: 0 };

type Direction = "n" | "e" | "s" | "w" | "nw" | "ne" | "se" | "sw";
type BoundsConstraints = {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
};

type HandleSide = {
  x: "l" | "r" | "c";
  y: "t" | "b" | "c";
  direction: Direction;
  cursor: string;
  movable: BoundsConstraints;
  origin: Vec2;
  isCorner: boolean;
};

// prettier-ignore
const HANDLES: readonly HandleSide[] = [
  { x: "l", y: "t", direction: "nw", cursor: "nwse-resize" },
  { x: "r", y: "t", direction: "ne", cursor: "nesw-resize" },
  { x: "l", y: "b", direction: "sw", cursor: "nesw-resize" },
  { x: "r", y: "b", direction: "se", cursor: "nwse-resize" },
  { x: "c", y: "t", direction: "n",  cursor: "ns-resize"   },
  { x: "c", y: "b", direction: "s",  cursor: "ns-resize"   },
  { x: "l", y: "c", direction: "w",  cursor: "ew-resize"   },
  { x: "r", y: "c", direction: "e",  cursor: "ew-resize"   },
].map(
  (handle) =>
    ({
      ...handle,
      movable: {
        top: handle.y === "t",
        bottom: handle.y === "b",
        left: handle.x === "l",
        right: handle.x === "r",
      },
      origin: {
        x: handle.x === "l" ? 1 : handle.x === "r" ? 0 : 0.5,
        y: handle.y === "t" ? 1 : handle.y === "b" ? 0 : 0.5,
      },
      isCorner: handle.x !== "c" && handle.y !== "c"
    } as HandleSide)
);

export type Ratio = [number, number];
export const COMMON_RATIOS: readonly Ratio[] = [
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 3],
  [16, 9],
  [21, 9],
];

function ratioToValue(ratio: Ratio): number {
  return ratio[0] / ratio[1];
}

function triggerHaptic() {
  commands.performHapticFeedback("Alignment", "DrawCompleted");
}

function findClosestRatio(
  width: number,
  height: number,
  threshold = 0.01
): Ratio | null {
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

const KEY_MAPPINGS: Readonly<Map<string, string>> = new Map([
  ["ArrowRight", "e"],
  ["ArrowDown", "s"],
  ["ArrowLeft", "w"],
  ["ArrowUp", "n"],
]);

type Vec2 = { x: number; y: number };
const ORIGIN_CENTER: Vec2 = { x: 0.5, y: 0.5 };

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

export type CropperRef = {
  fill: () => void;
  reset: () => void;
  setCrop: (value: CropBounds | ((bounds: CropBounds) => CropBounds)) => void;
  bounds: Accessor<CropBounds>;
};

export default function Cropper(
  props: ParentProps<{
    onCropChange?: (bounds: CropBounds) => void;
    ref?: CropperRef | ((ref: CropperRef) => void);
    class?: string;
    minSize?: Vec2;
    maxSize?: Vec2;
    targetSize?: Vec2;
    initialCrop?: CropBounds | (() => CropBounds | undefined);
    aspectRatio?: Ratio;
    showBounds?: boolean;
    snapToRatioEnabled?: boolean;
    disableBackdropFilters?: boolean;
  }>
) {
  let containerRef: HTMLDivElement | undefined;
  let regionRef: HTMLDivElement | undefined;

  const resolvedChildren = children(() => props.children);

  const [selectionClear, setSelectionClear] = createSignal(true);

  const [rawBounds, setRawBounds] = createSignal<CropBounds>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });

  const boundsTooSmall = createMemo(
    () => rawBounds().width <= 30 || rawBounds().height <= 30
  );

  const [state, setState] = createStore({
    dragging: false,
    resizing: false,
    overlayDragging: false,
    cursorStyle: null as string | null,
    hoveringHandle: null as HandleSide | null,
  });

  const [aspectState, setAspectState] = createStore({
    snapped: null as Ratio | null,
    selected: null as Ratio | null,
  });

  createEffect(() => {
    if (state.resizing) setAspectState("snapped", null);
  });

  const [containerSize, setContainerSize] = createSignal<Vec2>({ x: 1, y: 1 });
  const targetSize = createMemo(() => props.targetSize || containerSize());

  const logicalScale = createMemo<Vec2>(() => {
    if (props.targetSize) {
      const target = props.targetSize;
      const container = containerSize();
      return { x: target.x / container.x, y: target.y / container.y };
    }
    return { x: 1, y: 1 };
  });

  const realBounds = createMemo<CropBounds>(() => {
    const { x, y, width, height } = rawBounds();
    const scale = logicalScale();
    const bounds = {
      x: Math.round(x * scale.x),
      y: Math.round(y * scale.y),
      width: Math.round(width * scale.x),
      height: Math.round(height * scale.y),
    };
    props.onCropChange?.(bounds);
    return bounds;
  });

  function calculateLabelTransform(handle: HandleSide) {
    const bounds = rawBounds();
    const containerRect = containerRef!.getBoundingClientRect();
    const labelWidth = 80; // Approximate
    const labelHeight = 25; // Approximate
    const margin = 20; // Margin from viewport edges and handle

    const handleScreenX =
      containerRect.left +
      bounds.x +
      bounds.width * (handle.x === "l" ? 0 : handle.x === "r" ? 1 : 0.5);
    const handleScreenY =
      containerRect.top +
      bounds.y +
      bounds.height * (handle.y === "t" ? 0 : handle.y === "b" ? 1 : 0.5);

    let idealX = handleScreenX;
    let idealY = handleScreenY;

    if (handle.x === "l") {
      idealX -= labelWidth + margin; // left handle
    } else if (handle.x === "r") {
      idealX += margin; // right handle
    } else {
      idealX -= labelWidth / 2; // center handle
    }

    if (handle.y === "t") {
      idealY -= labelHeight + margin; // top handle
    } else if (handle.y === "b") {
      idealY += margin; // bottom handle
    } else {
      idealY -= labelHeight / 2; // center handle
    }

    const finalX = clamp(
      idealX,
      margin,
      window.innerWidth - labelWidth - margin
    );
    const finalY = clamp(
      idealY,
      margin,
      window.innerHeight - labelHeight - margin
    );

    return { x: finalX, y: finalY };
  }

  const labelTransform = createMemo(() =>
    state.resizing && state.hoveringHandle
      ? calculateLabelTransform(state.hoveringHandle)
      : null
  );

  function boundsToRaw(real: CropBounds) {
    const scale = logicalScale();
    return {
      x: real.x / scale.x,
      y: real.y / scale.y,
      width: real.width / scale.x,
      height: real.height / scale.y,
    };
  }

  function vec2ToRaw(real: Vec2) {
    const scale = logicalScale();
    return {
      x: real.x / scale.x,
      y: real.y / scale.y,
    };
  }

  const selectedAspectRatio = createMemo(() => {
    if (props.aspectRatio) return ratioToValue(props.aspectRatio);
    if (aspectState.selected) return ratioToValue(aspectState.selected);
    return null;
  });

  function rawSizeConstraint() {
    const scale = logicalScale();
    return {
      min: props.minSize
        ? {
            x: props.minSize.x / scale.x,
            y: props.minSize.y / scale.y,
          }
        : null,
      max: props.maxSize
        ? {
            x: props.maxSize.x / scale.x,
            y: props.maxSize.y / scale.y,
          }
        : null,
    };
  }

  function setRawBoundsConstraining(box: Box, origin = ORIGIN_CENTER) {
    const ratioValue = selectedAspectRatio();
    const container = containerSize();
    const { min, max } = rawSizeConstraint();

    box.constrainToSize(
      max?.x ?? null,
      max?.y ?? null,
      min?.x ?? null,
      min?.y ?? null,
      origin,
      ratioValue
    );

    if (ratioValue) {
      box.constrainToRatio(ratioValue, origin);
    }

    if (box.width > container.x) {
      box.scale(container.x / box.width, origin);
    }
    if (box.height > container.y) {
      box.scale(container.y / box.height, origin);
    }

    box.slideIntoBounds(container.x, container.y);
    setRawBounds(box.toBounds());
  }

  onMount(() => {
    if (!containerRef) return;
    let initialized = false;

    // We need to ensure the container size is valid.
    // In the Eidtor, the first time the modal opens we're given a size that's not correct
    // so we delay the initialization until we get a correct size.
    const updateContainerSize = (width: number, height: number) => {
      setContainerSize({
        x: width,
        y: height,
      });
      setRawBoundsConstraining(Box.fromBounds(rawBounds()));

      if (!initialized && width > 1 && height > 1) {
        initialized = true;
        init();
      }
    };

    createResizeObserver(containerRef, (e) =>
      updateContainerSize(e.width, e.height)
    );
    updateContainerSize(containerRef.clientWidth, containerRef.clientHeight);

    function init() {
      const target = targetSize();
      const initialCrop =
        typeof props.initialCrop === "function"
          ? props.initialCrop()
          : props.initialCrop;

      const box = Box.fromBounds(
        boundsToRaw(
          initialCrop ?? {
            x: 0,
            y: 0,
            width: Math.round(target.x / 2),
            height: Math.round(target.y / 2),
          }
        )
      );

      const ratioValue = selectedAspectRatio();
      if (ratioValue) box.constrainToRatio(ratioValue, ORIGIN_CENTER);
      const container = containerSize();

      box.constrainToBoundary(container.x, container.y, ORIGIN_CENTER);
      if (!initialCrop)
        box.move(
          container.x / 2 - box.width / 2,
          container.y / 2 - box.height / 2
        );

      setRawBounds(box.toBounds());
    }

    if (props.ref) {
      const fill = () => {
        const container = containerSize();
        setRawBounds({
          x: 0,
          y: 0,
          width: container.x,
          height: container.y,
        });
        setSelectionClear(false);
        setAspectState("snapped", null);
      };

      const cropperRef: CropperRef = {
        reset: () => {
          setSelectionClear(false);
          init();
          setAspectState("snapped", null);
        },
        fill,
        setCrop: (value) =>
          setRawBoundsConstraining(
            Box.fromBounds(
              boundsToRaw(
                typeof value === "function" ? value(rawBounds()) : value
              )
            )
          ),
        get bounds() {
          return realBounds;
        },
      };

      if (typeof props.ref === "function") {
        props.ref(cropperRef);
      } else {
        props.ref = cropperRef;
      }
    }
  });

  function onRegionMouseDown(e: MouseEvent) {
    if (!containerRef) return;
    e.stopPropagation();
    setState({
      cursorStyle: "grabbing",
      dragging: true,
    });
    const box = Box.fromBounds(rawBounds());
    const containerRect = containerRef.getBoundingClientRect();
    const startOffset = {
      x: e.clientX - containerRect.left - box.x,
      y: e.clientY - containerRect.top - box.y,
    };

    createRoot((dispose) =>
      createEventListenerMap(window, {
        mouseup: () => {
          setState({
            cursorStyle: null,
            dragging: false,
          });
          dispose();
        },
        mousemove: (e) => {
          let newX = e.clientX - containerRect.left - startOffset.x;
          let newY = e.clientY - containerRect.top - startOffset.y;

          newX = clamp(newX, 0, containerRect.width - box.width);
          newY = clamp(newY, 0, containerRect.height - box.height);

          box.move(newX, newY);
          setRawBounds(box.toBounds());
        },
      })
    );
  }

  function handleResizeMove(
    moveEvent: MouseEvent,
    startBounds: CropBounds,
    containerRect: DOMRect,
    handle: HandleSide,
    isAltMode: boolean
  ): CropBounds {
    const mouseX = clamp(
      moveEvent.clientX - containerRect.left,
      0,
      containerRect.width
    );
    const mouseY = clamp(
      moveEvent.clientY - containerRect.top,
      0,
      containerRect.height
    );

    const container = containerSize();
    const { min, max } = rawSizeConstraint();
    const ratioValue = selectedAspectRatio();

    if (ratioValue !== null) {
      return handleResizeWithAspectRatio(
        mouseX,
        mouseY,
        startBounds,
        container,
        handle,
        min,
        max,
        ratioValue
      );
    }

    const shiftKey = moveEvent.shiftKey;
    if (isAltMode) {
      return handleCenterOriginResize(
        mouseX,
        mouseY,
        startBounds,
        container,
        handle,
        min,
        max,
        shiftKey
      );
    } else {
      return handleAnchorPointResize(
        mouseX,
        mouseY,
        startBounds,
        container,
        handle,
        min,
        max,
        shiftKey
      );
    }
  }

  function handleResizeWithAspectRatio(
    mouseX: number,
    mouseY: number,
    startBounds: CropBounds,
    container: Vec2,
    handle: HandleSide,
    min: Vec2 | null,
    max: Vec2 | null,
    ratioValue: number
  ): CropBounds {
    // Calculate the anchor point (opposite corner from the handle being dragged)
    const anchorPoint = {
      x: startBounds.x + (handle.movable.left ? startBounds.width : 0),
      y: startBounds.y + (handle.movable.top ? startBounds.height : 0),
    };

    // Clamp mouse position to container boundaries
    const clampedMouseX = clamp(mouseX, 0, container.x);
    const clampedMouseY = clamp(mouseY, 0, container.y);

    let x1 = anchorPoint.x;
    let y1 = anchorPoint.y;
    let x2 = clampedMouseX;
    let y2 = clampedMouseY;

    // Lock axes for side handles
    if (!handle.movable.left && !handle.movable.right) {
      x1 = startBounds.x;
      x2 = startBounds.x + startBounds.width;
    }
    if (!handle.movable.top && !handle.movable.bottom) {
      y1 = startBounds.y;
      y2 = startBounds.y + startBounds.height;
    }

    // Calculate bounds without flipping (simpler approach)
    let newX = Math.min(x1, x2);
    let newY = Math.min(y1, y2);
    let newWidth = Math.abs(x1 - x2);
    let newHeight = Math.abs(y1 - y2);

    // Apply aspect ratio constraint
    const currentRatio = newWidth / newHeight;
    if (Math.abs(currentRatio - ratioValue) > 0.001) {
      // Determine which dimension to adjust based on handle movement
      const widthChanged = handle.movable.left || handle.movable.right;
      const heightChanged = handle.movable.top || handle.movable.bottom;

      if (widthChanged && !heightChanged) {
        // Width changed, adjust height
        newHeight = newWidth / ratioValue;
        if (anchorPoint.y > newY) {
          newY = anchorPoint.y - newHeight;
        }
      } else if (heightChanged && !widthChanged) {
        // Height changed, adjust width
        newWidth = newHeight * ratioValue;
        if (anchorPoint.x > newX) {
          newX = anchorPoint.x - newWidth;
        }
      } else {
        // Both dimensions changed, prefer the one that changed more
        const widthChange = Math.abs(newWidth - startBounds.width);
        const heightChange = Math.abs(newHeight - startBounds.height);

        if (widthChange > heightChange) {
          newHeight = newWidth / ratioValue;
          if (anchorPoint.y > newY) {
            newY = anchorPoint.y - newHeight;
          }
        } else {
          newWidth = newHeight * ratioValue;
          if (anchorPoint.x > newX) {
            newX = anchorPoint.x - newWidth;
          }
        }
      }
    }

    // Apply min/max size constraints while maintaining aspect ratio
    if (min || max) {
      let minWidth = min?.x ?? 0;
      let minHeight = min?.y ?? 0;
      let maxWidth = max?.x ?? Infinity;
      let maxHeight = max?.y ?? Infinity;

      // Adjust min and max to maintain aspect ratio
      if (min) {
        const minWidthForHeight = min.y * ratioValue;
        const minHeightForWidth = min.x / ratioValue;

        if (minWidthForHeight >= min.x) {
          // Height constraint is more restrictive
          minWidth = minWidthForHeight;
          minHeight = min.y;
        } else {
          // Width constraint is more restrictive
          minWidth = min.x;
          minHeight = minHeightForWidth;
        }
      }

      if (max) {
        const maxWidthForHeight = max.y * ratioValue;
        const maxHeightForWidth = max.x / ratioValue;

        if (maxWidthForHeight <= max.x) {
          // Height constraint is more restrictive
          maxWidth = maxWidthForHeight;
          maxHeight = max.y;
        } else {
          // Width constraint is more restrictive
          maxWidth = max.x;
          maxHeight = maxHeightForWidth;
        }
      }

      if (newWidth < minWidth) {
        const diff = minWidth - newWidth;
        newWidth = minWidth;
        if (anchorPoint.x > newX) {
          newX -= diff;
        }
      }
      if (newHeight < minHeight) {
        const diff = minHeight - newHeight;
        newHeight = minHeight;
        if (anchorPoint.y > newY) {
          newY -= diff;
        }
      }

      if (newWidth > maxWidth) {
        const diff = newWidth - maxWidth;
        newWidth = maxWidth;
        if (anchorPoint.x > newX) {
          newX += diff;
        }
      }
      if (newHeight > maxHeight) {
        const diff = newHeight - maxHeight;
        newHeight = maxHeight;
        if (anchorPoint.y > newY) {
          newY += diff;
        }
      }
    }

    // Apply container boundary constraints while maintaining aspect ratio
    let needsBoundaryAdjustment = false;
    let boundaryX = newX;
    let boundaryY = newY;
    let boundaryWidth = newWidth;
    let boundaryHeight = newHeight;

    if (
      boundaryX < 0 ||
      boundaryY < 0 ||
      boundaryX + boundaryWidth > container.x ||
      boundaryY + boundaryHeight > container.y
    ) {
      needsBoundaryAdjustment = true;
    }

    if (needsBoundaryAdjustment) {
      // Calculate the maximum size that fits within container bounds
      const maxWidthForContainer = container.x - boundaryX;
      const maxHeightForContainer = container.y - boundaryY;

      // Calculate what the dimensions should be to maintain aspect ratio
      const widthForHeight = maxHeightForContainer * ratioValue;
      const heightForWidth = maxWidthForContainer / ratioValue;

      // Choose the more restrictive constraint
      if (widthForHeight <= maxWidthForContainer) {
        // Height constraint is more restrictive
        boundaryWidth = widthForHeight;
        boundaryHeight = maxHeightForContainer;
      } else {
        // Width constraint is more restrictive
        boundaryWidth = maxWidthForContainer;
        boundaryHeight = heightForWidth;
      }

      // Constrain min size
      if (min) {
        const minWidthForHeight = min.y * ratioValue;
        const minHeightForWidth = min.x / ratioValue;

        let minWidth = min.x;
        let minHeight = min.y;

        if (minWidthForHeight >= min.x) {
          minWidth = minWidthForHeight;
          minHeight = min.y;
        } else {
          minWidth = min.x;
          minHeight = minHeightForWidth;
        }

        if (boundaryWidth < minWidth) {
          boundaryWidth = minWidth;
          boundaryHeight = minHeight;
        }
      }

      // Apply the boundary-adjusted dimensions
      newWidth = boundaryWidth;
      newHeight = boundaryHeight;

      // Adjust position to keep anchor point stable
      if (anchorPoint.x > newX) {
        newX = anchorPoint.x - newWidth;
      }
      if (anchorPoint.y > newY) {
        newY = anchorPoint.y - newHeight;
      }

      if (newX < 0) {
        newX = 0;
      }
      if (newY < 0) {
        newY = 0;
      }
    }

    return {
      x: Math.round(newX),
      y: Math.round(newY),
      width: Math.round(newWidth),
      height: Math.round(newHeight),
    };
  }

  function handleCenterOriginResize(
    mouseX: number,
    mouseY: number,
    startBounds: CropBounds,
    container: Vec2,
    handle: HandleSide,
    min: Vec2 | null,
    max: Vec2 | null,
    shiftKey: boolean
  ): CropBounds {
    const centerPoint = {
      x: startBounds.x + startBounds.width / 2,
      y: startBounds.y + startBounds.height / 2,
    };

    let newWidth =
      handle.movable.left || handle.movable.right
        ? Math.abs(mouseX - centerPoint.x) * 2
        : startBounds.width;

    let newHeight =
      handle.movable.top || handle.movable.bottom
        ? Math.abs(mouseY - centerPoint.y) * 2
        : startBounds.height;

    if (
      !shiftKey &&
      handle.isCorner &&
      props.snapToRatioEnabled &&
      !boundsTooSmall()
    ) {
      const closest = findClosestRatio(newWidth, newHeight);
      if (closest) {
        const priorSnapped = aspectState.snapped;
        const ratio = ratioToValue(closest);

        if (handle.movable.top || handle.movable.bottom) {
          newWidth = newHeight * ratio;
        } else {
          newHeight = newWidth / ratio;
        }

        setAspectState("snapped", closest);
        if (!priorSnapped) triggerHaptic();
      } else setAspectState("snapped", null);
    } else setAspectState("snapped", null);

    // Apply min/max size constraints
    if (min) {
      newWidth = Math.max(newWidth, min.x);
      newHeight = Math.max(newHeight, min.y);
    }
    if (max) {
      newWidth = Math.min(newWidth, max.x);
      newHeight = Math.min(newHeight, max.y);
    }

    // Calculate new position from center
    let newX = centerPoint.x - newWidth / 2;
    let newY = centerPoint.y - newHeight / 2;

    // Constrain to container boundaries
    if (newX < 0) {
      newWidth += newX;
      newX = 0;
    }
    if (newY < 0) {
      newHeight += newY;
      newY = 0;
    }
    if (newX + newWidth > container.x) {
      newWidth = container.x - newX;
    }
    if (newY + newHeight > container.y) {
      newHeight = container.y - newY;
    }

    return {
      x: Math.round(newX),
      y: Math.round(newY),
      width: Math.round(newWidth),
      height: Math.round(newHeight),
    };
  }

  function handleAnchorPointResize(
    mouseX: number,
    mouseY: number,
    startBounds: CropBounds,
    container: Vec2,
    handle: HandleSide,
    min: Vec2 | null,
    max: Vec2 | null,
    shiftKey: boolean
  ): CropBounds {
    // opposite corner from the handle being dragged
    const anchorPoint = {
      x: startBounds.x + (handle.movable.left ? startBounds.width : 0),
      y: startBounds.y + (handle.movable.top ? startBounds.height : 0),
    };

    // Clamp mouse position to container boundaries
    const clampedMouseX = clamp(mouseX, 0, container.x);
    const clampedMouseY = clamp(mouseY, 0, container.y);

    let x1 = anchorPoint.x;
    let y1 = anchorPoint.y;
    let x2 = clampedMouseX;
    let y2 = clampedMouseY;

    // Lock axes for side handles
    if (!handle.movable.left && !handle.movable.right) {
      x1 = startBounds.x;
      x2 = startBounds.x + startBounds.width;
    }
    if (!handle.movable.top && !handle.movable.bottom) {
      y1 = startBounds.y;
      y2 = startBounds.y + startBounds.height;
    }

    // Calculate bounds with flipping
    let newX = Math.min(x1, x2);
    let newY = Math.min(y1, y2);
    let newWidth = Math.abs(x1 - x2);
    let newHeight = Math.abs(y1 - y2);

    if (
      !shiftKey &&
      handle.isCorner &&
      props.snapToRatioEnabled &&
      !boundsTooSmall()
    ) {
      const closest = findClosestRatio(newWidth, newHeight);
      if (closest) {
        const priorSnapped = aspectState.snapped;
        const ratio = ratioToValue(closest);

        if (handle.movable.top || handle.movable.bottom) {
          newWidth = newHeight * ratio;
        } else {
          newHeight = newWidth / ratio;
        }

        // Adjust position so anchor point remains fixed after snapping
        if (anchorPoint.x > newX) {
          newX = anchorPoint.x - newWidth;
        }
        if (anchorPoint.y > newY) {
          newY = anchorPoint.y - newHeight;
        }

        setAspectState("snapped", closest);
        if (!priorSnapped) triggerHaptic();
      } else setAspectState("snapped", null);
    } else setAspectState("snapped", null);

    if (min) {
      if (newWidth < min.x) {
        const diff = min.x - newWidth;
        newWidth = min.x;
        if (anchorPoint.x > newX) {
          newX -= diff;
        }
      }
      if (newHeight < min.y) {
        const diff = min.y - newHeight;
        newHeight = min.y;
        if (anchorPoint.y > newY) {
          newY -= diff;
        }
      }
    }

    if (max) {
      if (newWidth > max.x) {
        const diff = newWidth - max.x;
        newWidth = max.x;
        if (anchorPoint.x > newX) {
          newX += diff;
        }
      }
      if (newHeight > max.y) {
        const diff = newHeight - max.y;
        newHeight = max.y;
        if (anchorPoint.y > newY) {
          newY += diff;
        }
      }
    }

    // Constrain to container size
    if (newX < 0) {
      newWidth += newX;
      newX = 0;
    }
    if (newY < 0) {
      newHeight += newY;
      newY = 0;
    }
    if (newX + newWidth > container.x) {
      newWidth = container.x - newX;
    }
    if (newY + newHeight > container.y) {
      newHeight = container.y - newY;
    }

    return {
      x: Math.round(newX),
      y: Math.round(newY),
      width: Math.round(newWidth),
      height: Math.round(newHeight),
    };
  }

  function updateHandleForModeSwitch(
    handle: HandleSide,
    currentBounds: CropBounds,
    mouseX: number,
    mouseY: number
  ): HandleSide {
    const center = {
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height / 2,
    };

    const newMovable = { ...handle.movable };
    if (handle.movable.left || handle.movable.right) {
      newMovable.left = mouseX < center.x;
      newMovable.right = mouseX >= center.x;
    }
    if (handle.movable.top || handle.movable.bottom) {
      newMovable.top = mouseY < center.y;
      newMovable.bottom = mouseY >= center.y;
    }

    return { ...handle, movable: newMovable };
  }

  type ResizeSessionState = {
    startBounds: CropBounds;
    isAltMode: boolean;
    activeHandle: HandleSide;
    originalHandle: HandleSide;
    containerRect: DOMRect;
  };

  function handleResizeMouseMove(e: MouseEvent, context: ResizeSessionState) {
    const mouseX = e.clientX - context.containerRect.left;
    const mouseY = e.clientY - context.containerRect.top;

    if (e.altKey !== context.isAltMode) {
      context.isAltMode = e.altKey;
      // for center origin drag needs to be updated
      context.startBounds = rawBounds();

      if (!context.isAltMode) {
        // When switching back to anchor mode, update the active handle
        context.activeHandle = updateHandleForModeSwitch(
          context.originalHandle,
          context.startBounds,
          mouseX,
          mouseY
        );
      } else {
        context.activeHandle = context.originalHandle;
      }
    }

    const bounds = handleResizeMove(
      e,
      context.startBounds,
      context.containerRect,
      context.activeHandle,
      context.isAltMode
    );

    setRawBounds(bounds);
  }

  function onHandleMouseDown(handle: HandleSide, e: MouseEvent) {
    e.stopPropagation();
    setState({
      cursorStyle: handle.cursor,
      resizing: true,
    });

    const context: ResizeSessionState = {
      containerRect: containerRef!.getBoundingClientRect(),
      startBounds: rawBounds(),
      isAltMode: e.altKey,
      activeHandle: { ...handle },
      originalHandle: handle,
    };

    createRoot((dispose) => {
      createEventListenerMap(window, {
        mouseup: () => {
          setState({
            cursorStyle: null,
            resizing: false,
          });
          dispose();
        },
        mousemove: (e) => handleResizeMouseMove(e, context),
      });
    });
  }

  function onOverlayMouseDown(e: MouseEvent) {
    if (!containerRef) return;
    e.preventDefault();
    e.stopPropagation();

    const initialBounds = { ...rawBounds() };
    const SE_HANDLE_INDEX = 3;
    const handle = HANDLES[SE_HANDLE_INDEX];

    setState({
      cursorStyle: "crosshair",
      overlayDragging: true,
      resizing: true,
    });

    const containerRect = containerRef!.getBoundingClientRect();
    const startMouse = {
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top,
    };

    const startBounds = {
      x: startMouse.x,
      y: startMouse.y,
      width: 1,
      height: 1,
    };

    const context: ResizeSessionState = {
      containerRect,
      startBounds,
      isAltMode: e.altKey,
      activeHandle: { ...handle },
      originalHandle: handle,
    };

    setRawBoundsConstraining(Box.fromBounds(startBounds));

    createRoot((dispose) => {
      createEventListenerMap(window, {
        mouseup: () => {
          setState({
            cursorStyle: null,
            overlayDragging: false,
            resizing: false,
          });

          // Prevent miss click
          const bounds = rawBounds();
          if (bounds.width < 5 || bounds.height < 5)
            setRawBounds(initialBounds);

          dispose();
        },
        mousemove: (e) => handleResizeMouseMove(e, context),
      });
    });
  }

  return (
    <div
      aria-label="Crop area"
      ref={containerRef}
      // prettier-ignore
      class={`relative inline-block top-0 left-0 h-full w-full overscroll-contain *:overscroll-none ${props.class ?? ""}`}
      style={{ cursor: state.cursorStyle ?? "crosshair" }}
      // onTouchStart={handleTouchStart}
      // onTouchMove={handleTouchMove}
      // onTouchEnd={handleTouchEnd}
      // onKeyDown={handleKeyDown}
      // onKeyUp={handleKeyUp}
      onMouseDown={onOverlayMouseDown}
      tabIndex={0}
      onContextMenu={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        // menu();
      }}
    >
      {/* <Show when={selectionClear()}>
        <div class="size-full flex items-center justify-center bg-black/30">
          <span class="animate-bounce text-2xl">Drag to select</span>
        </div>
      </Show> */}
      {/* <Show when={selectionClear()}> */}

      <Show when={true}>
        <div class="*:absolute *:bg-black/50 *:pointer-events-none">
          <div
            class="top-0 left-0"
            style={{
              width: "100%",
              height: `${rawBounds().y}px`,
            }}
          />
          <div
            class="left-0 bottom-0"
            style={{
              top: `${rawBounds().y + rawBounds().height}px`,
              width: "100%",
            }}
          />
          <div
            class="left-0"
            style={{
              top: `${rawBounds().y}px`,
              width: `${rawBounds().x}px`,
              height: `${rawBounds().height}px`,
            }}
          />
          <div
            class="right-0"
            style={{
              top: `${rawBounds().y}px`,
              left: `${rawBounds().x + rawBounds().width}px`,
              height: `${rawBounds().height}px`,
            }}
          />
        </div>
        <div
          ref={regionRef}
          class="absolute border border-white/50"
          // prettier-ignore
          style={{
            cursor: state.cursorStyle ?? "grab",
            transform: `translate3d(${Math.round(rawBounds().x)}px,${Math.round(rawBounds().y)}px, 0)`,
            width: `${rawBounds().width}px`,
            height: `${rawBounds().height}px`,
          }}
          onMouseDown={onRegionMouseDown}
        >
          <Transition
            appear
            enterClass="opacity-0"
            enterActiveClass="transition-opacity duration-300"
            enterToClass="opacity-100"
            exitClass="opacity-100"
            exitActiveClass="transition-opacity duration-300"
            exitToClass="opacity-0"
          >
            <Show when={state.dragging || state.resizing}>
              <div class="pointer-events-none">
                {/* Vertical lines */}
                <div class="absolute left-0 w-full border-t border-b border-white/50 pointer-events-none h-[calc(100%/3)] top-[calc(100%/3)]" />
                {/* Horizontal lines */}
                <div class="absolute top-0 h-full border-l border-r border-white/50 pointer-events-none w-[calc(100%/3)] left-[calc(100%/3)]" />
              </div>
            </Show>
          </Transition>

          <For each={HANDLES}>
            {(handle) =>
              handle.isCorner ? (
                <div
                  role="slider"
                  class="absolute z-50 flex h-[30px] w-[30px] *:border-white"
                  classList={{ "opacity-0": state.overlayDragging }}
                  // prettier-ignore
                  style={{
                    cursor:
                      !state.overlayDragging && state.resizing && state.hoveringHandle?.isCorner
                        ? state.hoveringHandle.cursor
                        : state.cursorStyle ?? handle.cursor,
                    ...(handle.x === "l" ? { left: "-12px" } : { right: "-12px" }),
                    ...(handle.y === "t" ? { top: "-12px" } : { bottom: "-12px" }),
                  }}
                  onMouseEnter={() => setState("hoveringHandle", { ...handle })}
                  onMouseDown={[onHandleMouseDown, handle]}
                  onTouchStart={(e) => {}}
                >
                  <div
                    class="absolute pointer-events-none"
                    classList={{
                      "size-1": boundsTooSmall(),
                      "size-6": !boundsTooSmall(),
                    }}
                    // prettier-ignore
                    style={{
                      ...(handle.x === "l" ? { left: "8px", "border-left-width": "3px" } : { right: "8px", "border-right-width": "3px" }),
                      ...(handle.y === "t" ? { top: "8px", "border-top-width": "3px" } : { bottom: "8px", "border-bottom-width": "3px" }),
                    }}
                  />
                </div>
              ) : (
                <div
                  role="slider"
                  class="absolute"
                  // prettier-ignore
                  style={{
                    visibility: state.resizing && state.hoveringHandle?.isCorner ? "hidden" : "visible",
                    cursor: state.cursorStyle ?? handle.cursor,
                    ...(handle.x === 'l' ? { left: '-1px', width: '10px', top: '10px', bottom: '10px', transform: 'translateX(-50%)' } :
                        handle.x === 'r' ? { right: '-1px', width: '10px', top: '10px', bottom: '10px', transform: 'translateX(50%)' } :
                        handle.y === 't' ? { top: '-1px', height: '10px', left: '10px', right: '10px', transform: 'translateY(-50%)' } :
                        { bottom: '-1px', height: '10px', left: '10px', right: '10px', transform: 'translateY(50%)' })
                  }}
                  onMouseEnter={() => setState("hoveringHandle", { ...handle })}
                  onMouseDown={[onHandleMouseDown, handle]}
                  onTouchStart={(e) => {}}
                />
              )
            }
          </For>

          {/* Aspect */}
          <Show
            when={
              !props.aspectRatio && !boundsTooSmall()
                ? aspectState.snapped
                : null
            }
          >
            {(bounds) => (
              <div class="w-full h-8 flex items-center justify-center">
                <div
                  class="h-[18px] w-11 rounded-full text-center text-xs text-gray-12 border border-gray-4 outline outline-1 outline-[#dedede] dark:outline-[#000]"
                  classList={{
                    "backdrop-blur-md": !props.disableBackdropFilters,
                    "bg-gray-3 opacity-90": props.disableBackdropFilters,
                  }}
                >
                  {bounds()[0]}:{bounds()[1]}
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <Transition
        appear
        enterClass="opacity-0"
        enterActiveClass="transition-opacity duration-200"
        enterToClass="opacity-100"
        exitClass="opacity-100"
        exitActiveClass="transition-opacity duration-200"
        exitToClass="opacity-0"
      >
        <Show when={props.showBounds && labelTransform()}>
          {(transform) => (
            <div
              class="fixed z-50 pointer-events-none bg-gray-2 text-xs px-2 py-0.5 rounded-full shadow-lg border border-gray-5 font-mono scale-50"
              // prettier-ignore
              style={{
                transform: `translate3d(${transform().x}px, ${transform().y}px, 0)`,
              }}
            >
              {realBounds().width} x {realBounds().height}
            </div>
          )}
        </Show>
      </Transition>

      {resolvedChildren()}
    </div>
  );
}

// Attribution to area-selection (MIT License) by 7anshuai
// https://github.com/7anshuai/area-selection
class Box implements CropBounds {
  x: number;
  y: number;
  width: number;
  height: number;

  static fromBounds(bounds: CropBounds) {
    return new Box(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  private constructor(x: number, y: number, width: number, height: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  toBounds(): CropBounds {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
    };
  }

  slideIntoBounds(boundaryWidth: number, boundaryHeight: number): Box {
    if (this.x < 0) this.x = 0;
    if (this.y < 0) this.y = 0;

    if (this.x + this.width > boundaryWidth) {
      this.x = boundaryWidth - this.width;
    }
    if (this.y + this.height > boundaryHeight) {
      this.y = boundaryHeight - this.height;
    }
    return this;
  }

  resize(newWidth: number, newHeight: number, origin: Vec2): Box {
    const fromX = this.x + this.width * origin.x;
    const fromY = this.y + this.height * origin.y;

    this.x = Math.round(fromX - newWidth * origin.x);
    this.y = Math.round(fromY - newHeight * origin.y);
    this.width = Math.round(newWidth);
    this.height = Math.round(newHeight);

    return this;
  }

  scale(factor: number, origin: Vec2): Box {
    const newWidth = this.width * factor;
    const newHeight = this.height * factor;
    return this.resize(newWidth, newHeight, origin);
  }

  move(x: number | null, y: number | null): Box {
    if (x !== null) {
      this.x = Math.round(x);
    }
    if (y !== null) {
      this.y = Math.round(y);
    }
    return this;
  }

  getAbsolutePoint(point: Vec2): Vec2 {
    return {
      x: this.x + this.width * point.x,
      y: this.y + this.height * point.y,
    };
  }

  getCenterPoint(): Vec2 {
    return {
      x: this.x + this.width * 0.5,
      y: this.y + this.height * 0.5,
    };
  }

  constrainToRatio(
    ratio: number,
    origin: Vec2,
    grow: "width" | "height" = "height"
  ) {
    if (!ratio) return this;

    const currentRatio = this.width / this.height;
    if (Math.abs(currentRatio - ratio) < 0.001) return this;

    switch (grow) {
      case "height":
        return this.resize(this.width, this.width / ratio, origin);
      case "width":
        return this.resize(this.height * ratio, this.height, origin);
      default:
        return this.resize(this.width, this.width / ratio, origin);
    }
  }

  constrainToBoundary(
    boundaryWidth: number,
    boundaryHeight: number,
    origin: Vec2
  ) {
    const originPoint = this.getAbsolutePoint(origin);

    const directionX = -2 * origin.x + 1;
    const directionY = -2 * origin.y + 1;

    let maxWidth: number;
    let maxHeight: number;

    switch (directionX) {
      case -1:
        maxWidth = originPoint.x;
        break;
      case 0:
        maxWidth = Math.min(originPoint.x, boundaryWidth - originPoint.x) * 2;
        break;
      case 1:
        maxWidth = boundaryWidth - originPoint.x;
        break;
      default:
        maxWidth = boundaryWidth;
    }

    switch (directionY) {
      case -1:
        maxHeight = originPoint.y;
        break;
      case 0:
        maxHeight = Math.min(originPoint.y, boundaryHeight - originPoint.y) * 2;
        break;
      case 1:
        maxHeight = boundaryHeight - originPoint.y;
        break;
      default:
        maxHeight = boundaryHeight;
    }

    if (this.width > maxWidth) {
      const factor = maxWidth / this.width;
      this.scale(factor, origin);
    }
    if (this.height > maxHeight) {
      const factor = maxHeight / this.height;
      this.scale(factor, origin);
    }
  }

  constrainToSize(
    maxWidth: number | null,
    maxHeight: number | null,
    minWidth: number | null,
    minHeight: number | null,
    origin: Vec2,
    ratio: number | null = null
  ) {
    if (ratio) {
      if (ratio > 1) {
        maxWidth = maxHeight ? maxHeight / ratio : maxWidth;
        minHeight = minWidth ? minWidth * ratio : minHeight;
      } else if (ratio < 1) {
        maxHeight = maxWidth ? maxWidth * ratio : maxHeight;
        minWidth = minHeight ? minHeight / ratio : minWidth;
      }
    }

    if (maxWidth && this.width > maxWidth) {
      const newWidth = maxWidth;
      const newHeight = ratio === null ? this.height : maxHeight!;
      this.resize(newWidth, newHeight, origin);
    }

    if (maxHeight && this.height > maxHeight) {
      const newWidth = ratio === null ? this.width : maxWidth!;
      const newHeight = maxHeight;
      this.resize(newWidth, newHeight, origin);
    }

    if (minWidth && this.width < minWidth) {
      const newWidth = minWidth;
      const newHeight = ratio === null ? this.height : minHeight!;
      this.resize(newWidth, newHeight, origin);
    }

    if (minHeight && this.height < minHeight) {
      const newWidth = ratio === null ? this.width : minWidth!;
      const newHeight = minHeight;
      this.resize(newWidth, newHeight, origin);
    }
  }
}
