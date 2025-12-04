import { Popover } from "@kobalte/core/popover";
import { cx } from "cva";
import { createMemo, For, type JSX, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import { BACKGROUND_COLORS, hexToRgb, RgbInput, rgbToHex } from "./ColorPicker";
import { type Annotation, useScreenshotEditorContext } from "./context";
import { Slider } from "./ui";

export function AnnotationConfigBar() {
	const {
		annotations,
		selectedAnnotationId,
		setAnnotations,
		projectHistory,
		setSelectedAnnotationId,
		layersPanelOpen,
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
					<div
						class={cx(
							"absolute top-14 right-0 z-10 border-b border-gray-3 bg-gray-1 dark:bg-gray-2 animate-in fade-in slide-in-from-top-1 duration-150 transition-[left]",
							layersPanelOpen() ? "left-56" : "left-0",
						)}
					>
						<div class="flex items-center justify-center gap-6 px-4 h-11">
							<Show when={!isMask}>
								<ConfigItem label={type === "text" ? "Color" : "Stroke"}>
									<ColorPickerButton
										value={ann().strokeColor}
										onChange={(c) => update("strokeColor", c)}
									/>
								</ConfigItem>
							</Show>

							<Show when={type !== "text" && !isMask}>
								<ConfigItem label="Width" value={`${ann().strokeWidth}px`}>
									<Slider
										value={[ann().strokeWidth]}
										onChange={(v) => update("strokeWidth", v[0])}
										minValue={1}
										maxValue={20}
										step={1}
										class="w-20"
									/>
								</ConfigItem>
							</Show>

							<Show when={type === "rectangle" || type === "circle"}>
								<ConfigItem label="Fill">
									<ColorPickerButton
										value={ann().fillColor}
										onChange={(c) => update("fillColor", c)}
										allowTransparent
									/>
								</ConfigItem>
							</Show>

							<Show when={!isMask}>
								<ConfigItem
									label="Opacity"
									value={`${Math.round(ann().opacity * 100)}%`}
								>
									<Slider
										value={[ann().opacity]}
										onChange={(v) => update("opacity", v[0])}
										minValue={0.1}
										maxValue={1}
										step={0.1}
										class="w-20"
									/>
								</ConfigItem>
							</Show>

							<Show when={type === "mask"}>
								<ConfigItem label="Style">
									<div class="flex gap-1">
										<button
											type="button"
											class={cx(
												"px-2.5 h-6 rounded-md text-xs font-medium transition-colors",
												maskType() === "blur"
													? "bg-blue-9 text-white"
													: "bg-gray-3 text-gray-11 hover:bg-gray-4",
											)}
											onClick={() => update("maskType", "blur")}
										>
											Blur
										</button>
										<button
											type="button"
											class={cx(
												"px-2.5 h-6 rounded-md text-xs font-medium transition-colors",
												maskType() === "pixelate"
													? "bg-blue-9 text-white"
													: "bg-gray-3 text-gray-11 hover:bg-gray-4",
											)}
											onClick={() => update("maskType", "pixelate")}
										>
											Pixelate
										</button>
									</div>
								</ConfigItem>
							</Show>

							<Show when={type === "mask"}>
								<ConfigItem
									label="Intensity"
									value={`${Math.round(maskLevel())}`}
								>
									<Slider
										value={[maskLevel()]}
										onChange={(v) => update("maskLevel", v[0])}
										minValue={4}
										maxValue={50}
										step={1}
										class="w-24"
									/>
								</ConfigItem>
							</Show>

							<Show when={type === "text"}>
								<ConfigItem label="Size" value={`${ann().height}px`}>
									<Slider
										value={[ann().height]}
										onChange={(v) => update("height", v[0])}
										minValue={12}
										maxValue={100}
										step={1}
										class="w-20"
									/>
								</ConfigItem>
							</Show>

							<div class="w-px h-5 bg-gray-4" />

							<button
								type="button"
								class="text-xs text-blue-11 font-medium hover:text-blue-9 transition-colors"
								onClick={() => setSelectedAnnotationId(null)}
							>
								Done
							</button>
						</div>
					</div>
				);
			}}
		</Show>
	);
}

function ConfigItem(props: {
	label: string;
	value?: string;
	children: JSX.Element;
}) {
	return (
		<div class="flex items-center gap-2">
			<span class="text-[11px] text-gray-10 font-medium whitespace-nowrap">
				{props.label}
				{props.value && (
					<span class="text-gray-11 ml-1 tabular-nums">{props.value}</span>
				)}
			</span>
			{props.children}
		</div>
	);
}

function ColorPickerButton(props: {
	value: string;
	onChange: (value: string) => void;
	allowTransparent?: boolean;
}) {
	const rgbValue = createMemo(() => {
		if (props.value === "transparent")
			return [0, 0, 0] as [number, number, number];
		const rgb = hexToRgb(props.value);
		if (!rgb) return [0, 0, 0] as [number, number, number];
		return [rgb[0], rgb[1], rgb[2]] as [number, number, number];
	});

	const isTransparent = createMemo(() => props.value === "transparent");

	return (
		<Popover placement="bottom" gutter={8}>
			<Popover.Trigger class="outline-none group">
				<div class="size-5 rounded-full border border-gray-5 transition-all group-hover:scale-110 group-hover:border-gray-7 group-active:scale-95 overflow-hidden">
					<div
						class="w-full h-full"
						style={{
							background: isTransparent()
								? "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)"
								: props.value,
							"background-size": isTransparent() ? "3px 3px" : "auto",
							"background-color": isTransparent() ? "white" : props.value,
						}}
					/>
				</div>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content class="z-[200] w-[220px] overflow-hidden rounded-lg border border-gray-4 bg-gray-1 dark:bg-gray-2 shadow-lg animate-in fade-in zoom-in-95 p-2.5">
					<div class="flex flex-col gap-2.5">
						<RgbInput
							value={rgbValue()}
							onChange={(rgb) => {
								props.onChange(rgbToHex(rgb));
							}}
						/>

						<div class="grid grid-cols-6 gap-1.5">
							<Show when={props.allowTransparent}>
								<Tooltip content="Transparent">
									<button
										type="button"
										onClick={() => props.onChange("transparent")}
										class="size-5 rounded-full border border-gray-4 relative overflow-hidden hover:scale-110 transition-transform"
										style={{
											background:
												"linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)",
											"background-size": "3px 3px",
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
										class="size-5 rounded-full border border-black/10 hover:scale-110 transition-transform relative"
										style={{ "background-color": color }}
										onClick={() => props.onChange(color)}
									>
										<Show
											when={props.value.toLowerCase() === color.toLowerCase()}
										>
											<div class="absolute inset-0 ring-2 ring-white/50 rounded-full" />
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
