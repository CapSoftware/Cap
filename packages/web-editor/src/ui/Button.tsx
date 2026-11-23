import { cva, type VariantProps } from "cva";
import { type ComponentProps, splitProps } from "solid-js";

const styles = cva(
	"outline-offset-2 flex justify-center items-center gap-1.5 font-medium focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ed-accent rounded-[8px] transition-[background-color,color,box-shadow,filter,opacity] duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
	{
		defaultVariants: {
			variant: "primary",
			size: "md",
		},
		variants: {
			variant: {
				primary: "ed-primary",
				blue: "ed-primary",
				destructive:
					"bg-red-9 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] enabled:hover:bg-red-10",
				gray: "bg-ed-choice text-ed-text-1 shadow-ed-choice enabled:hover:bg-ed-ctl-hover",
				white:
					"bg-ed-choice text-ed-text-1 shadow-ed-choice enabled:hover:bg-ed-ctl-hover",
				outline:
					"text-ed-text-1 shadow-[inset_0_0_0_1px_var(--ed-line-strong)] enabled:hover:bg-ed-ctl-hover",
				ghost:
					"text-ed-text-2 enabled:hover:bg-ed-ctl-hover enabled:hover:text-ed-text-1",
			},
			size: {
				xs: "text-[12px] px-2 h-5",
				sm: "text-[12px] px-3 h-7",
				md: "text-[13px] px-3 h-8",
				lg: "text-[14px] px-4 h-9",
			},
		},
	},
);

export function Button(
	props: VariantProps<typeof styles> & ComponentProps<"button">,
) {
	const [local, otherProps] = splitProps(props, ["class", "size", "variant"]);

	return (
		<button
			type="button"
			{...otherProps}
			data-size={local.size ?? "md"}
			data-variant={local.variant ?? "primary"}
			class={styles({
				class: local.class,
				size: local.size,
				variant: local.variant,
			})}
		/>
	);
}
