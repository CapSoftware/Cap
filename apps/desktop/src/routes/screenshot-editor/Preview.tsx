import { createElementBounds } from "@solid-primitives/bounds";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import IconCapCrop from "~icons/cap/crop";
import IconCapZoomIn from "~icons/cap/zoom-in";
import IconCapZoomOut from "~icons/cap/zoom-out";
import { EditorButton, Slider } from "../editor/ui";
import AspectRatioSelect from "./AspectRatioSelect";
import { useScreenshotEditorContext } from "./context";

// CSS for checkerboard grid (adaptive to light/dark mode)
const gridStyle = {
	"background-image":
		"linear-gradient(45deg, rgba(128,128,128,0.12) 25%, transparent 25%), " +
		"linear-gradient(-45deg, rgba(128,128,128,0.12) 25%, transparent 25%), " +
		"linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.12) 75%), " +
		"linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.12) 75%)",
	"background-size": "40px 40px",
	"background-position": "0 0, 0 20px, 20px -20px, -20px 0px",
	"background-color": "rgba(200,200,200,0.08)",
};

export function Preview() {
	const { path, project, setDialog, latestFrame } =
		useScreenshotEditorContext();
	const [zoom, setZoom] = createSignal(1);
	let canvasRef: HTMLCanvasElement | undefined;

	const [canvasContainerRef, setCanvasContainerRef] =
		createSignal<HTMLDivElement>();
	const containerBounds = createElementBounds(canvasContainerRef);

	createEffect(() => {
		const frame = latestFrame();
		if (frame && canvasRef) {
			const ctx = canvasRef.getContext("2d");
			if (ctx) {
				ctx.putImageData(frame.data, 0, 0);
			}
		}
	});

	const cropDialogHandler = () => {
		// We use the original image for cropping
		// We can get dimensions from the latest frame or load the image
		// For now, let's just open the dialog and let it handle loading
		setDialog({
			open: true,
			type: "crop",
			position: {
				...(project.background.crop?.position ?? { x: 0, y: 0 }),
			},
			size: {
				...(project.background.crop?.size ?? {
					x: latestFrame()?.width ?? 0,
					y: latestFrame()?.height ?? 0,
				}),
			},
		});
	};

	return (
		<div class="flex flex-col flex-1 rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3">
			{/* Top Toolbar */}
			<div class="flex gap-3 justify-center p-3">
				<AspectRatioSelect />
				<EditorButton
					tooltipText="Crop Image"
					onClick={cropDialogHandler}
					leftIcon={<IconCapCrop class="w-5 text-gray-12" />}
				>
					Crop
				</EditorButton>
			</div>

			{/* Preview Area */}
			<div
				ref={setCanvasContainerRef}
				class="flex-1 relative flex items-center justify-center bg-[--bg-subtle] overflow-hidden"
			>
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

						const frameAspect = () => {
							const width = frameWidth();
							const height = frameHeight();
							if (width === 0 || height === 0) return containerAspect();
							return width / height;
						};

						const size = () => {
							let width: number;
							let height: number;
							if (frameAspect() < containerAspect()) {
								height = availableHeight();
								width = height * frameAspect();
							} else {
								width = availableWidth();
								height = width / frameAspect();
							}

							return {
								width: Math.min(width, frameWidth()),
								height: Math.min(height, frameHeight()),
							};
						};

						return (
							<div class="flex overflow-hidden absolute inset-0 justify-center items-center h-full">
								<canvas
									ref={canvasRef}
									width={frameWidth()}
									height={frameHeight()}
									style={{
										width: `${size().width * zoom()}px`,
										height: `${size().height * zoom()}px`,
										...gridStyle,
									}}
									class="rounded shadow-lg transition-all duration-200 ease-out"
								/>
							</div>
						);
					}}
				</Show>
			</div>

			{/* Bottom Toolbar (Zoom) */}
			<div class="flex overflow-hidden z-10 flex-row gap-3 justify-between items-center p-5 h-[72px]">
				<div class="flex-1">{/* Left side spacer or info */}</div>

				<div class="flex flex-row flex-1 gap-4 justify-end items-center">
					<div class="flex-1" />

					<Tooltip kbd={["meta", "-"]} content="Zoom out">
						<IconCapZoomOut
							onClick={() => setZoom((z) => Math.max(0.1, z - 0.1))}
							class="text-gray-12 size-5 will-change-[opacity] transition-opacity hover:opacity-70 cursor-pointer"
						/>
					</Tooltip>
					<Tooltip kbd={["meta", "+"]} content="Zoom in">
						<IconCapZoomIn
							onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
							class="text-gray-12 size-5 will-change-[opacity] transition-opacity hover:opacity-70 cursor-pointer"
						/>
					</Tooltip>
					<Slider
						class="w-24"
						minValue={0.1}
						maxValue={3}
						step={0.1}
						value={[zoom()]}
						onChange={([v]) => setZoom(v)}
						formatTooltip={(v) => `${Math.round(v * 100)}%`}
					/>
				</div>
			</div>
		</div>
	);
}
