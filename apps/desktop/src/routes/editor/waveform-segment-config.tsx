import { cx } from "cva";
import { For, Index, type JSX, Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import { useEditorContext } from "./context";
import { HexColorInput } from "./text-style";
import { Field, Section, Slider } from "./ui";
import {
	placeWaveform,
	WAVEFORM_MAX_BAR_COUNT,
	WAVEFORM_MIN_BAR_COUNT,
	WAVEFORM_PLACEMENTS,
	WAVEFORM_SOURCES,
	WAVEFORM_STYLES,
	type WaveformSegment,
	type WaveformStyle,
	waveformPlacementActive,
} from "./waveform";

const DEFAULT_SECONDARY_COLOR = "#7C9CFF";
const PREVIEW_LEVELS = [0.35, 0.6, 0.95, 0.55, 0.8, 0.4, 0.7, 0.3];

function StylePreview(props: { style: WaveformStyle }) {
	const step = 44 / PREVIEW_LEVELS.length;
	const x = (index: number) => 2 + step * index + step / 2;
	const shapes = (): JSX.Element => {
		switch (props.style) {
			case "bars":
				return (
					<Index each={PREVIEW_LEVELS}>
						{(level, index) => (
							<rect
								x={x(index) - 1.75}
								y={20 - level() * 18}
								width={3.5}
								height={level() * 18}
								rx={1.75}
							/>
						)}
					</Index>
				);
			case "mirrored":
				return (
					<Index each={PREVIEW_LEVELS}>
						{(level, index) => (
							<rect
								x={x(index) - 1.75}
								y={11 - level() * 9}
								width={3.5}
								height={level() * 18}
								rx={1.75}
							/>
						)}
					</Index>
				);
			case "line":
				return (
					<polyline
						fill="none"
						stroke="currentColor"
						stroke-width={2}
						stroke-linecap="round"
						stroke-linejoin="round"
						points={PREVIEW_LEVELS.map(
							(level, index) => `${x(index)},${20 - level * 18}`,
						).join(" ")}
					/>
				);
			case "dots":
				return (
					<Index each={PREVIEW_LEVELS}>
						{(level, index) => (
							<Index
								each={Array.from({
									length: Math.max(1, Math.round(level() * 4)),
								})}
							>
								{(_, dot) => (
									<circle cx={x(index)} cy={18 - dot * 4.5} r={1.6} />
								)}
							</Index>
						)}
					</Index>
				);
		}
	};
	return (
		<svg
			viewBox="0 0 48 22"
			class="h-[22px] w-12"
			fill="currentColor"
			aria-hidden="true"
		>
			{shapes()}
		</svg>
	);
}

function Choice(props: {
	active: boolean;
	onClick: () => void;
	children: JSX.Element;
	class?: string;
}) {
	return (
		<button
			type="button"
			aria-pressed={props.active}
			onClick={props.onClick}
			class={cx(
				"flex min-w-0 items-center justify-center rounded-lg text-[12px] font-medium transition-[box-shadow,color] duration-100",
				props.active
					? "bg-ed-card text-ed-text-1 ring-2 ring-ed-accent"
					: "bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover hover:text-ed-text-1",
				props.class,
			)}
		>
			{props.children}
		</button>
	);
}

export function WaveformSegmentConfig(props: {
	segment: WaveformSegment;
	segmentIndex: number;
	brandColorSwatches: OrganizationBrandColorSwatch[];
}) {
	const { setProject } = useEditorContext();
	const update = (value: Partial<WaveformSegment>) =>
		setProject("timeline", "waveformSegments", props.segmentIndex, value);

	return (
		<div class="flex flex-col gap-4">
			<Field inline name="Show waveform">
				<Toggle
					checked={props.segment.enabled}
					onChange={(enabled) => update({ enabled })}
				/>
			</Field>

			<Section name="Style">
				<div class="grid grid-cols-4 gap-1.5">
					<For each={WAVEFORM_STYLES}>
						{(option) => (
							<Choice
								class="flex-col gap-1.5 pt-2.5 pb-2"
								active={props.segment.style === option.value}
								onClick={() => update({ style: option.value })}
							>
								<StylePreview style={option.value} />
								<span>{option.label}</span>
							</Choice>
						)}
					</For>
				</div>
			</Section>

			<Section name="Color">
				<HexColorInput
					value={props.segment.color}
					brandColorSwatches={props.brandColorSwatches}
					onChange={(color) => update({ color })}
				/>
				<Field inline name="Gradient">
					<Toggle
						size="sm"
						checked={props.segment.secondaryColor !== null}
						onChange={(enabled) =>
							update({
								secondaryColor: enabled ? DEFAULT_SECONDARY_COLOR : null,
							})
						}
					/>
				</Field>
				<Show when={props.segment.secondaryColor}>
					{(secondaryColor) => (
						<HexColorInput
							value={secondaryColor()}
							brandColorSwatches={props.brandColorSwatches}
							onChange={(color) => update({ secondaryColor: color })}
						/>
					)}
				</Show>
			</Section>

			<Section name="Shape">
				<div class="flex flex-col">
					<Field inline name="Bars" value={props.segment.barCount}>
						<Slider
							value={[props.segment.barCount]}
							minValue={WAVEFORM_MIN_BAR_COUNT}
							maxValue={WAVEFORM_MAX_BAR_COUNT}
							step={1}
							formatTooltip={(value) => `${value}`}
							onChange={(value) => update({ barCount: value[0] })}
						/>
					</Field>
					<Field
						inline
						name="Bar width"
						value={`${Math.round(props.segment.barWidth * 100)}%`}
					>
						<Slider
							value={[props.segment.barWidth * 100]}
							minValue={5}
							maxValue={100}
							step={1}
							formatTooltip="%"
							onChange={(value) => update({ barWidth: value[0] / 100 })}
						/>
					</Field>
					<Field
						inline
						name="Roundness"
						value={`${Math.round(props.segment.rounding * 100)}%`}
					>
						<Slider
							value={[props.segment.rounding * 100]}
							minValue={0}
							maxValue={100}
							step={1}
							formatTooltip="%"
							onChange={(value) => update({ rounding: value[0] / 100 })}
						/>
					</Field>
					<Field
						inline
						name="Opacity"
						value={`${Math.round(props.segment.opacity * 100)}%`}
					>
						<Slider
							value={[props.segment.opacity * 100]}
							minValue={0}
							maxValue={100}
							step={1}
							formatTooltip="%"
							onChange={(value) => update({ opacity: value[0] / 100 })}
						/>
					</Field>
				</div>
			</Section>

			<Section name="Motion">
				<div class="flex flex-col">
					<Field
						inline
						name="Sensitivity"
						value={`${props.segment.sensitivity.toFixed(2)}x`}
					>
						<Slider
							value={[props.segment.sensitivity]}
							minValue={0.2}
							maxValue={3}
							step={0.05}
							formatTooltip={(value) => `${value.toFixed(2)}x`}
							onChange={(value) => update({ sensitivity: value[0] })}
						/>
					</Field>
					<Field
						inline
						name="Smoothing"
						value={`${Math.round(props.segment.smoothing * 100)}%`}
					>
						<Slider
							value={[props.segment.smoothing * 100]}
							minValue={0}
							maxValue={100}
							step={1}
							formatTooltip="%"
							onChange={(value) => update({ smoothing: value[0] / 100 })}
						/>
					</Field>
				</div>
				<Field name="Listen to">
					<div class="grid grid-cols-3 gap-1.5">
						<For each={WAVEFORM_SOURCES}>
							{(option) => (
								<Choice
									class="h-7 px-1"
									active={props.segment.source === option.value}
									onClick={() => update({ source: option.value })}
								>
									<span class="truncate">{option.label}</span>
								</Choice>
							)}
						</For>
					</div>
				</Field>
			</Section>

			<Section name="Position">
				<div class="grid grid-cols-4 gap-1.5">
					<For each={WAVEFORM_PLACEMENTS}>
						{(option) => (
							<Choice
								class="h-7 px-1"
								active={waveformPlacementActive(props.segment, option.value)}
								onClick={() =>
									update(placeWaveform(props.segment, option.value))
								}
							>
								<span class="truncate">{option.label}</span>
							</Choice>
						)}
					</For>
				</div>
				<p class="text-[11px] leading-relaxed text-ed-text-3">
					Drag the waveform on the canvas to move it, or pull a corner to
					resize.
				</p>
			</Section>
		</div>
	);
}
