export class LogicalPosition<T extends number = number> {
	constructor(
		public x: T,
		public y: T,
	) {}
	toPhysical(scaleFactor: number) {
		return new PhysicalPosition(this.x * scaleFactor, this.y * scaleFactor);
	}
}

export class PhysicalPosition<T extends number = number> {
	constructor(
		public x: T,
		public y: T,
	) {}
	toLogical(scaleFactor: number) {
		return new LogicalPosition(this.x / scaleFactor, this.y / scaleFactor);
	}
}

export class LogicalSize<T extends number = number> {
	constructor(
		public width: T,
		public height: T,
	) {}
	toPhysical(scaleFactor: number) {
		return new PhysicalSize(
			this.width * scaleFactor,
			this.height * scaleFactor,
		);
	}
}

export class PhysicalSize<T extends number = number> {
	constructor(
		public width: T,
		public height: T,
	) {}
	toLogical(scaleFactor: number) {
		return new LogicalSize(this.width / scaleFactor, this.height / scaleFactor);
	}
}

export type Position = LogicalPosition | PhysicalPosition;
export type Size = LogicalSize | PhysicalSize;
