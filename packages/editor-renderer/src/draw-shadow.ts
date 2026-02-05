import type {
	RenderInnerRect,
	RenderMaskSpec,
	RenderShadowSpec,
} from "@cap/editor-render-spec";
import { traceSquirclePath } from "./squircle-path";

const FAR_OFFSET = 10000;

export function drawShadow(
	ctx: CanvasRenderingContext2D,
	innerRect: RenderInnerRect,
	maskSpec: RenderMaskSpec,
	shadowSpec: RenderShadowSpec,
): void {
	if (!shadowSpec.enabled || shadowSpec.alpha <= 0) return;

	const { x, y, width, height } = innerRect;
	const expandedX = x - shadowSpec.spreadPx;
	const expandedY = y - shadowSpec.spreadPx;
	const expandedW = width + shadowSpec.spreadPx * 2;
	const expandedH = height + shadowSpec.spreadPx * 2;

	ctx.save();

	ctx.shadowColor = `rgba(0, 0, 0, ${shadowSpec.alpha})`;
	ctx.shadowBlur = shadowSpec.blurPx;
	ctx.shadowOffsetX = FAR_OFFSET;
	ctx.shadowOffsetY = FAR_OFFSET + shadowSpec.offsetY;
	ctx.fillStyle = "rgba(0, 0, 0, 1)";

	ctx.translate(-FAR_OFFSET, -FAR_OFFSET);

	ctx.beginPath();

	if (maskSpec.roundingType === "squircle" && maskSpec.radiusPx > 0) {
		const expandRatio =
			width > 0 && height > 0
				? Math.min(expandedW / width, expandedH / height)
				: 1;
		const expandedRadius = maskSpec.radiusPx * expandRatio;
		traceSquirclePath(
			ctx,
			expandedX + expandedW / 2,
			expandedY + expandedH / 2,
			expandedW / 2,
			expandedH / 2,
			expandedRadius,
		);
	} else if (maskSpec.radiusPx > 0) {
		const expandRatio =
			width > 0 && height > 0
				? Math.min(expandedW / width, expandedH / height)
				: 1;
		const r = Math.min(
			maskSpec.radiusPx * expandRatio,
			expandedW / 2,
			expandedH / 2,
		);
		ctx.moveTo(expandedX + r, expandedY);
		ctx.arcTo(
			expandedX + expandedW,
			expandedY,
			expandedX + expandedW,
			expandedY + expandedH,
			r,
		);
		ctx.arcTo(
			expandedX + expandedW,
			expandedY + expandedH,
			expandedX,
			expandedY + expandedH,
			r,
		);
		ctx.arcTo(expandedX, expandedY + expandedH, expandedX, expandedY, r);
		ctx.arcTo(expandedX, expandedY, expandedX + expandedW, expandedY, r);
		ctx.closePath();
	} else {
		ctx.rect(expandedX, expandedY, expandedW, expandedH);
	}

	ctx.fill();
	ctx.restore();
}
