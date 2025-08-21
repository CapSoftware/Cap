import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	createSignal,
	onMount,
	onCleanup,
	type ComponentProps,
	Show,
} from "solid-js";
import { cx } from "cva";

function ActionButton(props: ComponentProps<"button">) {
	return (
		<button
			{...props}
			class={cx(
				"p-[0.25rem] rounded-lg transition-all",
				"text-gray-11",
				"h-8 w-8 flex items-center justify-center",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				props.class,
			)}
			type="button"
		/>
	);
}

export default function DrawingOverlay() {
	let canvasRef: HTMLCanvasElement | undefined;
	let ctx: CanvasRenderingContext2D | null = null;
	const [isDrawing, setIsDrawing] = createSignal(false);
	const [color, setColor] = createSignal("#FF0000");
	const [lineWidth, setLineWidth] = createSignal(3);
	const [tool, setTool] = createSignal<"pen" | "eraser">("pen");
	const [history, setHistory] = createSignal<ImageData[]>([]);
	const [historyStep, setHistoryStep] = createSignal(-1);

	onMount(() => {
		if (canvasRef) {
			ctx = canvasRef.getContext("2d", { willReadFrequently: true });
			if (ctx) {
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				resizeCanvas();
				saveState();
			}
		}

		window.addEventListener("resize", resizeCanvas);
		onCleanup(() => window.removeEventListener("resize", resizeCanvas));
	});

	const resizeCanvas = () => {
		if (canvasRef && ctx) {
			const imageData = ctx.getImageData(0, 0, canvasRef.width, canvasRef.height);
			
			canvasRef.width = window.innerWidth;
			canvasRef.height = window.innerHeight;
			
			ctx.putImageData(imageData, 0, 0);
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
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

	const startDrawing = (e: MouseEvent | TouchEvent) => {
		if (!ctx) return;
		setIsDrawing(true);

		const point = getPoint(e);
		ctx.beginPath();
		ctx.moveTo(point.x, point.y);
	};

	const draw = (e: MouseEvent | TouchEvent) => {
		if (!isDrawing() || !ctx) return;

		const point = getPoint(e);
		
		if (tool() === "eraser") {
			ctx.globalCompositeOperation = "destination-out";
			ctx.lineWidth = lineWidth() * 3;
		} else {
			ctx.globalCompositeOperation = "source-over";
			ctx.strokeStyle = color();
			ctx.lineWidth = lineWidth();
		}

		ctx.lineTo(point.x, point.y);
		ctx.stroke();
	};

	const stopDrawing = () => {
		if (isDrawing()) {
			setIsDrawing(false);
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
		saveState();
	};

	const closeOverlay = async () => {
		const window = await getCurrentWindow();
		await window.close();
	};

	return (
		<div class="fixed inset-0" style="background-color: transparent;">
			<canvas
				ref={canvasRef}
				class="absolute inset-0"
				style={{ 
					"background-color": "transparent",
					cursor: tool() === "eraser" ? "crosshair" : "default"
				}}
				onMouseDown={startDrawing}
				onMouseMove={draw}
				onMouseUp={stopDrawing}
				onMouseLeave={stopDrawing}
				onTouchStart={startDrawing}
				onTouchMove={draw}
				onTouchEnd={stopDrawing}
			/>
			
			{/* Drawing toolbar - positioned at bottom like recording bar */}
			<div class="fixed bottom-[60px] left-1/2 -translate-x-1/2 flex flex-row items-stretch bg-gray-1 animate-in fade-in rounded-lg shadow-xl">
				<div class="flex flex-row justify-between p-[0.25rem] gap-2">
					{/* Drawing status and close */}
					<button
						onClick={closeOverlay}
						class="py-[0.25rem] px-[0.5rem] text-gray-11 gap-[0.25rem] flex flex-row items-center rounded-lg transition-opacity"
						type="button"
						title="Exit drawing mode"
					>
						<IconLucideX class="size-4" />
						<span class="font-[500] text-[0.875rem]">Drawing</span>
					</button>

					<div class="w-px bg-gray-5" />

					{/* Tool buttons */}
					<div class="flex gap-1 items-center">
						<ActionButton
							onClick={() => setTool("pen")}
							class={tool() === "pen" ? "bg-gray-3 text-gray-12" : ""}
							title="Pen tool"
						>
							<IconLucideEdit />
						</ActionButton>
						
						<ActionButton
							onClick={() => setTool("eraser")}
							class={tool() === "eraser" ? "bg-gray-3 text-gray-12" : ""}
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
						</ActionButton>

						<div class="w-px bg-gray-5" />

						{/* Undo/Redo */}
						<ActionButton
							onClick={undo}
							disabled={historyStep() <= 0}
							class={historyStep() <= 0 ? "opacity-50 cursor-not-allowed" : ""}
							title="Undo"
						>
							<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M3 7v6h6" />
								<path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
							</svg>
						</ActionButton>
						
						<ActionButton
							onClick={redo}
							disabled={historyStep() >= history().length - 1}
							class={historyStep() >= history().length - 1 ? "opacity-50 cursor-not-allowed" : ""}
							title="Redo"
						>
							<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M21 7v6h-6" />
								<path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7" />
							</svg>
						</ActionButton>

						<div class="w-px bg-gray-5" />

						{/* Color picker */}
						<div class="flex items-center px-2">
							<div class="relative">
								<input
									type="color"
									value={color()}
									onInput={(e) => setColor(e.currentTarget.value)}
									class="w-6 h-6 rounded cursor-pointer opacity-0 absolute"
									title="Choose color"
								/>
								<div 
									class="w-6 h-6 rounded border border-gray-6 cursor-pointer"
									style={{ "background-color": color() }}
								/>
							</div>
						</div>

						{/* Size slider */}
						<div class="flex items-center gap-2 px-2">
							<span class="text-[0.75rem] text-gray-10">Size:</span>
							<input
								type="range"
								min="1"
								max="20"
								value={lineWidth()}
								onInput={(e) => setLineWidth(parseInt(e.currentTarget.value))}
								class="w-20 h-1 bg-gray-3 rounded-full appearance-none cursor-pointer slider"
								title="Brush size"
							/>
							<span class="text-[0.75rem] text-gray-11 min-w-[2ch]">{lineWidth()}</span>
						</div>

						<div class="w-px bg-gray-5" />

						{/* Clear */}
						<ActionButton
							onClick={clearCanvas}
							title="Clear all"
						>
							<IconCapTrash />
						</ActionButton>
					</div>
				</div>
			</div>

			<style>{`
				.slider::-webkit-slider-thumb {
					appearance: none;
					width: 10px;
					height: 10px;
					background: var(--gray-11);
					border-radius: 50%;
					cursor: pointer;
				}
				.slider::-moz-range-thumb {
					width: 10px;
					height: 10px;
					background: var(--gray-11);
					border-radius: 50%;
					cursor: pointer;
					border: none;
				}
				.slider::-webkit-slider-runnable-track {
					background: var(--gray-3);
				}
				.slider::-moz-range-track {
					background: var(--gray-3);
				}
			`}</style>
		</div>
	);
}