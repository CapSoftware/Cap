import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { classNames } from "./class-names";

const buttonVariants = cva(
	"flex items-center justify-center transition-colors duration-200 rounded-full disabled:cursor-not-allowed cursor-pointer font-medium px-5 ring-offset-transparent relative gap-1",
	{
		defaultVariants: {
			variant: "primary",
			size: "md",
		},
		variants: {
			variant: {
				primary:
					"bg-gray-12 dark-button-shadow text-gray-1 disabled:bg-gray-6 disabled:text-gray-9",
				blue: "bg-blue-600 text-white disabled:border-gray-8 border border-blue-800 shadow-[0_1.50px_0_0_rgba(255,255,255,0.20)_inset] hover:bg-blue-700  disabled:bg-gray-7 disabled:text-gray-10",
				destructive:
					"bg-red-500 text-white border-transparent hover:bg-red-600 disabled:bg-gray-7 disabled:border-gray-8 border disabled:text-gray-10",
				outline:
					"border border-gray-4 hover:border-gray-5 hover:bg-gray-3 text-gray-12 disabled:bg-gray-8",
				white:
					"bg-gray-3 border border-gray-5 hover:border-gray-6 text-gray-12 hover:bg-gray-6 disabled:bg-gray-8",
				gray: "bg-gray-5 hover:bg-gray-7 border gray-button-border gray-button-shadow text-gray-12 disabled:border-gray-7 disabled:bg-gray-8 disabled:text-gray-11",
				dark: "bg-gray-12 dark-button-shadow hover:bg-gray-11 border dark-button-border text-gray-1 disabled:cursor-not-allowed disabled:text-gray-10 disabled:bg-gray-7 disabled:border-gray-8",
			},
			size: {
				xs: "text-xs h-[32px]",
				sm: "text-sm h-[40px]",
				md: "text-sm h-[44px]",
				lg: "text-md h-[48px]",
				icon: "h-9 w-9",
			},
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	href?: string;
	target?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, href, target, ...props }, ref) => {
		if (href) {
			return (
				<a
					className={classNames(buttonVariants({ variant, size, className }))}
					href={href}
					target={target}
				>
					{props.children}
				</a>
			);
		}
		return (
			<button
				className={classNames(buttonVariants({ variant, size, className }))}
				ref={ref}
				{...props}
			/>
		);
	},
);
Button.displayName = "Button";

export { Button, buttonVariants };
