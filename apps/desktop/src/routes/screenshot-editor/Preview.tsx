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
import { getImageRect } from "./layout";

// CSS for checkerboard grid
const gridStyle = {
	"background-color": "white",
	"background-image":
		"linear-gradient(45deg, #f0f0f0 25%, transparent 25%), linear-gradient(-45deg, #f0f0f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #f0f0f0 75%), linear-gradient(-45deg, transparent 75%, #f0f0f0 75%)",
	"background-size": "20px 20px",
	"background-position": "0 0, 0 10px, 10px -10px, -10px 0px",
};

export function Preview(props: { zoom: number; setZoom: (z: number) => void }) {
	const {
		latestFrame,
		annotations,
		focusAnnotationId,
		setFocusAnnotationId,
		activePopover,
		setActivePopover,
		setPreviewCanvas,
		setPreviewMaskCanvas,
		project,
		originalImageSize,
	} = useScreenshotEditorContext();
	let canvasRef: HTMLCanvasElement | undefined;
	let viewportRef: HTMLDivElement | undefined;

	const [canvasContainerRef, setCanvasContainerRef] =
		createSignal<HTMLDivElement>();
	const containerBounds = createElementBounds(canvasContainerRef);
	const padding = 20;

	const frame = () => {
		const f = latestFrame();
		if (!f) {
			return {
				width: 0,
				height: 0,
				bitmap: null,
			};
		}
		return f;
	};

	const frameWidth = () => frame().width;
	const frameHeight = () => frame().height;

	const imageRect = createMemo(() => {
		return getImageRect(
			{ width: frameWidth(), height: frameHeight() },
			originalImageSize(),
			project.background.padding,
			project.background.crop,
		);
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
	const imageShadow = () =>
		props.zoom > 1
			? "none"
			: "0 4px 20px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(0, 0, 0, 0.1)";
	const contentLeft = () =>
		(size().width - scaledWidth()) / 2 - bounds().x * cssScale() + pan().x;
	const contentTop = () =>
		(size().height - scaledHeight()) / 2 - bounds().y * cssScale() + pan().y;

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
		setPreviewCanvas(null);
		setPreviewMaskCanvas(null);
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
			const rect = viewportRef?.getBoundingClientRect();
			const currentScale = fitScale() * props.zoom;
			const nextScale = fitScale() * newZoom;
			const sizeData = size();
			const boundsData = bounds();

			if (
				rect &&
				currentScale > 0 &&
				nextScale > 0 &&
				sizeData.width > 0 &&
				sizeData.height > 0
			) {
				const pointerX = e.clientX - rect.left;
				const pointerY = e.clientY - rect.top;
				const currentPan = pan();
				const contentX =
					boundsData.x +
					(pointerX -
						(sizeData.width - sizeData.width * props.zoom) / 2 -
						currentPan.x) /
						currentScale;
				const contentY =
					boundsData.y +
					(pointerY -
						(sizeData.height - sizeData.height * props.zoom) / 2 -
						currentPan.y) /
						currentScale;

				setPan({
					x:
						pointerX -
						(sizeData.width - sizeData.width * newZoom) / 2 -
						(contentX - boundsData.x) * nextScale,
					y:
						pointerY -
						(sizeData.height - sizeData.height * newZoom) / 2 -
						(contentY - boundsData.y) * nextScale,
				});
			}

			props.setZoom(newZoom);
		} else {
			setPan((p) => ({
				x: p.x - e.deltaX,
				y: p.y - e.deltaY,
			}));
		}
	};

	const startPanDrag = (clientX: number, clientY: number) => {
		setIsDragging(true);
		setDragStart({
			x: clientX,
			y: clientY,
			panX: pan().x,
			panY: pan().y,
		});
	};

	const handleMouseDown = (e: MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		startPanDrag(e.clientX, e.clientY);
	};

	const handleMiddleMouseDown = (e: MouseEvent) => {
		if (e.button !== 1) return;
		e.preventDefault();
		startPanDrag(e.clientX, e.clientY);
	};

	const dismissActivePopover = () => {
		if (activePopover()) {
			setActivePopover(null);
		}
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
				class="flex-1 relative flex items-center justify-center overflow-hidden outline-hidden"
				style={gridStyle}
				onWheel={handleWheel}
				onMouseDown={handleMiddleMouseDown}
			>
				<div class="absolute left-4 bottom-4 z-10 flex items-center gap-2 bg-gray-1 dark:bg-gray-3 rounded-lg shadow-xs p-1 border border-gray-4">
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
									ref={viewportRef}
									style={{
										width: `${size().width}px`,
										height: `${size().height}px`,
										position: "relative",
										"z-index": 1,
										cursor: "default",
										overflow: "visible",
									}}
									class="block"
									onMouseDown={dismissActivePopover}
								>
									<div
										style={{
											position: "absolute",
											left: `${contentLeft()}px`,
											top: `${contentTop()}px`,
											width: `${scaledWidth()}px`,
											height: `${scaledHeight()}px`,
											"will-change": "transform",
											overflow: "hidden",
											"border-radius": "4px",
											"box-shadow": imageShadow(),
										}}
									>
										<canvas
											ref={(el) => {
												canvasRef = el;
												setPreviewCanvas(el);
											}}
											width={frameWidth()}
											height={frameHeight()}
											style={{
												position: "absolute",
												left: "0px",
												top: "0px",
												width: `${scaledWidth()}px`,
												height: `${scaledHeight()}px`,
											}}
										/>
										<canvas
											ref={(el) => {
												maskCanvasRef = el ?? maskCanvasRef;
												setPreviewMaskCanvas(el);
												renderMaskOverlays();
											}}
											width={frameWidth()}
											height={frameHeight()}
											style={{
												position: "absolute",
												left: "0px",
												top: "0px",
												width: `${scaledWidth()}px`,
												height: `${scaledHeight()}px`,
												"pointer-events": "none",
											}}
										/>
										<AnnotationLayer
											bounds={bounds()}
											cssWidth={scaledWidth()}
											cssHeight={scaledHeight()}
											imageRect={imageRect()}
											isPanning={isDragging()}
											onBackgroundMouseDown={handleMouseDown}
										/>
									</div>
								</div>
							</div>
						);
					}}
				</Show>
			</div>
		</div>
	);
}
