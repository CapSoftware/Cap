import type { NullableBounds } from "@solid-primitives/bounds";
import { createElementSize } from "@solid-primitives/resize-observer";
import type { Accessor } from "solid-js";

export function createResizeDrivenBounds(
	target: Accessor<Element | undefined>,
): Readonly<NullableBounds> {
	const size = createElementSize(target);
	const rect = () => target()?.getBoundingClientRect();

	return {
		get top() {
			return rect()?.top ?? null;
		},
		get left() {
			return rect()?.left ?? null;
		},
		get bottom() {
			return rect()?.bottom ?? null;
		},
		get right() {
			return rect()?.right ?? null;
		},
		get width() {
			return size.width;
		},
		get height() {
			return size.height;
		},
	};
}
