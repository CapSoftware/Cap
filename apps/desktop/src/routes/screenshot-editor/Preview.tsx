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

export function Preview() {
	const { path, project, setDialog, latestFrame } =
		useScreenshotEditorContext();
	const [zoom, setZoom] = createSignal(1);
	let canvasRef: HTMLCanvasElement | undefined;

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
			<div class="flex-1 relative flex items-center justify-center bg-[--bg-subtle] overflow-hidden">
				<div
					class="relative shadow-2xl transition-transform duration-200 ease-out"
					style={{
						transform: `scale(${zoom()})`,
					}}
				>
					<Show
						when={latestFrame()}
						fallback={<div class="text-gray-11">Loading preview...</div>}
					>
						{(frame) => (
							<canvas
								ref={canvasRef}
								width={frame().width}
								height={frame().height}
								class="max-w-full max-h-[80vh] block"
							/>
						)}
					</Show>
				</div>
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
