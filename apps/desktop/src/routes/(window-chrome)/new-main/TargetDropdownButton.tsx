import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { Polymorphic } from "@kobalte/core/polymorphic";
import { cx } from "cva";
import { splitProps, type ValidComponent } from "solid-js";
import IconCapChevronDown from "~icons/cap/chevron-down";

type TargetDropdownButtonProps<T extends ValidComponent> = PolymorphicProps<
	T,
	{
		expanded?: boolean;
	}
>;

export default function TargetDropdownButton<
	T extends ValidComponent = "button",
>(props: TargetDropdownButtonProps<T>) {
	const [local, rest] = splitProps(props, ["class", "expanded", "disabled"]);

	return (
		<Polymorphic
			as="button"
			type="button"
			{...rest}
			disabled={local.disabled}
			aria-expanded={local.expanded ? "true" : "false"}
			data-expanded={local.expanded ? "true" : "false"}
			class={cx(
				"flex h-[3.75rem] w-5 shrink-0 items-center justify-center rounded-lg bg-gray-4 text-gray-12 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1 hover:bg-gray-5",
				local.expanded && "bg-gray-5",
				local.disabled && "pointer-events-none opacity-60",
				local.class,
			)}
		>
			<IconCapChevronDown
				class={cx(
					"size-4 text-gray-11 transition-transform duration-150",
					local.expanded && "rotate-180 text-gray-12",
				)}
			/>
		</Polymorphic>
	);
}
