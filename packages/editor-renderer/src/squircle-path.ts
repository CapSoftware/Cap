const STEPS = 200;
const EPS = 1e-10;

function superellipseComponent(v: number, exp: number): number {
	const abs = Math.abs(v);
	if (abs < EPS) return 0;
	return abs ** exp * Math.sign(v);
}

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
	const n = 4 + (1 - t) * 46;
	const exp = 2 / n;

	const points: { x: number; y: number }[] = [];
	for (let i = 0; i <= STEPS; i++) {
		const angle = (i / STEPS) * 2 * Math.PI;
		const x = cx + superellipseComponent(Math.cos(angle), exp) * halfW;
		const y = cy + superellipseComponent(Math.sin(angle), exp) * halfH;
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
