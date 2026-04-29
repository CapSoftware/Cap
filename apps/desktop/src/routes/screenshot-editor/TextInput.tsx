import type { ComponentProps } from "solid-js";
import { composeEventHandlers } from "~/utils/composeEventHandlers";

export function TextInput(props: ComponentProps<"input">) {
	return (
		<input
			{...props}
			onKeyDown={composeEventHandlers<HTMLInputElement, KeyboardEvent>([
				props.onKeyDown,
				(e) => {
					e.stopPropagation();
				},
			])}
		/>
	);
}
