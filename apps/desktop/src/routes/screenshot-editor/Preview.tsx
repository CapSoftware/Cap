import { createElementBounds } from "@solid-primitives/bounds";
import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import IconCapZoomIn from "~icons/cap/zoom-in";
import IconCapZoomOut from "~icons/cap/zoom-out";
import { EditorButton, Slider } from "../editor/ui";
import { AnnotationLayer } from "./AnnotationLayer";
import { useScreenshotEditorContext } from "./context";

// CSS for checkerboard grid
const gridStyle = {
	"background-color": "white",
	"background-image":
		"linear-gradient(45deg, #f0f0f0 25%, transparent 25%), linear-gradient(-45deg, #f0f0f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #f0f0f0 75%), linear-gradient(-45deg, transparent 75%, #f0f0f0 75%)",
	"background-size": "20px 20px",
	"background-position": "0 0, 0 10px, 10px -10px, -10px 0px",
};

export function Preview(props: { zoom: number; setZoom: (z: number) => void }) {
	const { latestFrame, annotations, focusAnnotationId, setFocusAnnotationId } =
		useScreenshotEditorContext();
	let canvasRef: HTMLCanvasElement | undefined;

	const [canvasContainerRef, setCanvasContainerRef] =
		createSignal<HTMLDivElement>();
	const containerBounds = createElementBounds(canvasContainerRef);

	const [pan, setPan] = createSignal({ x: 0, y: 0 });
	const [isDragging, setIsDragging] = createSignal(false);
	const [dragStart, setDragStart] = createSignal({
		x: 0,
		y: 0,
		panX: 0,
		panY: 0,
	});

	const [previousBitmap, setPreviousBitmap] = createSignal<ImageBitmap | null>(
		null,
	);

	createEffect(() => {
		const frame = latestFrame();
		const currentBitmap = frame?.bitmap ?? null;
		const prevBitmap = previousBitmap();

		if (prevBitmap && prevBitmap !== currentBitmap) {
			prevBitmap.close();
		}

		setPreviousBitmap(currentBitmap);
	});

	onCleanup(() => {
		const bitmap = previousBitmap();
		if (bitmap) {
			bitmap.close();
			setPreviousBitmap(null);
		}
	});

	const zoomIn = () => {
		props.setZoom(Math.min(3, props.zoom + 0.1));
		setPan({ x: 0, y: 0 });
	};

	const zoomOut = () => {
		props.setZoom(Math.max(0.1, props.zoom - 0.1));
		setPan({ x: 0, y: 0 });
	};

	createEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable
			) {
				return;
			}

			if (!e.metaKey && !e.ctrlKey) return;

			if (e.key === "-") {
				e.preventDefault();
				zoomOut();
			} else if (e.key === "=" || e.key === "+") {
				e.preventDefault();
				zoomIn();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
	});

	const handleWheel = (e: WheelEvent) => {
		e.preventDefault();
		if (e.ctrlKey) {
			const delta = -e.deltaY;
			const zoomStep = 0.005;
			const newZoom = Math.max(0.1, Math.min(3, props.zoom + delta * zoomStep));
			props.setZoom(newZoom);
		} else {
			setPan((p) => ({
				x: p.x - e.deltaX,
				y: p.y - e.deltaY,
			}));
		}
	};

	const handleMouseDown = (e: MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		setIsDragging(true);
		setDragStart({
			x: e.clientX,
			y: e.clientY,
			panX: pan().x,
			panY: pan().y,
		});
	};

	const handleMiddleMouseDown = (e: MouseEvent) => {
		if (e.button !== 1) return;
		e.preventDefault();
		setIsDragging(true);
		setDragStart({
			x: e.clientX,
			y: e.clientY,
			panX: pan().x,
			panY: pan().y,
		});
	};

	const handleMouseMove = (e: MouseEvent) => {
		if (!isDragging()) return;
		const dx = e.clientX - dragStart().x;
		const dy = e.clientY - dragStart().y;
		setPan({
			x: dragStart().panX + dx,
			y: dragStart().panY + dy,
		});
	};

	const handleMouseUp = () => {
		setIsDragging(false);
	};

	createEffect(() => {
		if (isDragging()) {
			window.addEventListener("mousemove", handleMouseMove);
			window.addEventListener("mouseup", handleMouseUp);
		}
		onCleanup(() => {
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		});
	});

	createEffect(() => {
		const frame = latestFrame();
		if (frame?.bitmap && canvasRef) {
			const ctx = canvasRef.getContext("2d");
			if (ctx) {
				ctx.drawImage(frame.bitmap, 0, 0);
			}
		}
	});

	return (
		<div class="flex flex-col flex-1 overflow-hidden bg-gray-1 dark:bg-gray-2">
			{/* Preview Area */}
			<div
				ref={setCanvasContainerRef}
				class="flex-1 relative flex items-center justify-center overflow-hidden outline-none"
				style={gridStyle}
				onWheel={handleWheel}
				onMouseDown={handleMiddleMouseDown}
			>
				<div class="absolute left-4 bottom-4 z-10 flex items-center gap-2 bg-gray-1 dark:bg-gray-3 rounded-lg shadow-sm p-1 border border-gray-4">
					<EditorButton
						tooltipText="Zoom Out"
						kbd={["meta", "-"]}
						onClick={zoomOut}
					>
						<IconCapZoomOut class="size-4" />
					</EditorButton>
					<Slider
						class="w-20"
						minValue={0.1}
						maxValue={3}
						step={0.1}
						value={[props.zoom]}
						onChange={([v]) => props.setZoom(v)}
						formatTooltip={(v) => `${Math.round(v * 100)}%`}
					/>
					<EditorButton
						tooltipText="Zoom In"
						kbd={["meta", "+"]}
						onClick={zoomIn}
					>
						<IconCapZoomIn class="size-4" />
					</EditorButton>
				</div>
				<Show
					when={!!latestFrame()}
					fallback={<div class="text-gray-11">Loading preview...</div>}
				>
					{(_) => {
						const padding = 20;
						const frame = () => {
							const f = latestFrame();
							if (!f)
								return {
									width: 0,
									height: 0,
									bitmap: null,
								};
							return f;
						};

						const frameWidth = () => frame().width;
						const frameHeight = () => frame().height;

						const imageRect = createMemo(() => {
							return {
								x: 0,
								y: 0,
								width: frameWidth(),
								height: frameHeight(),
							};
						});

						const bounds = createMemo(() => {
							return {
								x: 0,
								y: 0,
								width: frameWidth(),
								height: frameHeight(),
							};
						});

						const availableWidth = () =>
							Math.max((containerBounds.width ?? 0) - padding * 2, 0);
						const availableHeight = () =>
							Math.max((containerBounds.height ?? 0) - padding * 2, 0);

						const containerAspect = () => {
							const width = availableWidth();
							const height = availableHeight();
							if (width === 0 || height === 0) return 1;
							return width / height;
						};

						const contentAspect = () => {
							const width = bounds().width;
							const height = bounds().height;
							if (width === 0 || height === 0) return containerAspect();
							return width / height;
						};

						const size = () => {
							let width: number;
							let height: number;
							if (contentAspect() < containerAspect()) {
								height = availableHeight();
								width = height * contentAspect();
							} else {
								width = availableWidth();
								height = width / contentAspect();
							}

							return {
								width: Math.min(width, bounds().width),
								height: Math.min(height, bounds().height),
							};
						};

						const fitScale = () => {
							if (bounds().width === 0) return 1;
							return size().width / bounds().width;
						};

						const cssScale = () => fitScale() * props.zoom;
						const scaledWidth = () => frameWidth() * cssScale();
						const scaledHeight = () => frameHeight() * cssScale();
						const canvasLeft = () => -bounds().x * cssScale();
						const canvasTop = () => -bounds().y * cssScale();

						createEffect(
							on(focusAnnotationId, (annId) => {
								if (!annId) return;

								const ann = annotations.find((a) => a.id === annId);
								if (!ann) {
									setFocusAnnotationId(null);
									return;
								}

								const annCenterX = ann.x + ann.width / 2;
								const annCenterY = ann.y + ann.height / 2;

								const boundsData = bounds();
								const sizeData = size();
								const scale = fitScale() * props.zoom;

								const annScreenX =
									(annCenterX - boundsData.x) * scale -
									(sizeData.width * props.zoom) / 2;
								const annScreenY =
									(annCenterY - boundsData.y) * scale -
									(sizeData.height * props.zoom) / 2;

								setPan({ x: -annScreenX, y: -annScreenY });
								setFocusAnnotationId(null);
							}),
						);

						let maskCanvasRef: HTMLCanvasElement | undefined;

						const blurRegion = (
							ctx: CanvasRenderingContext2D,
							source: HTMLCanvasElement,
							startX: number,
							startY: number,
							regionWidth: number,
							regionHeight: number,
							level: number,
						) => {
							const scale = Math.max(2, Math.round(level / 4));
							const temp = document.createElement("canvas");
							temp.width = Math.max(1, Math.floor(regionWidth / scale));
							temp.height = Math.max(1, Math.floor(regionHeight / scale));
							const tempCtx = temp.getContext("2d");
							if (!tempCtx) return;

							tempCtx.imageSmoothingEnabled = true;
							tempCtx.drawImage(
								source,
								startX,
								startY,
								regionWidth,
								regionHeight,
								0,
								0,
								temp.width,
								temp.height,
							);

							ctx.drawImage(
								temp,
								0,
								0,
								temp.width,
								temp.height,
								startX,
								startY,
								regionWidth,
								regionHeight,
							);
						};

						const renderMaskOverlays = () => {
							const frameData = latestFrame();
							if (!maskCanvasRef) return;
							const ctx = maskCanvasRef.getContext("2d");
							if (!ctx) return;
							if (!frameData) {
								maskCanvasRef.width = 0;
								maskCanvasRef.height = 0;
								return;
							}

							const masks = annotations.filter((ann) => ann.type === "mask");

							if (
								maskCanvasRef.width !== frameData.width ||
								maskCanvasRef.height !== frameData.height
							) {
								maskCanvasRef.width = frameData.width;
								maskCanvasRef.height = frameData.height;
							}

							ctx.clearRect(0, 0, maskCanvasRef.width, maskCanvasRef.height);

							if (!masks.length || !canvasRef) return;

							const source = canvasRef;
							const activeRect = imageRect();
							const rectLeft = activeRect.x;
							const rectTop = activeRect.y;
							const rectRight = activeRect.x + activeRect.width;
							const rectBottom = activeRect.y + activeRect.height;

							for (const mask of masks) {
								const startX = Math.max(
									rectLeft,
									Math.min(mask.x, mask.x + mask.width),
								);
								const startY = Math.max(
									rectTop,
									Math.min(mask.y, mask.y + mask.height),
								);
								const endX = Math.min(
									rectRight,
									Math.max(mask.x, mask.x + mask.width),
								);
								const endY = Math.min(
									rectBottom,
									Math.max(mask.y, mask.y + mask.height),
								);

								const regionWidth = endX - startX;
								const regionHeight = endY - startY;

								if (regionWidth <= 0 || regionHeight <= 0) continue;

								const level = Math.max(1, mask.maskLevel ?? 16);
								const type = mask.maskType ?? "blur";

								if (type === "pixelate") {
									const blockSize = Math.max(2, Math.round(level));
									const temp = document.createElement("canvas");
									temp.width = Math.max(1, Math.floor(regionWidth / blockSize));
									temp.height = Math.max(
										1,
										Math.floor(regionHeight / blockSize),
									);
									const tempCtx = temp.getContext("2d");
									if (!tempCtx) continue;
									tempCtx.imageSmoothingEnabled = false;
									tempCtx.drawImage(
										source,
										startX,
										startY,
										regionWidth,
										regionHeight,
										0,
										0,
										temp.width,
										temp.height,
									);
									ctx.imageSmoothingEnabled = false;
									ctx.drawImage(
										temp,
										0,
										0,
										temp.width,
										temp.height,
										startX,
										startY,
										regionWidth,
										regionHeight,
									);
									ctx.imageSmoothingEnabled = true;
									continue;
								}

								blurRegion(
									ctx,
									source,
									startX,
									startY,
									regionWidth,
									regionHeight,
									level,
								);
							}

							ctx.filter = "none";
						};

						createEffect(renderMaskOverlays);

						return (
							<div class="flex overflow-hidden absolute inset-0 justify-center items-center h-full">
								<div
									class="absolute inset-0 z-0"
									style={{
										cursor: isDragging() ? "grabbing" : "grab",
									}}
									onMouseDown={handleMouseDown}
								/>
								<div
									style={{
										width: `${size().width * props.zoom}px`,
										height: `${size().height * props.zoom}px`,
										position: "relative",
										transform: `translate(${pan().x}px, ${pan().y}px)`,
										"will-change": "transform",
										"z-index": 1,
										cursor: "default",
										overflow: "hidden",
										"box-shadow":
											"0 4px 20px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(0, 0, 0, 0.1)",
										"border-radius": "4px",
									}}
									class="block"
								>
									<canvas
										ref={canvasRef}
										width={frameWidth()}
										height={frameHeight()}
										style={{
											position: "absolute",
											left: `${canvasLeft()}px`,
											top: `${canvasTop()}px`,
											width: `${scaledWidth()}px`,
											height: `${scaledHeight()}px`,
										}}
									/>
									<canvas
										ref={(el) => {
											maskCanvasRef = el ?? maskCanvasRef;
											renderMaskOverlays();
										}}
										width={frameWidth()}
										height={frameHeight()}
										style={{
											position: "absolute",
											left: `${canvasLeft()}px`,
											top: `${canvasTop()}px`,
											width: `${scaledWidth()}px`,
											height: `${scaledHeight()}px`,
											"pointer-events": "none",
										}}
									/>
									<AnnotationLayer
										bounds={bounds()}
										cssWidth={size().width * props.zoom}
										cssHeight={size().height * props.zoom}
										imageRect={imageRect()}
									/>
								</div>
							</div>
						);
					}}
				</Show>
			</div>
		</div>
	);
}
