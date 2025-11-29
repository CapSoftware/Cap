import { Popover } from "@kobalte/core/popover";
import { createMemo, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import Tooltip from "~/components/Tooltip";
import { BACKGROUND_COLORS, hexToRgb, RgbInput, rgbToHex } from "./ColorPicker";
import { type Annotation, useScreenshotEditorContext } from "./context";
import { Slider } from "./ui";

export function AnnotationConfig() {
	const {
		annotations,
		selectedAnnotationId,
		setAnnotations,
		projectHistory,
		setSelectedAnnotationId,
	} = useScreenshotEditorContext();

	const selected = createMemo(() =>
		annotations.find((a) => a.id === selectedAnnotationId()),
	);

	const update = <K extends keyof Annotation>(
		field: K,
		value: Annotation[K],
	) => {
		projectHistory.push();
		setAnnotations((a) => a.id === selectedAnnotationId(), field, value);
	};

	return (
		<Show when={selected()}>
			{(ann) => {
				const type = ann().type;
				const isMask = type === "mask";
				const maskType = () => ann().maskType ?? "blur";
				const maskLevel = () => ann().maskLevel ?? 16;
				return (
					<Portal>
						<div class="fixed left-1/2 -translate-x-1/2 top-20 z-50 overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95">
							<div class="flex items-center gap-4 p-4">
								<Show when={!isMask}>
									<div class="flex flex-col gap-1">
										<span class="text-[10px] text-gray-11 font-medium uppercase tracking-wider">
											{type === "text" ? "Color" : "Stroke"}
										</span>
										<ColorPickerButton
											value={ann().strokeColor}
											onChange={(c) => update("strokeColor", c)}
										/>
									</div>
								</Show>

								<Show when={type !== "text" && !isMask}>
									<div class="flex flex-col gap-1 w-24">
										<span class="text-[10px] text-gray-11 font-medium uppercase tracking-wider flex justify-between">
											Width <span>{ann().strokeWidth}px</span>
										</span>
										<Slider
											value={[ann().strokeWidth]}
											onChange={(v) => update("strokeWidth", v[0])}
											minValue={1}
											maxValue={20}
											step={1}
											class="w-full"
										/>
									</div>
								</Show>

								<Show when={type === "rectangle" || type === "circle"}>
									<div class="flex flex-col gap-1">
										<span class="text-[10px] text-gray-11 font-medium uppercase tracking-wider">
											Fill
										</span>
										<ColorPickerButton
											value={ann().fillColor}
											onChange={(c) => update("fillColor", c)}
											allowTransparent
										/>
									</div>
								</Show>

								<Show when={!isMask}>
									<div class="flex flex-col gap-1 w-24">
										<span class="text-[10px] text-gray-11 font-medium uppercase tracking-wider flex justify-between">
											Opacity <span>{Math.round(ann().opacity * 100)}%</span>
										</span>
										<Slider
											value={[ann().opacity]}
											onChange={(v) => update("opacity", v[0])}
											minValue={0.1}
											maxValue={1}
											step={0.1}
											class="w-full"
										/>
									</div>
								</Show>

								<Show when={type === "mask"}>
									<div class="flex flex-col gap-1">
										<span class="text-[10px] text-gray-11 font-medium uppercase tracking-wider">
											Style
										</span>
										<div class="flex gap-1">
											<button
												type="button"
												class={`px-3 h-8 rounded-lg border ${
													maskType() === "blur"
														? "border-blue-7 bg-blue-3 text-blue-11"
														: "border-gray-4 bg-gray-2 text-gray-11"
												}`}
												onClick={() => update("maskType", "blur")}
											>
												Blur
											</button>
											<button
												type="button"
												class={`px-3 h-8 rounded-lg border ${
													maskType() === "pixelate"
														? "border-blue-7 bg-blue-3 text-blue-11"
														: "border-gray-4 bg-gray-2 text-gray-11"
												}`}
												onClick={() => update("maskType", "pixelate")}
											>
												Pixelate
											</button>
										</div>
									</div>
								</Show>

								<Show when={type === "mask"}>
									<div class="flex flex-col gap-1 w-28">
										<span class="text-[10px] text-gray-11 font-medium uppercase tracking-wider flex justify-between">
											Intensity <span>{Math.round(maskLevel())}</span>
										</span>
										<Slider
											value={[maskLevel()]}
											onChange={(v) => update("maskLevel", v[0])}
											minValue={4}
											maxValue={50}
											step={1}
											class="w-full"
										/>
									</div>
								</Show>

								<Show when={type === "text"}>
									<div class="flex flex-col gap-1 w-24">
										<span class="text-[10px] text-gray-11 font-medium uppercase tracking-wider flex justify-between">
											Size <span>{ann().height}px</span>
										</span>
										<Slider
											value={[ann().height]}
											onChange={(v) => update("height", v[0])}
											minValue={12}
											maxValue={100}
											step={1}
											class="w-full"
										/>
									</div>
								</Show>

								<div class="w-px h-8 bg-gray-4 mx-1" />

								<button
									type="button"
									class="text-xs text-blue-11 font-medium hover:text-blue-9 px-2 h-full"
									onClick={() => setSelectedAnnotationId(null)}
								>
									Done
								</button>
							</div>
						</div>
					</Portal>
				);
			}}
		</Show>
	);
}

function ColorPickerButton(props: {
	value: string;
	onChange: (value: string) => void;
	allowTransparent?: boolean;
}) {
	// Helper to handle RGB <-> Hex
	const rgbValue = createMemo(() => {
		if (props.value === "transparent")
			return [0, 0, 0] as [number, number, number];
		const rgb = hexToRgb(props.value);
		if (!rgb) return [0, 0, 0] as [number, number, number];
		return [rgb[0], rgb[1], rgb[2]] as [number, number, number];
	});

	const isTransparent = createMemo(() => props.value === "transparent");

	return (
		<Popover placement="bottom">
			<Popover.Trigger class="outline-none group">
				<div class="size-6 rounded-full border border-gray-4 p-0.5 bg-white dark:bg-gray-2 transition-transform group-hover:scale-105 group-active:scale-95 shadow-sm">
					<div
						class="w-full h-full rounded-full border border-black/5"
						style={{
							background: isTransparent()
								? "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)"
								: props.value,
							"background-size": isTransparent() ? "4px 4px" : "auto",
							"background-color": isTransparent() ? "white" : props.value,
						}}
					/>
				</div>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content class="z-[200] w-[240px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95 p-3">
					<div class="flex flex-col gap-3">
						<RgbInput
							value={rgbValue()}
							onChange={(rgb) => {
								props.onChange(rgbToHex(rgb));
							}}
						/>

						<div class="grid grid-cols-6 gap-2">
							<Show when={props.allowTransparent}>
								<Tooltip content="Transparent">
									<button
										type="button"
										onClick={() => props.onChange("transparent")}
										class="size-6 rounded-full border border-gray-3 relative overflow-hidden hover:scale-110 transition-transform"
										style={{
											background:
												"linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)",
											"background-size": "4px 4px",
											"background-color": "white",
										}}
									>
										<Show when={isTransparent()}>
											<div class="absolute inset-0 ring-2 ring-blue-9 rounded-full" />
										</Show>
									</button>
								</Tooltip>
							</Show>
							<For each={BACKGROUND_COLORS.filter((c) => c !== "#00000000")}>
								{(color: string) => (
									<button
										type="button"
										class="size-6 rounded-full border border-black/10 hover:scale-110 transition-transform relative"
										style={{ "background-color": color }}
										onClick={() => props.onChange(color)}
									>
										<Show
											when={props.value.toLowerCase() === color.toLowerCase()}
										>
											<div class="absolute inset-0 ring-2 ring-white/50 rounded-full shadow-sm" />
										</Show>
									</button>
								)}
							</For>
						</div>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}
