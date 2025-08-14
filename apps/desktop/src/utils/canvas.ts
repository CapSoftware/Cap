/**
 * Creates a high DPI canvas context and sets up a resize observer to handle
 * redrawing the canvas when its size changes.
 *
 * @param canvas - The HTML canvas element to create the context for.
 * @param drawOnResizeCallback - A callback function that is called whenever the canvas is resized.
 *                               It receives the 2D rendering context as an argument.
 * @returns An object containing the 2D rendering context and a cleanup function to disconnect the resize observer,
 *          or null if the context could not be obtained.
 */
export function createHiDPICanvasContext(
	canvas: HTMLCanvasElement,
	drawOnResizeCallback: (ctx: CanvasRenderingContext2D) => void,
): {
	ctx: CanvasRenderingContext2D;
	cleanup: () => void;
} | null {
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	polyfillCanvasContextRoundRect();

	const scale = (rect: DOMRect) => {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = rect.width * dpr;
		canvas.height = rect.height * dpr;
		ctx.scale(dpr, dpr);
		drawOnResizeCallback(ctx);
	};

	const observer = new ResizeObserver(([entry]) => scale(entry.contentRect));
	observer.observe(canvas);

	return {
		ctx,
		cleanup: () => observer.disconnect(),
	};
}

// TODO: May not be needed depending on the minimum macOS version.
// https://stackoverflow.com/questions/51232811/canvas-clearrect-with-rounded-corners
function polyfillCanvasContextRoundRect() {
	if ("roundRect" in CanvasRenderingContext2D) return;
	CanvasRenderingContext2D.prototype.roundRect = function (
		x: number,
		y: number,
		w: number,
		h: number,
		radii?: number | DOMPointInit | Iterable<number | DOMPointInit>,
	) {
		this.beginPath();
		let radius = typeof radii === "number" ? radii : 0;

		if (typeof radii === "object") {
			if (Symbol.iterator in radii) {
				const radiiArray = Array.from(radii) as number[];
				radius = radiiArray[0] || 0;
			} else if ("x" in radii && "y" in radii) {
				radius = radii.x!;
			}
		}

		const adjustedRadius = Math.min(radius, w / 2, h / 2);

		this.moveTo(x + adjustedRadius, y);
		this.arcTo(x + w, y, x + w, y + h, adjustedRadius);
		this.arcTo(x + w, y + h, x, y + h, adjustedRadius);
		this.arcTo(x, y + h, x, y, adjustedRadius);
		this.arcTo(x, y, x + w, y, adjustedRadius);
		this.closePath();
	};
}
