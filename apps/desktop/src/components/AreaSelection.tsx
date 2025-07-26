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
  Accessor,
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
import { createStore, SetStoreFunction } from "solid-js/store";
import { Transition } from "solid-transition-group";
import { generalSettingsStore } from "~/store";
import { type XY, commands } from "~/utils/tauri";
import CropAreaRenderer from "./CropAreaRenderer";
import { CropController } from "~/utils/cropController";
import { stat } from "@tauri-apps/plugin-fs";
import { createHiDPICanvasContext } from "~/utils/canvas";

export interface CropBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Direction = "n" | "e" | "s" | "w" | "nw" | "ne" | "se" | "sw";
type BoundsConstraints = {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
};
interface BaseHandle {
  x: "l" | "r" | "c";
  y: "t" | "b" | "c";
  direction: Direction;
  cursor: `${"ew" | "ns" | "nesw" | "nwse"}-resize`;
}
interface HandleSide extends BaseHandle {
  constraints: BoundsConstraints;
}

const HANDLES: readonly HandleSide[] = [
  { x: "l", y: "t", direction: "nw", cursor: "nwse-resize" },
  { x: "r", y: "t", direction: "ne", cursor: "nesw-resize" },
  { x: "l", y: "b", direction: "sw", cursor: "nesw-resize" },
  { x: "r", y: "b", direction: "se", cursor: "nwse-resize" },
  { x: "c", y: "t", direction: "n", cursor: "ns-resize" },
  { x: "c", y: "b", direction: "s", cursor: "ns-resize" },
  { x: "l", y: "c", direction: "w", cursor: "ew-resize" },
  { x: "r", y: "c", direction: "e", cursor: "ew-resize" },
].map(
  (handle) =>
    ({
      ...handle,
      constraints: {
        top: handle.y === "t",
        bottom: handle.y === "b",
        left: handle.x === "l",
        right: handle.x === "r",
      },
    } as HandleSide)
);

type Ratio = [number, number];
const COMMON_RATIOS: readonly Ratio[] = [
  [1, 1],
  [4, 3],
  [3, 2],
  [16, 9],
  [2, 1],
  [21, 9],
];

