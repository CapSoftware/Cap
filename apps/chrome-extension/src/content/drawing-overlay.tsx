import { Timer, Trash2, X } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

// A bright, presentation-friendly palette: the warm/cool brights read well on
// light pages and white covers dark slides. Red is the default ink.
const DRAW_COLORS = [
	{ name: "Red", value: "#ef4444" },
	{ name: "Yellow", value: "#facc15" },
	{ name: "Green", value: "#22c55e" },
	{ name: "Blue", value: "#3b82f6" },
	{ name: "White", value: "#ffffff" },
] as const;

// Stroke width in CSS pixels paired with the diameter of the dot shown in the
// toolbar, so the picker previews roughly what the brush draws.
const BRUSH_SIZES = [
	{ name: "Small", value: 4, dot: 6 },
	{ name: "Medium", value: 9, dot: 10 },
	{ name: "Large", value: 16, dot: 15 },
] as const;

const DEFAULT_COLOR = DRAW_COLORS[0].value;
const DEFAULT_SIZE = BRUSH_SIZES[1].value;

// Auto-fade keeps a completed stroke fully opaque for the delay, then fades it
// out over the duration before it is dropped. Timed off the rAF clock
// (performance.now), which is what completedAt is stamped with.
const FADE_DELAY_MS = 2500;
const FADE_DURATION_MS = 900;

type Point = { x: number; y: number };

type Stroke = {
	points: Point[];
	color: string;
	size: number;
	// performance.now() when the pointer was released; null while the stroke is
	// still being drawn, in which case it never fades.
	completedAt: number | null;
};

const classNames = (...values: Array<string | false | null | undefined>) =>
	values.filter(Boolean).join(" ");

const strokeOpacity = (stroke: Stroke, now: number, autoFade: boolean) => {
	if (!autoFade || stroke.completedAt === null) return 1;
	const age = now - stroke.completedAt;
	if (age <= FADE_DELAY_MS) return 1;
	return Math.max(0, 1 - (age - FADE_DELAY_MS) / FADE_DURATION_MS);
};

const paintStroke = (
	ctx: CanvasRenderingContext2D,
	stroke: Stroke,
	opacity: number,
) => {
	const points = stroke.points;
	if (points.length === 0) return;
	ctx.globalAlpha = opacity;
	ctx.fillStyle = stroke.color;
	ctx.strokeStyle = stroke.color;
	ctx.lineWidth = stroke.size;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	// A tap with no movement is just a filled dot.
	if (points.length === 1) {
		ctx.beginPath();
		ctx.arc(points[0].x, points[0].y, stroke.size / 2, 0, Math.PI * 2);
		ctx.fill();
		return;
	}

	// Smooth the polyline by curving through the midpoints between samples;
	// the raw points become the control handles, so the ink reads as a single
	// fluid line rather than a chain of segments.
	ctx.beginPath();
	ctx.moveTo(points[0].x, points[0].y);
	for (let i = 1; i < points.length - 1; i += 1) {
		const midX = (points[i].x + points[i + 1].x) / 2;
		const midY = (points[i].y + points[i + 1].y) / 2;
		ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
	}
	const last = points[points.length - 1];
	ctx.lineTo(last.x, last.y);
	ctx.stroke();
};

type DrawingOverlayProps = {
	active: boolean;
	onClose: () => void;
};

