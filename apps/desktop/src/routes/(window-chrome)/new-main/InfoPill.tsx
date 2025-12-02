import { cx } from "cva";
import type { ComponentProps } from "solid-js";

export default function InfoPill(
	props: ComponentProps<"button"> & { variant: "blue" | "red" },
) {
	return (
		<button
			{...props}
			type="button"
			class={cx(
				"px-2 py-0.5 rounded-full text-white text-[11px]",
				props.variant === "blue" ? "bg-blue-9" : "bg-red-9",
			)}
		/>
	);
}

export function InfoPillNew(
	props: ComponentProps<"button"> & { variant: "on" | "off" },
) {
	return (
		<button
			{...props}
			type="button"
			class={cx(
				"px-2 h-6 rounded-[6px] text-[11px] font-medium",
				props.variant === "on"
					? "bg-blue-9 text-white "
					: "bg-white/10 text-white/40",
			)}
		/>
	);
}