function ratioToValue(ratio: Ratio): number {
  return ratio[0] / ratio[1];
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
  }>
) {
  let containerRef: HTMLDivElement | undefined;
  let regionRef: HTMLDivElement | undefined;

  const [rawBounds, setRawBounds] = createStore<CropBounds>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });

  const [state, setState] = createStore({
    dragging: false,
    resizing: false,
    cursorStyle: "" as string | null,
  });

  const [aspectState, setAspectState] = createStore({
    snapped: null as Ratio | null,
    selected: null as Ratio | null,
  });

  const [containerSize, setContainerSize] = createSignal<Vec2>({ x: 1, y: 1 });
  const targetSize = createMemo<Vec2>(
    () => props.targetSize || containerSize()
  );
  const logicalScale = createMemo<Vec2>(() => {
    const target = targetSize();
    if (props.targetSize) {
      const container = containerSize();
      return { x: target.x / container.x, y: target.y / container.y };
    } else {
      return target;
    }
  });

  const realBounds = createMemo<CropBounds>(() => {
    const { x, y, width, height } = rawBounds;
    const scale = logicalScale();
    return {
      x: x * scale.x,
      y: y * scale.y,
      width: width * scale.x,
      height: height * scale.y,
    };
  });

  // createEffect(() => {
  //   if (!regionRef) return;
  //   const { x, y, width, height } = rawBounds;
  //   requestAnimationFrame(() => {
  //     // prettier-ignore
  //     regionRef.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  //     regionRef.style.width = `${Math.round(width)}px`;
  //     regionRef.style.height = `${Math.round(height)}px`;
  //   });
  // });

  createEffect(
    on(
      () => containerSize(),
      () => setRawBoundsConstraining(rawBounds)
    )
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

  const effectiveAspectRatio = createMemo(() => {
    if (props.aspectRatio) return ratioToValue(props.aspectRatio);
    if (aspectState.selected) return ratioToValue(aspectState.selected);
    return null;
  });

  const rawSizeConstraint = createMemo(() => {
    return {
      min: props.minSize ? vec2ToRaw(props.minSize) : null,
      max: props.maxSize ? vec2ToRaw(props.maxSize) : null,
    };
  });

  function setRawBoundsConstraining(raw: CropBounds) {
    const box = Box.fromBounds(raw);
    const ratioValue = effectiveAspectRatio();
    if (ratioValue) box.constrainToRatio(ratioValue, ORIGIN_CENTER);
    const container = containerSize();
    box.constrainToBoundary(container.x, container.y, ORIGIN_CENTER);

    const { min, max } = rawSizeConstraint();
    box.constrainToSize(
      min?.x ?? null,
      min?.y ?? null,
      max?.x ?? null,
      max?.y ?? null,
      ORIGIN_CENTER,
      ratioValue
    );
    setRawBounds(box.toBounds());
  }

  function setCrop(value: CropBounds | ((bounds: CropBounds) => CropBounds)) {
    let bounds: CropBounds | undefined;
    if (typeof value === "function") {
      bounds = value(rawBounds);
    } else {
      bounds = value;
    }
    setRawBoundsConstraining(boundsToRaw(bounds));
  }

  onMount(() => {
    if (!containerRef) return;
    let resizeObserver: ResizeObserver | undefined;

    const updateContainerSize = () => {
      setContainerSize({
        x: containerRef.clientWidth,
        y: containerRef.clientHeight,
      });
    };
    updateContainerSize();

    resizeObserver = new ResizeObserver(updateContainerSize);
    resizeObserver.observe(containerRef);

    function init() {
      const target = targetSize();
      const initialCrop =
        typeof props.initialCrop === "function"
          ? props.initialCrop()
          : props.initialCrop;

      const box = Box.fromBounds(
        initialCrop
          ? boundsToRaw(initialCrop)
          : {
              x: 0,
              y: 0,
              width: target.x / 2,
              height: target.y / 2,
            }
      );

      const ratioValue = effectiveAspectRatio();
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
    init();

    if (props.ref) {
      const fill = () => {
        const container = containerSize();
        setRawBounds({
          x: 0,
          y: 0,
          width: container.x,
          height: container.y,
        });
      };

      const cropperRef = {
        reset: init,
        fill,
        setCrop,
        bounds: realBounds,
      };

      if (typeof props.ref === "function") {
        props.ref(cropperRef);
      } else {
        props.ref = cropperRef;
      }
    }

    onCleanup(() => {
      resizeObserver?.disconnect();
    });
  });

  function onRegionMouseDown(e: MouseEvent) {
    if (!containerRef) return;
    e.stopPropagation();
    setState({
      cursorStyle: "grabbing",
      dragging: true,
    });
    const box = Box.fromBounds(rawBounds);
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
          setRawBounds(box);
        },
      })
    );
  }

  function handleResizeMove(
    e: MouseEvent,
    containerRect: DOMRect,
    startOrigin: Vec2,
    anchorPoint: Vec2,
    movable: BoundsConstraints
  ) {
    let mouseX = e.clientX - containerRect.left;
    let mouseY = e.clientY - containerRect.top;
    mouseX = clamp(mouseX, 0, containerRect.width);
    mouseY = clamp(mouseY, 0, containerRect.height);

    const raw = rawBounds;
    let x1 = movable.left || movable.right ? startOrigin.x : raw.x;
    let y1 = movable.top || movable.bottom ? startOrigin.y : raw.y;
    let x2 = movable.left || movable.right ? startOrigin.x : raw.x + raw.width;
    let y2 = movable.top || movable.bottom ? startOrigin.y : raw.y + raw.height;

    if (movable.left) x1 = mouseX;
    if (movable.right) x2 = mouseX;
    if (movable.top) y1 = mouseY;
    if (movable.bottom) y2 = mouseY;

    // lock the non-moving sides to the anchor point
    if (movable.left || movable.right) {
      if (!movable.left) x1 = anchorPoint.x;
      if (!movable.right) x2 = anchorPoint.x;
    }
    if (movable.top || movable.bottom) {
      if (!movable.top) y1 = anchorPoint.y;
      if (!movable.bottom) y2 = anchorPoint.y;
    }

    // Handle "flipping" if the mouse crosses the anchor point
    if (x1 > x2) [x1, x2] = [x2, x1]; // Swap x1 and x2
    if (y1 > y2) [y1, y2] = [y2, y1]; // Swap y1 and y2

    setRawBoundsConstraining({
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
    });
  }

  function onHandleMouseDown(handle: HandleSide, e: MouseEvent) {
    if (!containerRef) return;
    e.stopPropagation();
    setState({
      cursorStyle: handle.cursor,
      resizing: true,
    });
    const box = Box.fromBounds(rawBounds);
    const containerRect = containerRef.getBoundingClientRect();

    const origin: Vec2 = {
      x: handle.x === "l" ? 1 : handle.x === "r" ? 0 : 0.5,
      y: handle.y === "t" ? 1 : handle.y === "b" ? 0 : 0.5,
    };

    // anchor point on the screen.
    const anchorPoint = {
      x: rawBounds.x + rawBounds.width * origin.x,
      y: rawBounds.y + rawBounds.height * origin.y,
    };

    const movable = handle.constraints;

    createRoot((dispose) => {
      createEventListenerMap(window, {
        mouseup: () => {
          setState({
            cursorStyle: null,
            resizing: false,
          });
          dispose();
        },
        mousemove: (e) =>
          handleResizeMove(e, containerRect, origin, anchorPoint, movable),
      });
    });
  }

  function onOverlayMouseDown(e: MouseEvent) {
    if (!containerRef) return;
    e.preventDefault();
    e.stopPropagation();
    setState({
      cursorStyle: "crosshair",
      resizing: true,
    });

    const SE_HANDLE_INDEX = 3;
    const handle = HANDLES[SE_HANDLE_INDEX];
    const previousBounds = { ...rawBounds };
    const containerRect = containerRef.getBoundingClientRect();
    const startMouse = {
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top,
    };

    setRawBounds({
      x: startMouse.x,
      y: startMouse.y,
      width: 5,
      height: 5,
    });

    const origin: Vec2 = { x: 0, y: 0 };
    const anchorPoint = { x: rawBounds.x, y: rawBounds.y };

    createRoot((dispose) =>
      createEventListenerMap(window, {
        mouseup: () => {
          batch(() => {
            if (rawBounds.width < 10 && rawBounds.height < 10)
              setRawBounds(previousBounds);

            setState({
              cursorStyle: null,
              resizing: false,
            });
          });
          dispose();
        },
        mousemove: (e) =>
          handleResizeMove(
            e,
            containerRect,
            origin,
            anchorPoint,
            handle.constraints
          ),
      })
    );
  }

  return (
    <div
      aria-label="Crop area"
      ref={containerRef}
      class={`relative h-full w-full overflow-hidden overscroll-contain *:overscroll-none ${
        props.class ?? ""
      }`}
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
      <div
        ref={regionRef}
        class="absolute will-change-transform border-red-10 border-2 z-10"
        style={{
          cursor: state.dragging ? "grabbing" : "grab",
          visibility: state.resizing || state.dragging ? "hidden" : "visible",
          // prettier-ignore
          transform: `translate(${Math.round(rawBounds.x)}px,${Math.round(rawBounds.y)}px)`,
          width: `${rawBounds.width}px`,
          height: `${rawBounds.height}px`,
        }}
        onMouseDown={onRegionMouseDown}
      >
        <For each={HANDLES}>
          {(handle) => {
            const isCorner = handle.x !== "c" && handle.y !== "c";

            return isCorner ? (
              <div
                role="slider"
                class="absolute z-10 flex h-[30px] w-[30px] items-center justify-center border-blue-8 border-2"
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
                  cursor: state.dragging ? "grabbing" : handle.cursor,
                }}
                onMouseDown={[onHandleMouseDown, handle]}
                onTouchStart={(e) => {}}
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
                onMouseDown={[onHandleMouseDown, handle]}
                onTouchStart={(e) => {}}
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}

function AreaRenderer(props: { bounds: CropBounds }) {
  let canvasRef: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D;

  function draw() {}

  onMount(() => {
    if (!canvasRef) return;
    const hidpiCanvas = createHiDPICanvasContext(canvasRef, draw);
    if (!hidpiCanvas) return;
    ctx = hidpiCanvas.ctx;
    // TODO
    onCleanup(hidpiCanvas.cleanup);
  });

  return (
    <canvas ref={canvasRef} class="size-full pointer-events-none"></canvas>
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

  static default() {
    return new Box(0, 0, 0, 0);
  }

  private constructor(x: number, y: number, width: number, height: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  reset() {
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
  }

  toBounds(): CropBounds {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
    };
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
