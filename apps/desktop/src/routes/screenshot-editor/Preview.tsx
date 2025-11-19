import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import { createMemo, createSignal, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import IconCapCrop from "~icons/cap/crop";
import IconCapZoomIn from "~icons/cap/zoom-in";
import IconCapZoomOut from "~icons/cap/zoom-out";
import { EditorButton, Slider } from "../editor/ui";
import AspectRatioSelect from "./AspectRatioSelect";
import { useScreenshotEditorContext } from "./context";

export function Preview() {
	const { path, project, setDialog } = useScreenshotEditorContext();
	const [zoom, setZoom] = createSignal(1);

	// Background Style Helper
	const backgroundStyle = createMemo(() => {
		const source = project.background.source;
		const blur = project.background.blur;

		const style: any = {};

		if (source.type === "color") {
			const [r, g, b] = source.value;
			const a = source.alpha ?? 255;
			style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
		} else if (source.type === "gradient") {
			const { from, to, angle = 90 } = source;
			style.background = `linear-gradient(${angle}deg, rgb(${from.join(",")}), rgb(${to.join(",")}))`;
		}

		if (blur > 0) {
			style.filter = `blur(${blur}px)`;
		}

		return style;
	});

	// Image Style Helper
	const imageStyle = createMemo(() => {
		const { rounding, roundingType, shadow, advancedShadow, border } =
			project.background;

		const style: any = {};

		// Rounding
		if (rounding > 0) {
			style.borderRadius = `${rounding}px`;
		}

		// Shadow
		if (advancedShadow) {
			const { size, opacity, blur } = advancedShadow;
			style.boxShadow = `0 ${size / 2}px ${blur}px rgba(0,0,0, ${opacity / 100})`;
		} else if (shadow > 0) {
			style.boxShadow = `0 ${shadow / 2}px ${shadow}px rgba(0,0,0, ${shadow / 100})`;
		}

		// Border
		if (border?.enabled) {
			const { width, color, opacity } = border;
			const [r, g, b] = color;
			style.border = `${width}px solid rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
		}

		return style;
	});

	const paddingStyle = createMemo(() => {
		const padding = project.background.padding;
		return {
			padding: `${padding * 2}px`, // Scale padding for visibility
		};
	});

	const cropDialogHandler = () => {
		const img = document.querySelector(
			"img[data-screenshot-preview]",
		) as HTMLImageElement;
		if (img) {
			setDialog({
				open: true,
				type: "crop",
				position: {
					...(project.background.crop?.position ?? { x: 0, y: 0 }),
				},
				size: {
					...(project.background.crop?.size ?? {
						x: img.naturalWidth,
						y: img.naturalHeight,
					}),
				},
			});
		}
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
					class="relative shadow-2xl bg-white transition-transform duration-200 ease-out"
					style={{
						...paddingStyle(),
						transform: `scale(${zoom()})`,
					}}
				>
					{/* Background Layer */}
					<div class="absolute inset-0 z-0 overflow-hidden transition-all duration-200">
						<Show
							when={
								project.background.source.type === "wallpaper" ||
								project.background.source.type === "image"
							}
						>
							<Show when={(project.background.source as any).path}>
								<img
									src={convertFileSrc((project.background.source as any).path)}
									class="w-full h-full object-cover"
									style={{ filter: `blur(${project.background.blur}px)` }}
								/>
							</Show>
						</Show>
						<div class="w-full h-full" style={backgroundStyle()} />
					</div>

					{/* Content Layer */}
					<div class="relative z-10">
						<img
							data-screenshot-preview
							src={convertFileSrc(path)}
							class="max-w-full max-h-[80vh] block transition-all duration-200"
							style={imageStyle()}
						/>
					</div>
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
