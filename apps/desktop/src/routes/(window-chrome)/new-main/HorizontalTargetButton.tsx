import { cx } from "cva";
import { type Component, type ComponentProps, splitProps } from "solid-js";

type HorizontalTargetButtonProps = {
	selected: boolean;
	Component: Component<ComponentProps<"svg">>;
	name: string;
	disabled?: boolean;
} & ComponentProps<"button">;

function HorizontalTargetButton(props: HorizontalTargetButtonProps) {
	const [local, rest] = splitProps(props, ["selected", "Component", "name", "disabled", "class"]);

	return (
		<button
			{...rest}
			type="button"
			disabled={local.disabled}
			aria-pressed={local.selected ? "true" : "false"}
			class={cx(
				"flex w-full h-9 flex-row items-center gap-3 px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1",
				local.selected ? "text-gray-12" : "text-gray-12 hover:bg-white/[0.08]",
				local.disabled && "pointer-events-none opacity-60",
				local.class
			)}
			style={{
				"border-radius": "10px",
				border: "0.5px solid rgba(255, 255, 255, 0.10)",
				background: "rgba(255, 255, 255, 0.05)",
				"box-shadow": "0 1px 1px -0.5px rgba(0, 0, 0, 0.16)",
			}}
		>
			<local.Component
				class={cx("size-5 transition-colors flex-shrink-0", local.selected ? "text-gray-12" : "text-gray-9")}
			/>
			<p class="text-sm font-medium">{local.name}</p>
		</button>
	);
}

export default HorizontalTargetButton;
