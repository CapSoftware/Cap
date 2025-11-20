import { createElementBounds } from "@solid-primitives/bounds";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import IconCapCrop from "~icons/cap/crop";
import IconCapZoomIn from "~icons/cap/zoom-in";
import IconCapZoomOut from "~icons/cap/zoom-out";
import { ASPECT_RATIOS } from "../editor/projectConfig";
import { EditorButton, Slider } from "../editor/ui";
import { useScreenshotEditorContext } from "./context";
import { AspectRatioSelect } from "./popovers/AspectRatioSelect";

// CSS for checkerboard grid
const gridStyle = {
	"background-color": "white",
	"background-image":
		"linear-gradient(45deg, #f0f0f0 25%, transparent 25%), linear-gradient(-45deg, #f0f0f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #f0f0f0 75%), linear-gradient(-45deg, transparent 75%, #f0f0f0 75%)",
	"background-size": "20px 20px",
	"background-position": "0 0, 0 10px, 10px -10px, -10px 0px",
};

import { AnnotationLayer } from "./AnnotationLayer";

export function Preview(props: { zoom: number; setZoom: (z: number) => void }) {
	const { path, project, setDialog, latestFrame, annotations, activeTool } =
		useScreenshotEditorContext();
	let canvasRef: HTMLCanvasElement | undefined;

	const [canvasContainerRef, setCanvasContainerRef] =
		createSignal<HTMLDivElement>();
	const containerBounds = createElementBounds(canvasContainerRef);

	const [pan, setPan] = createSignal({ x: 0, y: 0 });

	const handleWheel = (e: WheelEvent) => {
		e.preventDefault();
		if (e.ctrlKey) {
			// Zoom
			const delta = -e.deltaY;
			const zoomStep = 0.005;
			const newZoom = Math.max(0.1, Math.min(3, props.zoom + delta * zoomStep));
			props.setZoom(newZoom);
		} else {
			// Pan
			setPan((p) => ({
				x: p.x - e.deltaX,
				y: p.y - e.deltaY,
			}));
		}
	};

	createEffect(() => {
		const frame = latestFrame();
		if (frame && canvasRef) {
			const ctx = canvasRef.getContext("2d");
			if (ctx) {
				ctx.putImageData(frame.data, 0, 0);
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
			>
				<div class="absolute left-4 bottom-4 z-10 flex items-center gap-2 bg-gray-1 dark:bg-gray-3 rounded-lg shadow-sm p-1 border border-gray-4">
					<EditorButton
						tooltipText="Zoom Out"
						onClick={() => props.setZoom(Math.max(0.1, props.zoom - 0.1))}
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
						onClick={() => props.setZoom(Math.min(3, props.zoom + 0.1))}
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
									data: { width: 0, height: 0 } as ImageData,
								};
							return f;
						};

						const frameWidth = () => frame().width;
						const frameHeight = () => frame().data.height;

						const bounds = createMemo(() => {
							const crop = project.background.crop;
							let minX = crop ? crop.position.x : 0;
							let minY = crop ? crop.position.y : 0;
							let maxX = crop ? crop.position.x + crop.size.x : frameWidth();
							let maxY = crop ? crop.position.y + crop.size.y : frameHeight();

							for (const ann of annotations) {
								const ax1 = ann.x;
								const ay1 = ann.y;
								const ax2 = ann.x + ann.width;
								const ay2 = ann.y + ann.height;

								const left = Math.min(ax1, ax2);
								const right = Math.max(ax1, ax2);
								const top = Math.min(ay1, ay2);
								const bottom = Math.max(ay1, ay2);

								minX = Math.min(minX, left);
								maxX = Math.max(maxX, right);
								minY = Math.min(minY, top);
								maxY = Math.max(maxY, bottom);
							}

							let x = minX;
							let y = minY;
							let width = maxX - minX;
							let height = maxY - minY;

							if (project.aspectRatio) {
								const ratioConf = ASPECT_RATIOS[project.aspectRatio];
								if (ratioConf) {
									const targetRatio = ratioConf.ratio[0] / ratioConf.ratio[1];
									const currentRatio = width / height;

									if (currentRatio > targetRatio) {
										const newHeight = width / targetRatio;
										const padY = (newHeight - height) / 2;
										y -= padY;
										height = newHeight;
									} else {
										const newWidth = height * targetRatio;
										const padX = (newWidth - width) / 2;
										x -= padX;
										width = newWidth;
									}
								}
							}

							return {
								x,
								y,
								width,
								height,
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
								maskCanvasRef.height !== frameData.data.height
							) {
								maskCanvasRef.width = frameData.width;
								maskCanvasRef.height = frameData.data.height;
							}

							ctx.clearRect(0, 0, maskCanvasRef.width, maskCanvasRef.height);

							if (!masks.length || !canvasRef) return;

							const source = canvasRef;

							for (const mask of masks) {
								const startX = Math.max(
									0,
									Math.min(mask.x, mask.x + mask.width),
								);
								const startY = Math.max(
									0,
									Math.min(mask.y, mask.y + mask.height),
								);
								const endX = Math.min(
									frameData.width,
									Math.max(mask.x, mask.x + mask.width),
								);
								const endY = Math.min(
									frameData.data.height,
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
									style={{
										width: `${size().width * props.zoom}px`,
										height: `${size().height * props.zoom}px`,
										position: "relative",
										transform: `translate(${pan().x}px, ${pan().y}px)`,
										"will-change": "transform",
									}}
									class="shadow-lg block"
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
