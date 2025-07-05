import { createStore, SetStoreFunction, type Store } from "solid-js/store";
import {
  createSignal,
  createMemo,
  type Accessor,
  createEffect,
  on,
} from "solid-js";

type Vec2 = { x: number; y: number };
export type CropBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type Ratio = [number, number];

const ORIGIN_CENTER: Vec2 = { x: 0.5, y: 0.5 };

type CropControllerOptions = {
  mappedSize?: Vec2;
  minSize?: Vec2;
  maxSize?: Vec2;
  aspectRatio?: Ratio;
  initialCrop?: CropBounds;
};

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

function roundBounds(bounds: CropBounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

export type CropController = {
  crop: Accessor<CropBounds>;
  setCrop: (bounds: CropBounds) => void;
  options: Store<CropControllerOptions>;
  setOptions: SetStoreFunction<CropControllerOptions>;
  aspectRatioValue: Accessor<number | null>;
  logicalMaxSize: Accessor<Vec2>;
  logicalMinSize: Accessor<Vec2>;
  containerSize: Accessor<Vec2>;
  fill: () => void;
  reset: () => void;
  resetTrigger: Accessor<number>;
  uncheckedSetCrop: (bounds: CropBounds) => void;
  uncheckedUpdateBox: (updater: (currentBox: Box) => Box | null) => void;
  onReset: (fn: () => void) => void;
  // Internal lifecycle methods
  _internalInitController: (containerElement: HTMLElement) => void;
  _internalCleanupController: () => void;
};

export function createCropController(
  initialOptions: CropControllerOptions
): CropController {
  let box = initialOptions.initialCrop
    ? Box.fromBounds(initialOptions.initialCrop)
    : Box.default();

  const [cropBounds, setCropBounds] = createSignal(box as CropBounds);
  const [options, setOptions] = createStore(initialOptions);
  const [containerSize, setContainerSize] = createSignal({ x: 1, y: 1 });
  const [aspectRatioValue, setAspectRatioValue] = createSignal<number | null>(
    null
  );

  const [resetTrigger, setResetTrigger] = createSignal(0);

  let resizeObserver: ResizeObserver | null = null;

  const logicalMaxSize = createMemo(
    () => options.mappedSize || containerSize()
  );

  const logicalMinSize = createMemo(() => {
    const logical = logicalMaxSize();
    return {
      x: Math.max(100, options.minSize?.x ?? logical.x * 0.1),
      y: Math.max(100, options.minSize?.y ?? logical.y * 0.1),
    };
  });

  const setBoxAndApplyConstraints = (withBox?: Box) => {
    const newBox = withBox ? withBox : box;
    const currentOptions = options;
    const container = containerSize();
    const min = logicalMinSize();

    const ratio = aspectRatioValue();
    if (ratio) {
      newBox.constrainToRatio(ratio, ORIGIN_CENTER);
    }

    newBox.constrainToSize(
      currentOptions.maxSize?.x || null,
      currentOptions.maxSize?.y || null,
      min.x,
      min.y,
      ORIGIN_CENTER,
      ratio
    );

    newBox.constrainToBoundary(container.x, container.y, ORIGIN_CENTER);
    setCropBounds(newBox.toBounds());
  };

  const uncheckedSetCrop = (bounds: CropBounds) => {
    box.setFromBounds(bounds);
    setCropBounds(bounds);
  };

  const setCrop = (bounds: CropBounds) => {
    box.setFromBounds(bounds);
    setBoxAndApplyConstraints(box);
  };

  const uncheckedUpdateBox = (updater: (currentBox: Box) => Box | null) => {
    const newBox = updater(box);
    if (newBox) {
      setCropBounds(newBox.toBounds());
      box = newBox;
    }
  };

  createEffect(
    on(
      () => [options.aspectRatio, options.minSize, options.maxSize],
      () => {
        setBoxAndApplyConstraints();
      }
    )
  );

  createEffect(
    on(
      () => options.aspectRatio,
      () => {
        if (options.aspectRatio) {
          setAspectRatioValue(
            options.aspectRatio![0] / options.aspectRatio![1]
          );
        }
      }
    )
  );

  let resetListeners: (() => void)[] = [];

  const onReset = (fn: () => void) => {
    resetListeners.push(fn);
  };

  const initBox = (useInitial = true) => {
    let newBox: Box;
    if (useInitial && initialOptions.initialCrop) {
      const bounds = roundBounds(initialOptions.initialCrop);
      box = Box.fromBounds(bounds);
      setCropBounds(bounds);
    } else {
      const mapped = options.mappedSize || containerSize();

      let width = clamp(mapped.x / 2, logicalMinSize().x, mapped.x);
      let height = clamp(mapped.y / 2, logicalMinSize().y, mapped.y);

      newBox = Box.fromBounds(
        roundBounds({
          x: (mapped.x - width) / 2,
          y: (mapped.y - height) / 2,
          width,
          height,
        })
      );

      if (options.aspectRatio) {
        newBox.constrainToRatio(
          options.aspectRatio[0] / options.aspectRatio[1],
          ORIGIN_CENTER
        );
      }

      box = newBox;
      setCropBounds(newBox.toBounds());
    }
  };

  const init = (containerElement: HTMLElement) => {
    const updateSize = () => {
      setContainerSize({
        x: containerElement.clientWidth,
        y: containerElement.clientHeight,
      });
    };
    updateSize();
    resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(containerElement);

    initBox();
  };

  const cleanup = () => {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  };

  const fill = () => {
    // Set the crop to the maximum allowed size, constrained by aspect ratio if present
    const mapped = options.mappedSize || containerSize();
    const min = logicalMinSize();
    let width = mapped.x;
    let height = mapped.y;

    // If aspect ratio is set, constrain the box to that ratio
    let ratio: number | null = null;
    if (options.aspectRatio) {
      ratio = options.aspectRatio[0] / options.aspectRatio[1];
    } else if (aspectRatioValue()) {
      ratio = aspectRatioValue();
    }

    if (ratio) {
      // Fit the largest box of the given aspect ratio inside mapped size
      if (mapped.x / mapped.y > ratio) {
        // Container is wider than ratio, fit by height
        height = mapped.y;
        width = height * ratio;
      } else {
        // Container is taller than ratio, fit by width
        width = mapped.x;
        height = width / ratio;
      }
    }

    // Clamp to min size
    width = Math.max(width, min.x);
    height = Math.max(height, min.y);

    const newBox = Box.fromBounds(
      roundBounds({
        x: (mapped.x - width) / 2,
        y: (mapped.y - height) / 2,
        width,
        height,
      })
    );

    box = newBox;
    setCropBounds(newBox.toBounds());
  };

  const reset = () => {
    initBox(false);
    setResetTrigger((prev) => prev + 1);
    resetListeners.forEach((listener) => listener());
  };

  return {
    crop: cropBounds,
    setCrop,
    options,
    setOptions,
    aspectRatioValue,
    logicalMaxSize,
    logicalMinSize,
    containerSize,
    fill,
    reset,
    resetTrigger,
    uncheckedSetCrop,
    uncheckedUpdateBox,
    onReset,
    _internalInitController: init,
    _internalCleanupController: cleanup,
  };
}

// Attribution to area-selection (MIT License) by 7anshuai
// https://github.com/7anshuai/area-selection
export class Box {
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

  setFromBounds(bounds: CropBounds): Box {
    this.x = bounds.x;
    this.y = bounds.y;
    this.width = bounds.width;
    this.height = bounds.height;
    return this;
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
  ): Box {
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
  ): Box {
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

    return this;
  }

  constrainToSize(
    maxWidth: number | null,
    maxHeight: number | null,
    minWidth: number | null,
    minHeight: number | null,
    origin: Vec2,
    ratio: number | null = null
  ): Box {
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

    return this;
  }
}
