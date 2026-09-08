import { Collapsible as KCollapsible } from "@kobalte/core/collapsible";
import { cx } from "cva";
import { createSignal, For, Show } from "solid-js";
import { produce } from "solid-js/store";
import { Toggle } from "~/components/Toggle";
import IconLucideGrip from "~icons/lucide/grip";
import IconLucideMousePointer2 from "~icons/lucide/mouse-pointer-2";
import IconLucideSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import {
	COLOR_CORRECTION_PRESETS,
	COLOR_PRESET_CUSTOM,
	COLOR_PREVIEW_GRAIN,
	COLOR_PREVIEW_SCENE,
	type ColorCorrectionTarget,
	type ColorCorrectionValues,
	type ColorPresetDefinition,
} from "./colorCorrection";
import { useEditorContext } from "./context";
import { Field, Slider } from "./ui";

const ADJUST_SLIDERS: {
	key: keyof ColorCorrectionValues;
	label: string;
	min: number;
	max: number;
	keepsPreset?: boolean;
}[] = [
	{ key: "intensity", label: "Strength", min: 0, max: 100, keepsPreset: true },
	{ key: "exposure", label: "Exposure", min: -100, max: 100 },
	{ key: "contrast", label: "Contrast", min: -100, max: 100 },
	{ key: "saturation", label: "Saturation", min: -100, max: 100 },
	{ key: "temperature", label: "Temperature", min: -100, max: 100 },
	{ key: "tint", label: "Tint", min: -100, max: 100 },
	{ key: "fade", label: "Fade", min: 0, max: 100 },
	{ key: "splitTone", label: "Split Tone", min: -100, max: 100 },
	{ key: "vignette", label: "Vignette", min: 0, max: 100 },
];

function ColorPresetPreview(props: { preset: ColorPresetDefinition }) {
	return (
		<div class="overflow-hidden relative w-full rounded-md aspect-video">
			<div
				class="absolute inset-0"
				style={{
					background: COLOR_PREVIEW_SCENE,
					filter: props.preset.preview.filter,
				}}
			/>
			<Show when={props.preset.preview.overlay}>
				<div
					class="absolute inset-0"
					style={{
						background: props.preset.preview.overlay,
						"mix-blend-mode": "overlay",
					}}
				/>
			</Show>
			<Show when={props.preset.values.vignette > 0}>
				<div
					class="absolute inset-0"
					style={{
						background: `radial-gradient(ellipse at center, transparent 40%, rgba(0, 0, 0, ${(
							props.preset.values.vignette * 0.75
						).toFixed(3)}) 100%)`,
					}}
				/>
			</Show>
			<Show when={props.preset.values.grain > 0}>
				<div
					class="absolute inset-0"
					style={{
						"background-image": COLOR_PREVIEW_GRAIN,
						opacity: Math.min(1, props.preset.values.grain * 1.2),
						"mix-blend-mode": "overlay",
					}}
				/>
			</Show>
		</div>
	);
}

export function ColorCorrectionSection(props: {
	target: ColorCorrectionTarget;
	scrollRef?: HTMLDivElement;
}) {
	const { project, setProject } = useEditorContext();
	const [adjustOpen, setAdjustOpen] = createSignal(false);

	const grade = () => project.colorCorrection[props.target];

	const applyPreset = (preset: ColorPresetDefinition) => {
		setProject("colorCorrection", props.target, {
			preset: preset.id,
			...preset.values,
		});
	};

	const setValue = (
		key: keyof ColorCorrectionValues,
		value: number,
		keepsPreset = false,
	) => {
		setProject(
			"colorCorrection",
			props.target,
			produce((current) => {
				current[key] = value;
				if (!keepsPreset) current.preset = COLOR_PRESET_CUSTOM;
			}),
		);
	};

	const handleAdjustToggle = (open: boolean) => {
		setAdjustOpen(open);
		if (!open) return;
		setTimeout(() => {
			props.scrollRef?.scrollTo({
				top: props.scrollRef.scrollHeight,
				behavior: "smooth",
			});
		}, 200);
	};

	return (
		<>
			<Field
				name="Color Correction"
				icon={<IconLucideSlidersHorizontal class="size-4" />}
			>
				<div class="grid grid-cols-3 gap-2">
					<For each={COLOR_CORRECTION_PRESETS}>
						{(preset) => (
							<button
								type="button"
								title={preset.description}
								onClick={() => applyPreset(preset)}
								class={cx(
									"flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors",
									grade().preset === preset.id
										? "border-blue-9 ring-1 ring-blue-9"
										: "border-gray-3 hover:border-gray-5",
								)}
							>
								<ColorPresetPreview preset={preset} />
								<span class="px-0.5 text-xs font-medium text-gray-12">
									{preset.label}
								</span>
							</button>
						)}
					</For>
				</div>
			</Field>
			<Field name="Grain" icon={<IconLucideGrip class="size-4" />}>
				<Slider
					value={[grade().grain * 100]}
					onChange={(v) => setValue("grain", v[0] / 100, true)}
					minValue={0}
					maxValue={100}
					step={1}
					formatTooltip="%"
				/>
			</Field>
			<Show when={props.target === "screen"}>
				<Field
					name="Apply to cursor"
					icon={<IconLucideMousePointer2 class="size-4" />}
					value={
						<Toggle
							checked={project.colorCorrection.gradeCursor}
							onChange={(gradeCursor) =>
								setProject("colorCorrection", "gradeCursor", gradeCursor)
							}
						/>
					}
				/>
			</Show>
			<div class="w-full">
				<KCollapsible open={adjustOpen()} onOpenChange={handleAdjustToggle}>
					<KCollapsible.Trigger class="flex gap-1 items-center w-full text-sm font-medium text-left group text-gray-12 hover:text-gray-10 transition duration-200 outline-hidden">
						Fine-tune colors
						<IconCapChevronDown class="transition-transform duration-200 size-5 group-data-expanded:rotate-180" />
					</KCollapsible.Trigger>
					<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
						<div class="mt-4 space-y-6 font-medium">
							<For each={ADJUST_SLIDERS}>
								{(slider) => (
									<Field name={slider.label}>
										<Slider
											value={[Math.round(grade()[slider.key] * 100)]}
											onChange={(v) =>
												setValue(
													slider.key,
													v[0] / 100,
													slider.keepsPreset ?? false,
												)
											}
											minValue={slider.min}
											maxValue={slider.max}
											step={1}
											formatTooltip="%"
										/>
									</Field>
								)}
							</For>
						</div>
					</KCollapsible.Content>
				</KCollapsible>
			</div>
		</>
	);
}
