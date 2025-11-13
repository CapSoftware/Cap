import { cx } from "cva";
import { type Component, type ComponentProps, splitProps } from "solid-js";
import { RecordFill } from "~/icons";

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
				"group flex w-full h-9 flex-row items-center gap-3 px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1",
				"rounded-[10px] border border-white/10 bg-white/[0.05]",
				"hover:bg-[#1C8AF8]/20",
				local.selected ? "text-gray-12" : "text-gray-12",
				local.disabled && "pointer-events-none opacity-60",
				local.class
			)}
			style={{
				"box-shadow": "0 1px 1px -0.5px rgba(0, 0, 0, 0.16)",
			}}
		>
			{/* <local.Component
				class={cx("size-5 transition-colors flex-shrink-0", local.selected ? "text-gray-12" : "text-gray-9")}
			/> */}
			<div class="relative size-4 flex-shrink-0 items-center justify-center">
				<local.Component
					class={cx(
						"absolute inset-0 size-4 transition-opacity duration-200",
						local.selected ? "text-gray-12" : "text-gray-9",
						"group-hover:opacity-0"
					)}
				/>
				<RecordFill class="absolute inset-0 size-4 transition-opacity duration-200 opacity-0 group-hover:opacity-100 text-[#60ADFA]" />
			</div>
			<p class="text-sm font-medium">{local.name}</p>
		</button>
	);
}

export default HorizontalTargetButton;
