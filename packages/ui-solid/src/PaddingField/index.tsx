import { Slider as KSlider } from "@kobalte/core/slider";
import { cx } from "cva";
import { type JSX, splitProps } from "solid-js";

export type PaddingFieldProps = {
	value: number;
	onChange: (value: number) => void;
	onChangeEnd?: (value: number) => void;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
	class?: string;
	label?: JSX.Element;
	icon?: JSX.Element;
};

const DEFAULT_MIN = 0;
const DEFAULT_MAX = 40;
const DEFAULT_STEP = 0.1;

export function PaddingField(props: PaddingFieldProps) {
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
				{rest.label ?? "Padding"}
			</span>
			<div class="flex flex-row items-center gap-3">
				<KSlider
					class="relative px-1 h-8 flex flex-row justify-stretch items-center flex-1"
					value={[props.value]}
					minValue={min()}
					maxValue={max()}
					step={step()}
					disabled={rest.disabled}
					onChange={(v) => props.onChange(v[0])}
					onChangeEnd={(v) => props.onChangeEnd?.(v[0])}
				>
					<KSlider.Track class="h-[0.3rem] cursor-pointer relative mx-1 bg-gray-4 rounded-full w-full before:content-[''] before:absolute before:inset-0 before:-top-3 before:-bottom-3">
						<KSlider.Fill class="absolute -ml-2 h-full rounded-full bg-blue-9 ui-disabled:bg-gray-8" />
						<KSlider.Thumb class="bg-gray-1 dark:bg-gray-12 border border-gray-6 shadow-md rounded-full outline-none size-4 -top-[6.3px] ui-disabled:bg-gray-9 after:content-[''] after:absolute after:inset-0 after:-m-3 after:cursor-pointer" />
					</KSlider.Track>
				</KSlider>
				<span
					data-disabled={rest.disabled}
					class="w-12 text-right text-xs tabular-nums text-gray-11 data-[disabled='true']:text-gray-9"
				>
					{props.value.toFixed(1)}%
				</span>
			</div>
		</div>
	);
}
