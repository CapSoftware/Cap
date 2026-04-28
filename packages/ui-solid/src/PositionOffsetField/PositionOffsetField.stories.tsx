import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs";
import {
	PositionOffsetField,
	type PositionOffset,
} from "./index";

const meta: Meta<typeof PositionOffsetField> = {
	title: "Editor/PositionOffsetField",
	component: PositionOffsetField,
};
export default meta;

type Story = StoryObj<typeof meta>;

function Harness(props: {
	initial?: PositionOffset;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
}) {
	const [value, setValue] = createSignal<PositionOffset>(
		props.initial ?? { x: 0, y: 0 },
	);
	const [lastEnd, setLastEnd] = createSignal<PositionOffset | null>(null);

	return (
		<div class="w-[320px] p-4 bg-gray-1 rounded-lg flex flex-col gap-4">
			<PositionOffsetField
				value={value()}
				onChange={setValue}
				onChangeEnd={setLastEnd}
				min={props.min}
				max={props.max}
				step={props.step}
				disabled={props.disabled}
			/>
			<div class="text-xs text-gray-11 font-mono">
				<div>
					value: x={value().x.toFixed(2)} y={value().y.toFixed(2)}
				</div>
				<div>
					lastEnd:{" "}
					{lastEnd()
						? `x=${lastEnd()!.x.toFixed(2)} y=${lastEnd()!.y.toFixed(2)}`
						: "(none)"}
				</div>
			</div>
		</div>
	);
}

export const Default: Story = {
	render: () => <Harness />,
};

export const InitialOffset: Story = {
	render: () => <Harness initial={{ x: 20, y: -15 }} />,
};

export const NarrowRange: Story = {
	render: () => <Harness min={-25} max={25} step={1} />,
};

export const Disabled: Story = {
	render: () => <Harness initial={{ x: 10, y: 10 }} disabled />,
};
