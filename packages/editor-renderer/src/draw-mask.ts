import type { RenderInnerRect, RenderMaskSpec } from "@cap/editor-render-spec";
import { traceSquirclePath } from "./squircle-path";

export function clipMask(
	ctx: CanvasRenderingContext2D,
	innerRect: RenderInnerRect,
	maskSpec: RenderMaskSpec,
): void {
	const { x, y, width, height } = innerRect;
	const { radiusPx, roundingType } = maskSpec;

	ctx.beginPath();

	if (roundingType === "squircle" && radiusPx > 0) {
		traceSquirclePath(
			ctx,
			x + width / 2,
			y + height / 2,
			width / 2,
			height / 2,
			radiusPx,
		);
	} else if (radiusPx > 0) {
		const r = Math.min(radiusPx, width / 2, height / 2);
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + width, y, x + width, y + height, r);
		ctx.arcTo(x + width, y + height, x, y + height, r);
		ctx.arcTo(x, y + height, x, y, r);
		ctx.arcTo(x, y, x + width, y, r);
		ctx.closePath();
	} else {
		ctx.rect(x, y, width, height);
	}

	ctx.clip();
}
