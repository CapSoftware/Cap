import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs";
import { PaddingField } from "./index";

const meta: Meta<typeof PaddingField> = {
	title: "Editor/PaddingField",
	component: PaddingField,
};
export default meta;

type Story = StoryObj<typeof meta>;

function Harness(props: {
	initial?: number;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
}) {
	const [value, setValue] = createSignal(props.initial ?? 0);
	const [lastEnd, setLastEnd] = createSignal<number | null>(null);

	return (
		<div class="w-[320px] p-4 bg-gray-1 rounded-lg flex flex-col gap-4">
			<PaddingField
				value={value()}
				onChange={setValue}
				onChangeEnd={setLastEnd}
				min={props.min}
				max={props.max}
				step={props.step}
				disabled={props.disabled}
			/>
			<div class="text-xs text-gray-11 font-mono">
				<div>value: {value().toFixed(2)}</div>
				<div>
					lastEnd: {lastEnd() !== null ? lastEnd()!.toFixed(2) : "(none)"}
				</div>
			</div>
		</div>
	);
}

export const Default: Story = {
	render: () => <Harness />,
};

export const Mid: Story = {
	render: () => <Harness initial={20} />,
};

export const Max: Story = {
	render: () => <Harness initial={40} />,
};

export const Disabled: Story = {
	render: () => <Harness initial={15} disabled />,
};
