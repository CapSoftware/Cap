"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { cva, cx } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import * as React from "react";

type SelectVariant = "default" | "dark" | "white" | "gray" | "transparent";

const SelectVariantContext = React.createContext<SelectVariant>("default");

const selectTriggerVariants = cva(
	cx(
		"font-medium flex px-4 py-2 transition-all duration-200 text-[13px] outline-0",
		"rounded-xl border-[1px] items-center justify-between gap-2 whitespace-nowrap",
		"disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-gray-3 disabled:text-gray-9",
		"ring-0 ring-gray-3 focus:ring-1 focus:ring-gray-12 focus:ring-offset-2 ring-offset-gray-4",
		"data-[placeholder]:text-gray-1 data-[size=default]:h-[44px] data-[size=sm]:h-[40px]",
		"*:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
		"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	),
	{
		defaultVariants: {
			variant: "default",
			size: "default",
		},
		variants: {
			variant: {
				default:
					"bg-gray-2 border-gray-5 text-gray-12 hover:bg-gray-3 hover:border-gray-6 focus:bg-gray-3 focus:border-gray-6",
				dark: "bg-gray-12 dark-button-border dark-button-shadow text-gray-1 border-gray-5 hover:bg-gray-11 hover:border-gray-6 focus:bg-gray-11 focus:border-gray-6",
				white:
					"bg-gray-1 text-gray-12 border-gray-5 hover:bg-gray-3 hover:border-gray-6 focus:bg-gray-3 focus:border-gray-6",
				gray: "bg-gray-5 text-gray-12 border-gray-5 hover:bg-gray-7 hover:border-gray-6 focus:bg-gray-7 focus:border-gray-6",
				transparent:
					"bg-transparent text-gray-12 border-transparent hover:bg-gray-3 hover:border-gray-6 focus:bg-gray-3 focus:border-gray-6",
			},
			size: {
				default: "w-full",
				fit: "w-fit",
			},
		},
	},
);

const selectContentVariants = cva(
	cx(
		"rounded-xl border-[1px] overflow-hidden",
		"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	),
	{
		defaultVariants: {
			variant: "default",
		},
		variants: {
			variant: {
				default: "bg-gray-2 border-gray-5 text-gray-12",
				dark: "hover:bg-gray-11/50 bg-gray-12 dark-button-border dark-button-shadow text-gray-1 border-gray-5",
				white: "bg-gray-1 text-gray-12 border-gray-5",
				gray: "bg-gray-5 text-gray-12 border-gray-5",
				transparent: "bg-transparent text-gray-12 border-transparent",
			},
		},
	},
);

const selectItemVariants = cva(
	cx(
		"relative flex w-full cursor-default items-center gap-2 py-2 pr-8 pl-3 text-[13px]",
		"rounded-lg outline-none select-none transition-colors duration-200",
		"data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[disabled]:text-gray-9",
		"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	),
	{
		defaultVariants: {
			variant: "default",
		},
		variants: {
			variant: {
				default: "text-gray-12 hover:bg-gray-3 focus:bg-gray-3",
				dark: "text-gray-1 hover:bg-[var(--gray-11-40)] focus:bg-[var(--gray-11-40)]",
				white: "text-gray-12 hover:bg-gray-3 focus:bg-gray-3",
				gray: "text-gray-12 hover:bg-gray-6 focus:bg-gray-6",
				transparent: "text-gray-12 hover:bg-gray-3 focus:bg-gray-3",
			},
		},
	},
);

function Select({
	className,
	variant = "default",
	size = "default",
	options,
	placeholder,
	onValueChange,
	value,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Root> & {
	className?: string;
	variant?: SelectVariant;
	options: {
		value: string;
		label: string;
		image?: React.ReactNode;
	}[];
	onValueChange: (value: string) => void;
	placeholder: string;
	size?: "default" | "fit";
}) {
	return (
		<SelectRoot
			onValueChange={onValueChange}
			value={value}
			data-slot="select"
			{...props}
		>
			<SelectTrigger variant={variant} size={size} className={className}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent className="mt-1" variant={variant}>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						<div className="flex gap-2 items-center">
							{option.image}
							{option.label}
						</div>
					</SelectItem>
				))}
			</SelectContent>
		</SelectRoot>
	);
}

function SelectRoot({
	...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
	return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({
	...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
	return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({
	...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
	return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
	className,
	size = "default",
	variant = "default",
	children,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
	size?: "default" | "fit";
	variant?: SelectVariant;
}) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			data-size={size}
			className={cx(selectTriggerVariants({ size, variant }), className)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon asChild>
				<ChevronDownIcon className="opacity-50 size-4" />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	position = "popper",
	variant = "default",
	...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
	variant?: SelectVariant;
}) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Content
				data-slot="select-content"
				className={cx(selectContentVariants({ variant }), className)}
				position={position}
				{...props}
			>
				<SelectScrollUpButton />
				<SelectPrimitive.Viewport
					className={cx(
						"p-1",
						position === "popper" &&
							"h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
					)}
				>
					<SelectVariantContext.Provider value={variant}>
						{children}
					</SelectVariantContext.Provider>
				</SelectPrimitive.Viewport>
				<SelectScrollDownButton />
			</SelectPrimitive.Content>
		</SelectPrimitive.Portal>
	);
}

function SelectLabel({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
	return (
		<SelectPrimitive.Label
			data-slot="select-label"
			className={cx("text-gray-10 px-3 py-1.5 text-xs", className)}
			{...props}
		/>
	);
}

function SelectItem({
	className,
	children,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
	const variant = React.useContext(SelectVariantContext);

	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cx(selectItemVariants({ variant }), className)}
			{...props}
		>
			<span className="absolute right-2 flex size-3.5 items-center justify-center">
				<SelectPrimitive.ItemIndicator>
					<CheckIcon className="size-4" />
				</SelectPrimitive.ItemIndicator>
			</span>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	);
}

function SelectSeparator({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
	return (
		<SelectPrimitive.Separator
			data-slot="select-separator"
			className={cx("-mx-1 my-1 h-px pointer-events-none bg-gray-5", className)}
			{...props}
		/>
	);
}

function SelectScrollUpButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
	return (
		<SelectPrimitive.ScrollUpButton
			data-slot="select-scroll-up-button"
			className={cx(
				"flex justify-center items-center py-1 cursor-default",
				className,
			)}
			{...props}
		>
			<ChevronUpIcon className="size-4" />
		</SelectPrimitive.ScrollUpButton>
	);
}

function SelectScrollDownButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
	return (
		<SelectPrimitive.ScrollDownButton
			data-slot="select-scroll-down-button"
			className={cx(
				"flex justify-center items-center py-1 cursor-default",
				className,
			)}
			{...props}
		>
			<ChevronDownIcon className="size-4" />
		</SelectPrimitive.ScrollDownButton>
	);
}

export {
	Select,
	SelectRoot,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectScrollDownButton,
	SelectScrollUpButton,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
};
