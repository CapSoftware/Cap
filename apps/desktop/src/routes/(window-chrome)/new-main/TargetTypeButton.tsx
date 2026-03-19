import { cx } from "cva";
import { type Component, type ComponentProps, splitProps } from "solid-js";

type TargetTypeButtonProps = {
	selected: boolean;
	Component: Component<ComponentProps<"svg">>;
	name: string;
	disabled?: boolean;
} & ComponentProps<"button">;

function TargetTypeButton(props: TargetTypeButtonProps) {
	const [local, rest] = splitProps(props, [
		"selected",
		"Component",
		"name",
		"disabled",
		"class",
	]);

	return (
		<button
			{...rest}
			type="button"
			disabled={local.disabled}
			aria-pressed={local.selected ? "true" : "false"}
			class={cx(
				"flex flex-1 flex-col items-center justify-end gap-1 rounded-lg border border-gray-5 bg-gray-3 py-2 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1",
				local.selected ? "text-gray-12" : "text-gray-12 hover:bg-gray-4",
				local.disabled && "pointer-events-none opacity-60",
				local.class,
			)}
		>
			<local.Component
				class={cx(
					"size-5 transition-colors",
					local.selected ? "text-gray-12" : "text-gray-9",
				)}
			/>
			<p class="text-xs">{local.name}</p>
		</button>
	);
}

export default TargetTypeButton;
