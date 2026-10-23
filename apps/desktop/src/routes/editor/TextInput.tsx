import { cx } from "cva";
import type { ComponentProps } from "solid-js";
import { composeEventHandlers } from "~/utils/composeEventHandlers";

export function TextInput(props: ComponentProps<"input">) {
	return (
		<input
			{...props}
			class={cx(
				"rounded-[7px] border-0 bg-ed-ctl text-ed-text-1 caret-ed-accent outline-hidden transition-colors duration-150 placeholder:text-ed-text-3 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent",
				props.class,
			)}
			onKeyDown={composeEventHandlers<HTMLInputElement, KeyboardEvent>([
				props.onKeyDown,
				(e) => {
					e.stopPropagation();
				},
			])}
		/>
	);
}
