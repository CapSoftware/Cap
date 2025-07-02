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

export type CropController = {
  crop: Accessor<CropBounds>;
  setCrop: (bounds: CropBounds) => void;
  options: Store<CropControllerOptions>;
  setOptions: SetStoreFunction<CropControllerOptions>;
  aspectRatioValue: Accessor<number | null>;
  logicalMaxSize: Accessor<Vec2>;
  logicalMinSize: Accessor<Vec2>;
  containerSize: Accessor<Vec2>;
  center: (halvedSize?: boolean) => void;
  fill: () => void;
  reset: () => void;
  uncheckedSetCrop: (bounds: CropBounds) => void;
  uncheckedUpdateBox: (updater: (currentBox: Box) => Box | null) => void;
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
    console.log(`Setting unchecked: ${JSON.stringify(bounds)}`);

    box.setFromBounds(bounds);
    setCropBounds(bounds);
  };

  const setCrop = (bounds: CropBounds) => {
    box.setFromBounds(bounds);
    setBoxAndApplyConstraints(box);
  };

  const fill = () => {
    const container = containerSize();
    box.x = 0;
    box.y = 0;
    box.width = container.x;
    box.height = container.y;
    setCropBounds(box.toBounds());
    setBoxAndApplyConstraints();
  };

  const center = (halvedSize = true) => {
    const container = containerSize();
    let finalWidth = box.width;
    let finalHeight = box.height;

    if (halvedSize) {
      finalWidth = box.width / 2;
      finalHeight = box.height / 2;
      box.width = finalWidth;
      box.height = finalHeight;
    }

    const x = container.x / 2 - finalWidth / 2;
    const y = container.y / 2 - finalHeight / 2;
    box.move(x, y);
    setCropBounds(box.toBounds());
    setBoxAndApplyConstraints();
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

  const initBox = () => {
    let newBox: Box;
    if (initialOptions.initialCrop) {
      newBox = Box.fromBounds(initialOptions.initialCrop);
      setCropBounds(newBox.toBounds());
      box = newBox;
    } else {
      const container = containerSize();
      const width = container.x / 2;
      const height = container.y / 2;
      newBox = Box.fromBounds({
        x: container.x / 4,
        y: container.y / 4,
        width,
        height,
      });
      box = newBox;
    }
    setBoxAndApplyConstraints();
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

  return {
    crop: cropBounds,
    setCrop,
    options,
    setOptions,
    aspectRatioValue,
    logicalMaxSize,
    logicalMinSize,
    containerSize,
    center,
    fill,
    reset: initBox,
    uncheckedSetCrop,
    uncheckedUpdateBox,
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
