import { type ComponentProps, splitProps } from "solid-js";

export function WindowControlButton(props: ComponentProps<"button">) {
	const [local, otherProps] = splitProps(props, ["class", "children"]);

	return (
		<button
			class={`inline-flex cursor-default items-center justify-center ${local.class}`}
			{...otherProps}
		>
			{local.children}
		</button>
	);
}
