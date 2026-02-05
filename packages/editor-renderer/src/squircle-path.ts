const STEPS = 200;

export function squirclePath(
	cx: number,
	cy: number,
	halfW: number,
	halfH: number,
	radiusPx: number,
): { x: number; y: number }[] {
	const maxRadius = Math.min(halfW, halfH);
	const clampedRadius = Math.min(radiusPx, maxRadius);
	const t = maxRadius > 0 ? clampedRadius / maxRadius : 0;
	const n = 2 + t * 3;

	const points: { x: number; y: number }[] = [];
	for (let i = 0; i <= STEPS; i++) {
		const angle = (i / STEPS) * 2 * Math.PI;
		const cosA = Math.cos(angle);
		const sinA = Math.sin(angle);
		const x = cx + Math.abs(cosA) ** (2 / n) * Math.sign(cosA) * halfW;
		const y = cy + Math.abs(sinA) ** (2 / n) * Math.sign(sinA) * halfH;
		points.push({ x, y });
	}

	return points;
}

export function traceSquirclePath(
	ctx: CanvasRenderingContext2D | Path2D,
	cx: number,
	cy: number,
	halfW: number,
	halfH: number,
	radiusPx: number,
): void {
	const points = squirclePath(cx, cy, halfW, halfH, radiusPx);
	if (points.length === 0) return;

	const drawCtx = ctx as CanvasRenderingContext2D;
	const first = points[0];

	if (!first) return;

	drawCtx.moveTo(first.x, first.y);

	for (let i = 1; i < points.length; i++) {
		const pt = points[i];
		if (pt) drawCtx.lineTo(pt.x, pt.y);
	}

	drawCtx.closePath();
}
