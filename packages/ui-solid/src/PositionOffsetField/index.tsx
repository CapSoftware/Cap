import { Slider as KSlider } from "@kobalte/core/slider";
import { cx } from "cva";
import { type JSX, splitProps } from "solid-js";

export type PositionOffset = { x: number; y: number };

export type PositionOffsetFieldProps = {
	value: PositionOffset;
	onChange: (value: PositionOffset) => void;
	onChangeEnd?: (value: PositionOffset) => void;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
	class?: string;
	label?: JSX.Element;
	icon?: JSX.Element;
};

const DEFAULT_MIN = -50;
const DEFAULT_MAX = 50;
const DEFAULT_STEP = 0.1;

export function PositionOffsetField(props: PositionOffsetFieldProps) {
	const [, rest] = splitProps(props, ["value", "onChange", "onChangeEnd"]);

	const min = () => rest.min ?? DEFAULT_MIN;
	const max = () => rest.max ?? DEFAULT_MAX;
	const step = () => rest.step ?? DEFAULT_STEP;

	return (
		<div class={cx("flex flex-col gap-4", rest.class)}>
			<span
				data-disabled={rest.disabled}
				class="flex flex-row items-center gap-[0.375rem] text-gray-12 data-[disabled='true']:text-gray-10 font-medium text-sm"
			>
				{rest.icon}
				{rest.label ?? "Position Offset"}
			</span>
			<PositionAxisRow
				axisLabel="X"
				value={props.value.x}
				min={min()}
				max={max()}
				step={step()}
				disabled={rest.disabled}
				onChange={(v) => props.onChange({ x: v, y: props.value.y })}
				onChangeEnd={(v) => props.onChangeEnd?.({ x: v, y: props.value.y })}
			/>
			<PositionAxisRow
				axisLabel="Y"
				value={props.value.y}
				min={min()}
				max={max()}
				step={step()}
				disabled={rest.disabled}
				onChange={(v) => props.onChange({ x: props.value.x, y: v })}
				onChangeEnd={(v) => props.onChangeEnd?.({ x: props.value.x, y: v })}
			/>
		</div>
	);
}

type PositionAxisRowProps = {
	axisLabel: string;
	value: number;
	min: number;
	max: number;
	step: number;
	disabled?: boolean;
	onChange: (value: number) => void;
	onChangeEnd?: (value: number) => void;
};

function PositionAxisRow(props: PositionAxisRowProps) {
	return (
		<div class="flex flex-row items-center gap-3">
			<span
				data-disabled={props.disabled}
				class="w-4 text-xs font-medium text-gray-11 data-[disabled='true']:text-gray-9"
			>
				{props.axisLabel}
			</span>
			<KSlider
				class="relative px-1 h-8 flex flex-row justify-stretch items-center flex-1"
				value={[props.value]}
				minValue={props.min}
				maxValue={props.max}
				step={props.step}
				disabled={props.disabled}
				onChange={(v) => props.onChange(v[0])}
				onChangeEnd={(v) => props.onChangeEnd?.(v[0])}
			>
				<KSlider.Track class="h-[0.3rem] cursor-pointer relative mx-1 bg-gray-4 rounded-full w-full before:content-[''] before:absolute before:inset-0 before:-top-3 before:-bottom-3">
					<div
						class="absolute top-0 bottom-0 w-px bg-gray-7"
						style={{ left: `${zeroPercent(props.min, props.max)}%` }}
					/>
					<KSlider.Fill class="absolute h-full rounded-full bg-blue-9 ui-disabled:bg-gray-8" />
					<KSlider.Thumb class="bg-gray-1 dark:bg-gray-12 border border-gray-6 shadow-md rounded-full outline-none size-4 -top-[6.3px] ui-disabled:bg-gray-9 after:content-[''] after:absolute after:inset-0 after:-m-3 after:cursor-pointer" />
				</KSlider.Track>
			</KSlider>
			<span
				data-disabled={props.disabled}
				class="w-12 text-right text-xs tabular-nums text-gray-11 data-[disabled='true']:text-gray-9"
			>
				{formatPercent(props.value)}
			</span>
		</div>
	);
}

function zeroPercent(min: number, max: number) {
	if (max === min) return 0;
	const clamped = Math.max(min, Math.min(0, max));
	return ((clamped - min) / (max - min)) * 100;
}

function formatPercent(v: number) {
	return `${v.toFixed(1)}%`;
}
