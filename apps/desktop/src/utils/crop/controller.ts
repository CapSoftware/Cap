import { createStore, SetStoreFunction, type Store } from "solid-js/store";
import { createSignal, createMemo, batch, type Accessor } from "solid-js";

type Vec2 = { x: number; y: number };
export type CropBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const ORIGIN_CENTER: Vec2 = { x: 0.5, y: 0.5 };

type CropControllerOptions = {
  mappedSize?: Vec2;
  minSize?: Vec2;
  maxSize?: Vec2;
  aspectRatio?: number;
  initialCrop?: CropBounds;
};

export type CropController = {
  crop: Accessor<CropBounds>;
  setCrop: (bounds: CropBounds) => void;
  options: Store<CropControllerOptions>;
  setOptions: SetStoreFunction<CropControllerOptions>;
  logicalMaxSize: Accessor<Vec2>;
  containerSize: Accessor<Vec2>;
  center: (halvedSize?: boolean) => void;
  fill: () => void;
  reset: () => void;
  uncheckedSetCrop: (bounds: CropBounds) => void;
  // For direct manipulation during events
  updateBox: (updater: (box: Box) => void) => void;
};

export function createCropController(
  initialOptions: CropControllerOptions
): CropController {
  const initialBox = initialOptions.initialCrop
    ? Box.fromBounds(initialOptions.initialCrop)
    : Box.default();

  const [box, setBox] = createSignal<Box>(initialBox);
  const [options, setOptions] = createStore(initialOptions);
  const [containerSize, setContainerSize] = createSignal({ x: 1, y: 1 });

  // Reactive crop bounds derived from box
  const crop = createMemo(() => {
    const currentBox = box();
    return {
      x: currentBox.x,
      y: currentBox.y,
      width: currentBox.width,
      height: currentBox.height,
    };
  });

  const logicalMaxSize = createMemo(
    () => options.mappedSize || containerSize()
  );

  const minSize = createMemo(() => {
    const logical = logicalMaxSize();
    return {
      x: Math.max(100, options.minSize?.x ?? logical.x * 0.1),
      y: Math.max(100, options.minSize?.y ?? logical.y * 0.1),
    };
  });

  const applyConstraints = () => {
    const currentBox = box();
    const currentOptions = options;
    const container = containerSize();
    const min = minSize();

    if (currentOptions.aspectRatio) {
      currentBox.constrainToRatio(currentOptions.aspectRatio, ORIGIN_CENTER);
    }

    currentBox.constrainToSize(
      currentOptions.maxSize?.x || null,
      currentOptions.maxSize?.y || null,
      min.x,
      min.y,
      ORIGIN_CENTER,
      currentOptions.aspectRatio
    );

    currentBox.constrainToBoundary(container.x, container.y, ORIGIN_CENTER);
    setBox(currentBox);
  };

  const center = (halvedSize = false) => {
    const currentBox = box();
    const container = containerSize();
    let finalWidth = currentBox.width;
    let finalHeight = currentBox.height;

    if (halvedSize) {
      finalWidth = currentBox.width / 2;
      finalHeight = currentBox.height / 2;
      currentBox.width = finalWidth;
      currentBox.height = finalHeight;
    }

    const x = container.x / 2 - finalWidth / 2;
    const y = container.y / 2 - finalHeight / 2;
    currentBox.move(x, y);
    setBox(currentBox);
  };

  const uncheckedSetCrop = (bounds: CropBounds) => {
    const currentBox = box();
    currentBox.setFromBounds(bounds);
    setBox(currentBox);
  };

  const setCrop = (bounds: CropBounds) => {
    const currentBox = box();
    currentBox.setFromBounds(bounds);
    setBox(currentBox);
    applyConstraints();
  };

  const fill = () => {
    const currentBox = box();
    const container = containerSize();
    currentBox.x = 0;
    currentBox.y = 0;
    currentBox.width = container.x;
    currentBox.height = container.y;
    setBox(currentBox);
    applyConstraints();
  };

  const reset = () => {
    let newBox: Box;
    if (options.initialCrop) {
      newBox = Box.fromBounds(options.initialCrop);
    } else {
      newBox = Box.default();
    }
    setBox(newBox);
    center();
    applyConstraints();
  };

  // For direct manipulation during events (like dragging)
  const updateBox = (updater: (box: Box) => void) => {
    const currentBox = box();
    updater(currentBox);
    setBox(currentBox);
  };

  return {
    crop,
    setCrop,
    options,
    setOptions,
    logicalMaxSize,
    containerSize,
    center,
    fill,
    reset,
    uncheckedSetCrop,
    updateBox,
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

  resize(newWidth: number, newHeight: number, origin: Vec2): Box {
    const fromX = this.x + this.width * origin.x;
    const fromY = this.y + this.height * origin.y;

    this.x = fromX - newWidth * origin.x;
    this.y = fromY - newHeight * origin.y;
    this.width = newWidth;
    this.height = newHeight;

    return this;
  }

  scale(factor: number, origin: Vec2): Box {
    const newWidth = this.width * factor;
    const newHeight = this.height * factor;
    return this.resize(newWidth, newHeight, origin);
  }

  move(x: number | null, y: number | null): Box {
    if (x !== null) {
      this.x = x;
    }
    if (y !== null) {
      this.y = y;
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
