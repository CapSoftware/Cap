import type { CropBounds } from "./Cropper";

type Vec2 = { x: number; y: number };
export type CropGuides = { x: number | null; y: number | null };
export type CropResizeAlignment = {
	origin: Vec2;
	axes: { x: boolean; y: boolean };
	ratio: number | null;
};
const TARGETS = [0.5, 0, 1, 0.25, 0.75];
const THRESHOLD = 6;

export function alignCrop(
	bounds: CropBounds,
	container: Vec2,
	resize?: CropResizeAlignment,
): { bounds: CropBounds; guides: CropGuides } {
	let next = { ...bounds };
	const guides: CropGuides = { x: null, y: null };
	let bestRatioDistance = Number.POSITIVE_INFINITY;
	for (const axis of ["x", "y"] as const) {
		if (resize && !resize.axes[axis]) continue;
		const size = axis === "x" ? "width" : "height";
		const base = resize?.ratio ? bounds : next;
		let bestDistance = THRESHOLD + 1;
		let candidate = base;
		let guide: number | null = null;
		const anchors = resize ? [0, 1] : [0.5, 0, 1];
		for (const target of TARGETS) {
			for (const anchor of anchors) {
				if (resize && anchor === resize.origin[axis]) continue;
				const line = target * container[axis];
				const delta = line - (base[axis] + base[size] * anchor);
				const distance = Math.abs(delta);
				if (distance > THRESHOLD || distance >= bestDistance) continue;
				const proposed = { ...base };
				if (resize) {
					proposed[size] += delta / (anchor - resize.origin[axis]);
					if (resize.ratio) {
						if (axis === "x") proposed.height = proposed.width / resize.ratio;
						else proposed.width = proposed.height * resize.ratio;
					}
					proposed.x += (base.width - proposed.width) * resize.origin.x;
					proposed.y += (base.height - proposed.height) * resize.origin.y;
				} else {
					proposed[axis] += delta;
				}
				if (
					proposed.width < 1 ||
					proposed.height < 1 ||
					proposed.x < -0.001 ||
					proposed.y < -0.001 ||
					proposed.x + proposed.width > container.x + 0.001 ||
					proposed.y + proposed.height > container.y + 0.001
				)
					continue;
				candidate = proposed;
				guide = line;
				bestDistance = distance;
			}
		}
		if (resize?.ratio) {
			if (guide !== null && bestDistance < bestRatioDistance) {
				next = candidate;
				guides.x = null;
				guides.y = null;
				guides[axis] = guide;
				bestRatioDistance = bestDistance;
			}
		} else {
			next = candidate;
			guides[axis] = guide;
		}
	}
	return { bounds: next, guides };
}
