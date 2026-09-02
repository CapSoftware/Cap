import type { CameraPreviewState } from "./tauri";

export type CameraPresentationMeasurement = {
	viewportWidth: number;
	viewportHeight: number;
	left: number;
	top: number;
	width: number;
	height: number;
	cornerRadii: readonly [string, string, string, string];
};

function radiusComponent(value: string, extent: number): number {
	const match = /^([\d.e+-]+)(px|%)$/.exec(value);
	if (!match) throw new Error("Camera clipping radius is unsupported");
	const numeric = Number(match[1]);
	if (!Number.isFinite(numeric) || numeric < 0) {
		throw new Error("Camera clipping radius is invalid");
	}
	return match[2] === "%" ? (numeric * extent) / 100 : numeric;
}

function clippingRadius(value: string, width: number, height: number): number {
	const components = value.trim().split(/\s+/);
	if (components.length < 1 || components.length > 2) {
		throw new Error("Camera clipping radius is unsupported");
	}
	const x = Math.min(radiusComponent(components[0], width), width / 2);
	const y = Math.min(
		radiusComponent(components[1] ?? components[0], height),
		height / 2,
	);
	if (Math.abs(x - y) > 0.5) {
		throw new Error("Elliptical camera corners are unsupported");
	}
	return Math.min(x, y);
}

export function cameraPresentationInput(
	measurement: CameraPresentationMeasurement,
	state: CameraPreviewState,
	layoutRevision: number,
) {
	const {
		viewportWidth,
		viewportHeight,
		left,
		top,
		width,
		height,
		cornerRadii,
	} = measurement;
	if (
		![viewportWidth, viewportHeight, left, top, width, height].every(
			Number.isFinite,
		) ||
		viewportWidth <= 0 ||
		viewportHeight <= 0 ||
		width <= 0 ||
		height <= 0 ||
		left < 0 ||
		top < 0 ||
		left + width > viewportWidth + 1 ||
		top + height > viewportHeight + 1 ||
		!Number.isSafeInteger(layoutRevision) ||
		layoutRevision < 0 ||
		layoutRevision > 0xffff_ffff
	) {
		throw new Error("Camera content is not ready for recording");
	}
	if (state.shape === "round" && Math.abs(width - height) > 1) {
		throw new Error("Round camera content is not square");
	}
	const radii = cornerRadii.map((value) =>
		clippingRadius(value, width, height),
	);
	if (radii.some((value) => Math.abs(value - radii[0]) > 0.5)) {
		throw new Error("Camera corners must use the same clipping radius");
	}
	return {
		viewportWidth,
		viewportHeight,
		left,
		top,
		width,
		height,
		radius: radii[0],
		layoutRevision,
		state: { ...state },
	};
}
