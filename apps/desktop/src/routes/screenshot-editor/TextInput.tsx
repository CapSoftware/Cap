import type { ComponentProps } from "solid-js";
import { composeEventHandlers } from "~/utils/composeEventHandlers";

// It's important to use this instead of plain text inputs as we use global key listeners
// for keybinds
export function TextInput(props: ComponentProps<"input">) {
	return (
		<input
			{...props}
			onKeyDown={composeEventHandlers<HTMLInputElement>([
				props.onKeyDown,
				(e) => {
					e.stopPropagation();
				},
			])}
		/>
	);
}
