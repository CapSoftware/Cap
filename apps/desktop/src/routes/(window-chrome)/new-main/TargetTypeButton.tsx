import { cx } from "cva";
import type { Component, ComponentProps } from "solid-js";

function TargetTypeButton(
	props: {
		selected: boolean;
		Component: Component<ComponentProps<"svg">>;
		name: string;
		disabled?: boolean;
	} & ComponentProps<"div">,
) {
	return (
		<div
			{...props}
			class={cx(
				"flex-1 text-center hover:bg-gray-4 bg-gray-3 flex flex-col ring-offset-gray-1 ring-offset-2 items-center justify-end gap-2 py-1.5 rounded-lg transition-all",
				props.selected
					? "bg-gray-3 text-white ring-blue-9 ring-1"
					: "ring-transparent ring-0",
				props.disabled ? "opacity-70 pointer-events-none" : "",
			)}
		>
			<props.Component
				class={cx(
					"size-6 transition-colors",
					props.selected ? "text-gray-12" : "text-gray-9",
				)}
			/>
			<p class="text-xs text-gray-12">{props.name}</p>
		</div>
	);
}

export default TargetTypeButton;
