import { Switch as KSwitch } from "@kobalte/core/switch";
import { cva } from "cva";
import { type ComponentProps, splitProps } from "solid-js";

const toggleControlStyles = cva(
	"rounded-full bg-gray-6 data-disabled:bg-gray-3 data-checked:bg-blue-500 transition-colors",
	{
		variants: {
			size: {
				sm: "w-9 h-5 p-0.5",
				md: "w-11 h-6 p-0.5",
				lg: "w-14 h-7 p-0.75",
			},
		},
		defaultVariants: {
			size: "md",
		},
	},
);

const toggleThumbStyles = cva(
	"bg-white rounded-full transition-transform data-checked:translate-x-[calc(100%)]",
	{
		variants: {
			size: {
				sm: "size-4",
				md: "size-5",
				lg: "size-6",
			},
		},
		defaultVariants: {
			size: "md",
		},
	},
);

export function Toggle(
	props: ComponentProps<typeof KSwitch> & { size?: "sm" | "md" | "lg" },
) {
	const [local, others] = splitProps(props, ["size"]);

	return (
		<KSwitch class="relative" {...others}>
			<KSwitch.Input class="peer absolute inset-0 opacity-0 cursor-pointer" />
			<KSwitch.Control class={toggleControlStyles({ size: local.size })}>
				<KSwitch.Thumb class={toggleThumbStyles({ size: local.size })} />
			</KSwitch.Control>
		</KSwitch>
	);
}
