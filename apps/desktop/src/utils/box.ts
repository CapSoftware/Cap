// Attribution to area-selection (MIT License) by 7anshuai
// https://github.com/7anshuai/area-selection

type XY = { x: number; y: number };

export type Bounds = { size: XY; position: XY };

export default class Box {
	x: number;
	y: number;
	width: number;
	height: number;

	private constructor(x: number, y: number, width: number, height: number) {
		this.x = x;
		this.y = y;
		this.width = width;
		this.height = height;
	}

	static from(position: XY, size: XY): Box {
		return new Box(position.x, position.y, size.x, size.y);
	}

	toBounds(): Bounds {
		return {
			position: { x: this.x, y: this.y },
			size: { x: this.width, y: this.height },
		};
	}

	resize(newWidth: number, newHeight: number, origin: XY): Box {
		const fromX = this.x + this.width * origin.x;
		const fromY = this.y + this.height * origin.y;

		this.x = fromX - newWidth * origin.x;
		this.y = fromY - newHeight * origin.y;
		this.width = newWidth;
		this.height = newHeight;

		return this;
	}

	scale(factor: number, origin: XY): Box {
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

	getAbsolutePoint(point: XY): XY {
		return {
			x: this.x + this.width * point.x,
			y: this.y + this.height * point.y,
		};
	}

	constrainAll(box: Box, mapped: XY, origin: XY, aspectRatio?: number) {
		if (aspectRatio) this.constrainToRatio(aspectRatio, origin);
		this.constrainToBoundary(mapped.x, mapped.y, origin);
		return box;
	}

	constrainToRatio(
		ratio: number,
		origin: XY,
		grow: "width" | "height" = "height",
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
		origin: XY,
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
		origin: XY,
		ratio: number | null = null,
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
