// Attribution to area-selection (MIT License) by 7anshuai
// https://github.com/7anshuai/area-selection

import type { XY } from "./tauri";

export default class Box {
  private x1: number;
  private y1: number;
  private x2: number;
  private y2: number;

  private constructor(x1: number, y1: number, x2: number, y2: number) {
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
  }

  static from(position: XY<number>, size: XY<number>): Box {
    return new Box(
      position.x,
      position.y,
      position.x + size.x,
      position.y + size.y
    );
  }

  toPositionAndSize(): { position: XY<number>; size: XY<number> } {
    return {
      position: { x: this.x1, y: this.y1 },
      size: { x: this.width(), y: this.height() },
    };
  }

  width(): number {
    return Math.abs(this.x2 - this.x1);
  }

  height(): number {
    return Math.abs(this.y2 - this.y1);
  }

  resize(newWidth: number, newHeight: number, origin: XY<number>): Box {
    const fromX = this.x1 + this.width() * origin.x;
    const fromY = this.y1 + this.height() * origin.y;

    this.x1 = fromX - newWidth * origin.x;
    this.y1 = fromY - newHeight * origin.y;
    this.x2 = this.x1 + newWidth;
    this.y2 = this.y1 + newHeight;

    return this;
  }

  scale(factor: number, origin: XY<number>): Box {
    const newWidth = this.width() * factor;
    const newHeight = this.height() * factor;
    return this.resize(newWidth, newHeight, origin);
  }

  move(x: number | null, y: number | null): Box {
    const width = this.width();
    const height = this.height();

    this.x1 = x ?? this.x1;
    this.y1 = y ?? this.y1;
    this.x2 = this.x1 + width;
    this.y2 = this.y1 + height;

    return this;
  }

  getAbsolutePoint(point: XY<number>): XY<number> {
    return {
      x: this.x1 + this.width() * point.x,
      y: this.y1 + this.height() * point.y,
    };
  }

  constrainToRatio(
    ratio: number,
    origin: XY<number>,
    grow: "width" | "height" = "height"
  ): Box {
    if (!ratio) return this;

    switch (grow) {
      case "height":
        return this.resize(this.width(), this.width() / ratio, origin);
      case "width":
        return this.resize(this.height() * ratio, this.height(), origin);
      default:
        return this.resize(this.width(), this.width() / ratio, origin);
    }
  }

  constrainToBoundary(
    boundaryWidth: number,
    boundaryHeight: number,
    origin: XY<number>
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

    if (this.width() > maxWidth) {
      const factor = maxWidth / this.width();
      this.scale(factor, origin);
    }
    if (this.height() > maxHeight) {
      const factor = maxHeight / this.height();
      this.scale(factor, origin);
    }

    return this;
  }

  constrainToSize(
    maxWidth: number | null,
    maxHeight: number | null,
    minWidth: number | null,
    minHeight: number | null,
    origin: XY<number>,
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

    if (maxWidth && this.width() > maxWidth) {
      const newWidth = maxWidth;
      const newHeight = ratio === null ? this.height() : maxHeight!;
      this.resize(newWidth, newHeight, origin);
    }

    if (maxHeight && this.height() > maxHeight) {
      const newWidth = ratio === null ? this.width() : maxWidth!;
      const newHeight = maxHeight;
      this.resize(newWidth, newHeight, origin);
    }

    if (minWidth && this.width() < minWidth) {
      const newWidth = minWidth;
      const newHeight = ratio === null ? this.height() : minHeight!;
      this.resize(newWidth, newHeight, origin);
    }

    if (minHeight && this.height() < minHeight) {
      const newWidth = ratio === null ? this.width() : minWidth!;
      const newHeight = minHeight;
      this.resize(newWidth, newHeight, origin);
    }

    return this;
  }
}
