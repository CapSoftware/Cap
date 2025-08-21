import {
	createSignal,
	onMount,
	onCleanup,
	Show,
	type ComponentProps,
} from "solid-js";
import { cx } from "cva";

interface DrawingCanvasProps {
	onClose: () => void;
}

export function DrawingCanvas(props: DrawingCanvasProps) {
	let canvasRef: HTMLCanvasElement | undefined;
	let ctx: CanvasRenderingContext2D | null = null;
	const [isDrawing, setIsDrawing] = createSignal(false);
	const [color, setColor] = createSignal("#FF0000");
	const [lineWidth, setLineWidth] = createSignal(5);
	const [tool, setTool] = createSignal<"pen" | "eraser">("pen");
	const [history, setHistory] = createSignal<ImageData[]>([]);
	const [historyStep, setHistoryStep] = createSignal(-1);
	let points: { x: number; y: number }[] = [];

	onMount(() => {
		if (canvasRef) {
			const dpr = window.devicePixelRatio || 1;
			ctx = canvasRef.getContext("2d", { willReadFrequently: true });
			if (ctx) {
				const rect = canvasRef.getBoundingClientRect();
				canvasRef.width = rect.width * dpr;
				canvasRef.height = rect.height * dpr;
				ctx.scale(dpr, dpr);
				
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				ctx.imageSmoothingEnabled = false;
				
				resizeCanvas();
				saveState();
			}
		}

		window.addEventListener("resize", resizeCanvas);
		onCleanup(() => {
			window.removeEventListener("resize", resizeCanvas);
		});
	});

	const resizeCanvas = () => {
		if (canvasRef && ctx) {
			const dpr = window.devicePixelRatio || 1;
			const imageData = ctx.getImageData(0, 0, canvasRef.width, canvasRef.height);
			
			canvasRef.width = window.innerWidth * dpr;
			canvasRef.height = window.innerHeight * dpr;
			canvasRef.style.width = `${window.innerWidth}px`;
			canvasRef.style.height = `${window.innerHeight}px`;
			
			ctx.scale(dpr, dpr);
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.imageSmoothingEnabled = false;
			
			ctx.putImageData(imageData, 0, 0);
		}
	};

	const saveState = () => {
		if (!ctx || !canvasRef) return;
		const imageData = ctx.getImageData(0, 0, canvasRef.width, canvasRef.height);
		const currentHistory = history();
		const currentStep = historyStep();
		
		const newHistory = currentHistory.slice(0, currentStep + 1);
		newHistory.push(imageData);
		
		if (newHistory.length > 50) {
			newHistory.shift();
		}
		
		setHistory(newHistory);
		setHistoryStep(newHistory.length - 1);
	};

	const undo = () => {
		if (!ctx || !canvasRef) return;
		const step = historyStep();
		if (step > 0) {
			setHistoryStep(step - 1);
			const imageData = history()[step - 1];
			ctx.putImageData(imageData, 0, 0);
		}
	};

	const redo = () => {
		if (!ctx || !canvasRef) return;
		const step = historyStep();
		const hist = history();
		if (step < hist.length - 1) {
			setHistoryStep(step + 1);
			const imageData = hist[step + 1];
			ctx.putImageData(imageData, 0, 0);
		}
	};

	const drawSmoothLine = (points: { x: number; y: number }[]) => {
		if (!ctx || points.length < 2) return;

		if (tool() === "eraser") {
			ctx.globalCompositeOperation = "destination-out";
			ctx.lineWidth = lineWidth() * 3;
		} else {
			ctx.globalCompositeOperation = "source-over";
			ctx.strokeStyle = color();
			ctx.lineWidth = lineWidth();
		}

		if (points.length === 2) {
			ctx.beginPath();
			ctx.moveTo(points[0].x, points[0].y);
			ctx.lineTo(points[1].x, points[1].y);
			ctx.stroke();
			return;
		}

		ctx.beginPath();
		ctx.moveTo(points[0].x, points[0].y);

		for (let i = 1; i < points.length - 2; i++) {
			const xc = (points[i].x + points[i + 1].x) / 2;
			const yc = (points[i].y + points[i + 1].y) / 2;
			ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
		}

		ctx.quadraticCurveTo(
			points[points.length - 2].x,
			points[points.length - 2].y,
			points[points.length - 1].x,
			points[points.length - 1].y
		);
		ctx.stroke();
	};

	const startDrawing = (e: MouseEvent | TouchEvent) => {
		if (!ctx) return;
		setIsDrawing(true);

		const point = getPoint(e);
		points = [point];
		
		ctx.beginPath();
		ctx.moveTo(point.x, point.y);
	};

	const draw = (e: MouseEvent | TouchEvent) => {
		if (!isDrawing() || !ctx) return;

		const point = getPoint(e);
		points.push(point);
		
		if (points.length >= 3) {
			const lastThreePoints = points.slice(-3);
			drawSmoothLine(lastThreePoints);
			points = points.slice(-2);
		}
	};

	const stopDrawing = () => {
		if (isDrawing()) {
			if (points.length > 0) {
				drawSmoothLine(points);
			}
			setIsDrawing(false);
			points = [];
			saveState();
		}
	};

	const getPoint = (e: MouseEvent | TouchEvent): { x: number; y: number } => {
		if ("touches" in e) {
			const touch = e.touches[0];
			return { x: touch.clientX, y: touch.clientY };
		}
		return { x: e.clientX, y: e.clientY };
	};

	const clearCanvas = () => {
		if (!ctx || !canvasRef) return;
		ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);
	};

	const strokeSizes = [
		{ value: 2, label: "XS" },
		{ value: 5, label: "S" },
		{ value: 10, label: "M" },
		{ value: 15, label: "L" },
		{ value: 25, label: "XL" }
	];

	return (
		<div class="fixed inset-0 z-50">
			<canvas
				ref={canvasRef}
				class="absolute inset-0"
				style={{ 
					cursor: tool() === "eraser" ? "crosshair" : "default",
					"pointer-events": isDrawing() ? "auto" : "none"
				}}
				onMouseDown={startDrawing}
				onMouseMove={draw}
				onMouseUp={stopDrawing}
				onMouseLeave={stopDrawing}
				onTouchStart={startDrawing}
				onTouchMove={draw}
				onTouchEnd={stopDrawing}
			/>
			
			<div class="absolute top-4 right-4 flex flex-col gap-2 bg-gray-1 p-3 rounded-xl shadow-2xl border border-gray-6">
				<div class="flex items-center justify-between mb-1">
					<span class="text-xs font-medium text-gray-11">Drawing Tools</span>
					<button
						onClick={props.onClose}
						class="p-1.5 rounded-lg hover:bg-gray-3 transition-colors"
						title="Close drawing mode"
					>
						<IconLucideX class="size-5 text-gray-11" />
					</button>
				</div>

				<div class="w-full h-px bg-gray-5" />

				<div class="flex gap-2">
					<button
						onClick={undo}
						class={cx(
							"p-2.5 rounded-lg transition-all flex-1 flex items-center justify-center",
							historyStep() > 0 
								? "bg-gray-3 hover:bg-gray-4 text-gray-12" 
								: "bg-gray-2 text-gray-8 cursor-not-allowed opacity-50"
						)}
						disabled={historyStep() <= 0}
						title="Undo"
					>
						<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M3 7v6h6" />
							<path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
						</svg>
					</button>
					
					<button
						onClick={redo}
						class={cx(
							"p-2.5 rounded-lg transition-all flex-1 flex items-center justify-center",
							historyStep() < history().length - 1
								? "bg-gray-3 hover:bg-gray-4 text-gray-12"
								: "bg-gray-2 text-gray-8 cursor-not-allowed opacity-50"
						)}
						disabled={historyStep() >= history().length - 1}
						title="Redo"
					>
						<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 7v6h-6" />
							<path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7" />
						</svg>
					</button>
				</div>

				<div class="w-full h-px bg-gray-5" />

				<div class="flex gap-2">
					<button
						onClick={() => setTool("pen")}
						class={cx(
							"p-2.5 rounded-lg transition-all flex-1 flex items-center justify-center",
							tool() === "pen" 
								? "bg-blue-5 text-white" 
								: "bg-gray-3 hover:bg-gray-4 text-gray-11"
						)}
						title="Pen tool"
					>
						<IconLucideEdit class="size-5" />
					</button>
					
					<button
						onClick={() => setTool("eraser")}
						class={cx(
							"p-2.5 rounded-lg transition-all flex-1 flex items-center justify-center",
							tool() === "eraser" 
								? "bg-blue-5 text-white" 
								: "bg-gray-3 hover:bg-gray-4 text-gray-11"
						)}
						title="Eraser tool"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="size-5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
							<path d="M22 21H7" />
							<path d="m5 11 9 9" />
						</svg>
					</button>
				</div>

				<div class="w-full h-px bg-gray-5" />

				<div class="flex items-center gap-3">
					<span class="text-xs text-gray-10">Color</span>
					<input
						type="color"
						value={color()}
						onInput={(e) => setColor(e.currentTarget.value)}
						class="w-10 h-10 rounded-lg cursor-pointer border border-gray-6"
						title="Color picker"
					/>
				</div>

				<div class="w-full h-px bg-gray-5" />

				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<span class="text-xs text-gray-10">Stroke Size</span>
						<span class="text-xs font-medium text-gray-11">{lineWidth()}px</span>
					</div>
					<div class="flex gap-1">
						{strokeSizes.map((size) => (
							<button
								onClick={() => setLineWidth(size.value)}
								class={cx(
									"flex-1 py-2 px-1 rounded-lg text-xs font-medium transition-all",
									lineWidth() === size.value
										? "bg-blue-5 text-white"
										: "bg-gray-3 hover:bg-gray-4 text-gray-11"
								)}
								title={`${size.label} (${size.value}px)`}
							>
								{size.label}
							</button>
						))}
					</div>
					<input
						type="range"
						min="1"
						max="30"
						value={lineWidth()}
						onInput={(e) => setLineWidth(parseInt(e.currentTarget.value))}
						class="w-full h-2 bg-gray-3 rounded-lg appearance-none cursor-pointer slider"
						title="Line width"
						style={{
							background: `linear-gradient(to right, rgb(59, 130, 246) 0%, rgb(59, 130, 246) ${(lineWidth() / 30) * 100}%, rgb(64, 64, 64) ${(lineWidth() / 30) * 100}%, rgb(64, 64, 64) 100%)`
						}}
					/>
				</div>

				<div class="w-full h-px bg-gray-5" />

				<button
					onClick={() => {
						clearCanvas();
						saveState();
					}}
					class="p-2.5 rounded-lg bg-red-5 hover:bg-red-6 transition-colors text-white flex items-center justify-center gap-2"
					title="Clear canvas"
				>
					<IconCapTrash class="size-5" />
					<span class="text-xs font-medium">Clear</span>
				</button>
			</div>

			<style>{`
				.slider::-webkit-slider-thumb {
					appearance: none;
					width: 16px;
					height: 16px;
					background: rgb(59, 130, 246);
					border-radius: 50%;
					cursor: pointer;
					border: 2px solid white;
					box-shadow: 0 2px 4px rgba(0,0,0,0.2);
				}
				.slider::-moz-range-thumb {
					width: 16px;
					height: 16px;
					background: rgb(59, 130, 246);
					border-radius: 50%;
					cursor: pointer;
					border: 2px solid white;
					box-shadow: 0 2px 4px rgba(0,0,0,0.2);
				}
			`}</style>
		</div>
	);
}