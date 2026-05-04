import { cx } from "cva";
import type { ComponentProps } from "solid-js";

export type InfoPillVariant = "blue" | "red" | "gray";

export default function InfoPill(
	props: ComponentProps<"button"> & { variant: InfoPillVariant },
) {
	return (
		<button
			{...props}
			type="button"
			class={cx(
				"inline-flex items-center justify-center min-w-[40px] h-[24px] px-2.5 rounded-full text-[11px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-1",
				props.variant === "blue" && "bg-blue-9 text-white hover:bg-blue-10",
				props.variant === "red" && "bg-red-9 text-white hover:bg-red-10",
				props.variant === "gray" &&
					"bg-gray-5 text-gray-11 hover:bg-gray-6 hover:text-gray-12",
			)}
		/>
	);
}
