import { cva, type VariantProps } from "cva";
import type { ComponentProps } from "solid-js";

const styles = cva(
	"outline-offset-2 outline-2 flex justify-center items-center focus-visible:outline rounded-full transition-all will-change-transform duration-200",
	{
		defaultVariants: {
			variant: "primary",
			size: "md",
		},
		variants: {
			variant: {
				primary:
					"bg-gray-12 dark-button-shadow text-gray-1 disabled:bg-gray-6 disabled:text-gray-9",
				blue: "bg-blue-600 text-white border border-blue-800 shadow-[0_1.50px_0_0_rgba(255,255,255,0.20)_inset] hover:bg-blue-700  disabled:bg-gray-6 disabled:text-gray-9",
				destructive:
					"bg-red-500 text-white hover:bg-red-600 disabled:bg-red-200",
				outline:
					"border border-gray-4 hover:border-gray-12 hover:bg-gray-12 hover:text-gray-1 text-gray-12 disabled:bg-gray-8",
				white:
					"bg-gray-1 border border-gray-6 text-gray-12 hover:bg-gray-3 disabled:bg-gray-8",
				ghost: "hover:bg-white/20 hover:text-white",
				gray: "bg-gray-5 data-[selected=true]:bg-gray-8! dark:data-[selected=true]:bg-gray-9! hover:bg-gray-7 gray-button-shadow text-gray-12 disabled:bg-gray-8 disabled:text-gray-9 outline-none",
				dark: "bg-gray-12 dark-button-border dark-button-shadow hover:bg-gray-11 border text-gray-1 disabled:cursor-not-allowed disabled:text-gray-10 disabled:bg-gray-7 disabled:border-gray-8",
				darkgradient:
					"bg-linear-to-t button-gradient-border from-[#0f0f0f] to-[#404040] shadow-[0_0_0_1px] hover:brightness-110 shadow-[#383838] text-gray-50 hover:bg-[#383838] disabled:bg-[#383838] border-transparent",
				radialblue:
					"text-gray-50 border button-gradient-border shadow-[0_0_0_1px] shadow-blue-400 disabled:bg-gray-1 border-0 [background:radial-gradient(90%_100%_at_15%_12%,#9BC4FF_0%,#3588FF_100%)] border-transparent hover:opacity-80",
			},
			size: {
				xs: "text-[0.75rem] px-2 h-5",
				sm: "text-xs px-3 h-7",
				md: "text-[13px] px-3 py-2",
				lg: "text-[0.875rem] px-4 h-9",
			},
		},
	},
);

export function Button(
	props: VariantProps<typeof styles> & ComponentProps<"button">,
) {
	return (
		<button
			type="button"
			{...props}
			class={styles({ ...props, class: props.class })}
		/>
	);
}
