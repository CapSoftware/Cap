import { Collapsible as KCollapsible } from "@kobalte/core/collapsible";
import { cx } from "cva";
import { createSignal, For, Show } from "solid-js";
import { produce } from "solid-js/store";
import { Toggle } from "~/components/Toggle";
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
import { Field, Section, Slider } from "./ui";

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
			<Section name="Color correction">
				<div class="grid grid-cols-3 gap-2">
					<For each={COLOR_CORRECTION_PRESETS}>
						{(preset) => (
							<button
								type="button"
								title={preset.description}
								onClick={() => applyPreset(preset)}
								class={cx(
									"flex flex-col gap-1.5 rounded-lg p-1.5 text-left transition-shadow duration-150",
									grade().preset === preset.id
										? "ring-2 ring-ed-accent ring-offset-2 ring-offset-ed-card"
										: "ring-1 ring-ed-line hover:ring-ed-line-strong",
								)}
							>
								<ColorPresetPreview preset={preset} />
								<span class="px-0.5 text-[11px] text-ed-text-2">
									{preset.label}
								</span>
							</button>
						)}
					</For>
				</div>
			</Section>
			<Field inline name="Grain" value={`${(grade().grain * 100).toFixed(1)}%`}>
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
				<Field inline name="Apply to cursor">
					<Toggle
						checked={project.colorCorrection.gradeCursor}
						onChange={(gradeCursor) =>
							setProject("colorCorrection", "gradeCursor", gradeCursor)
						}
					/>
				</Field>
			</Show>
			<div class="w-full">
				<KCollapsible open={adjustOpen()} onOpenChange={handleAdjustToggle}>
					<KCollapsible.Trigger class="flex gap-1 items-center w-full text-[12px] font-medium text-left group text-ed-text-2 hover:text-ed-text-1 transition-colors duration-200 outline-hidden">
						Fine-tune colors
						<IconCapChevronDown class="transition-transform duration-200 size-3.5 text-ed-text-3 group-data-expanded:rotate-180" />
					</KCollapsible.Trigger>
					<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
						<div class="flex flex-col mt-2">
							<For each={ADJUST_SLIDERS}>
								{(slider) => (
									<Field
										inline
										name={slider.label}
										value={`${Math.round(grade()[slider.key] * 100).toFixed(1)}%`}
									>
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