export function DrawingOverlay({ active, onClose }: DrawingOverlayProps) {
	const [color, setColor] = useState<string>(DEFAULT_COLOR);
	const [size, setSize] = useState<number>(DEFAULT_SIZE);
	const [autoFade, setAutoFade] = useState(true);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const strokesRef = useRef<Stroke[]>([]);
	const activeStrokeRef = useRef<Stroke | null>(null);
	const colorRef = useRef(color);
	const sizeRef = useRef(size);
	const autoFadeRef = useRef(autoFade);
	const dprRef = useRef(1);

	useEffect(() => {
		colorRef.current = color;
	}, [color]);
	useEffect(() => {
		sizeRef.current = size;
	}, [size]);
	useEffect(() => {
		autoFadeRef.current = autoFade;
	}, [autoFade]);

	// Leaving draw mode wipes the ink so re-entering starts on a clean canvas
	// and no stale strokes linger over the page.
	useEffect(() => {
		if (active) return;
		strokesRef.current = [];
		activeStrokeRef.current = null;
	}, [active]);

	// Match the canvas backing store to the viewport at device resolution so
	// the ink stays crisp; strokes are stored in CSS pixels and redraw on
	// resize without conversion.
	useEffect(() => {
		if (!active) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const resize = () => {
			const dpr = window.devicePixelRatio || 1;
			dprRef.current = dpr;
			canvas.width = Math.round(window.innerWidth * dpr);
			canvas.height = Math.round(window.innerHeight * dpr);
			canvas.style.width = `${window.innerWidth}px`;
			canvas.style.height = `${window.innerHeight}px`;
		};
		resize();
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, [active]);

	// One rAF loop owns all painting: it reads the mutable stroke buffer (kept
	// out of React state so a fast scribble never triggers re-renders), applies
	// the current fade, and drops strokes once they have fully faded.
	useEffect(() => {
		if (!active) return;
		let frame = 0;
		const loop = (now: number) => {
			const canvas = canvasRef.current;
			const ctx = canvas?.getContext("2d");
			if (canvas && ctx) {
				const dpr = dprRef.current;
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				const fade = autoFadeRef.current;
				const strokes = strokesRef.current;
				for (const stroke of strokes) {
					const opacity = strokeOpacity(stroke, now, fade);
					if (opacity > 0) paintStroke(ctx, stroke, opacity);
				}
				if (fade) {
					strokesRef.current = strokes.filter(
						(stroke) =>
							stroke.completedAt === null ||
							strokeOpacity(stroke, now, true) > 0,
					);
				}
			}
			frame = window.requestAnimationFrame(loop);
		};
		frame = window.requestAnimationFrame(loop);
		return () => window.cancelAnimationFrame(frame);
	}, [active]);

	const handlePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			event.preventDefault();
			event.currentTarget.setPointerCapture(event.pointerId);
			const stroke: Stroke = {
				points: [{ x: event.clientX, y: event.clientY }],
				color: colorRef.current,
				size: sizeRef.current,
				completedAt: null,
			};
			activeStrokeRef.current = stroke;
			strokesRef.current = [...strokesRef.current, stroke];
		},
		[],
	);

	const handlePointerMove = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			const stroke = activeStrokeRef.current;
			if (!stroke) return;
			// Coalesced events recover the sub-frame pointer samples the browser
			// batched, so quick strokes stay smooth instead of polygonal.
			const native = event.nativeEvent;
			const coalesced = native.getCoalescedEvents?.() ?? [];
			if (coalesced.length > 0) {
				for (const sample of coalesced) {
					stroke.points.push({ x: sample.clientX, y: sample.clientY });
				}
			} else {
				stroke.points.push({ x: event.clientX, y: event.clientY });
			}
		},
		[],
	);

	const handlePointerUp = useCallback(() => {
		const stroke = activeStrokeRef.current;
		if (!stroke) return;
		stroke.completedAt = window.performance.now();
		activeStrokeRef.current = null;
	}, []);

	const clear = useCallback(() => {
		strokesRef.current = [];
		activeStrokeRef.current = null;
	}, []);

	const toggleAutoFade = useCallback(() => {
		setAutoFade((previous) => {
			const next = !previous;
			// Re-arm the fade clock on every completed stroke when turning it back
			// on, otherwise older ink would jump straight to faded.
			if (next) {
				const now = window.performance.now();
				for (const stroke of strokesRef.current) {
					if (stroke.completedAt !== null) stroke.completedAt = now;
				}
			}
			return next;
		});
	}, []);

	if (!active) return null;

	return (
		<>
			<canvas
				ref={canvasRef}
				className="cap-extension-draw-canvas"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
			/>
			<div
				className="cap-extension-draw-toolbar"
				role="toolbar"
				aria-label="Drawing tools"
			>
				<div className="cap-extension-draw-group">
					{DRAW_COLORS.map((swatch) => (
						<button
							key={swatch.value}
							type="button"
							className={classNames(
								"cap-extension-draw-swatch",
								color === swatch.value && "is-active",
							)}
							style={{ background: swatch.value, color: swatch.value }}
							aria-label={swatch.name}
							aria-pressed={color === swatch.value}
							title={swatch.name}
							onClick={() => setColor(swatch.value)}
						/>
					))}
				</div>
				<div className="cap-extension-draw-divider" aria-hidden />
				<div className="cap-extension-draw-group">
					{BRUSH_SIZES.map((brush) => (
						<button
							key={brush.value}
							type="button"
							className={classNames(
								"cap-extension-draw-size",
								size === brush.value && "is-active",
							)}
							aria-label={brush.name}
							aria-pressed={size === brush.value}
							title={`${brush.name} brush`}
							onClick={() => setSize(brush.value)}
						>
							<span
								className="cap-extension-draw-size-dot"
								style={{ width: `${brush.dot}px`, height: `${brush.dot}px` }}
								aria-hidden
							/>
						</button>
					))}
				</div>
				<div className="cap-extension-draw-divider" aria-hidden />
				<button
					type="button"
					className={classNames(
						"cap-extension-draw-icon-button",
						autoFade && "is-active",
					)}
					aria-label="Auto-fade ink"
					aria-pressed={autoFade}
					title={
						autoFade
							? "Ink fades after a few seconds (click to keep it)"
							: "Ink stays on screen (click to make it fade)"
					}
					onClick={toggleAutoFade}
				>
					<Timer size={17} aria-hidden />
				</button>
				<button
					type="button"
					className="cap-extension-draw-icon-button"
					aria-label="Clear drawing"
					title="Clear drawing"
					onClick={clear}
				>
					<Trash2 size={17} aria-hidden />
				</button>
				<div className="cap-extension-draw-divider" aria-hidden />
				<button
					type="button"
					className="cap-extension-draw-icon-button"
					aria-label="Exit drawing"
					title="Exit drawing"
					onClick={onClose}
				>
					<X size={18} aria-hidden />
				</button>
			</div>
		</>
	);
}
