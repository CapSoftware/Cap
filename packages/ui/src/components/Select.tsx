"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { cva, cx } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import * as React from "react";

type SelectVariant = "default" | "light" | "dark" | "gray" | "transparent"
type Size = "default" | "fit" | "sm" | "md" | "lg"

const SelectVariantContext = React.createContext<SelectVariant>("default");

const selectTriggerVariants = cva(
	cx(
		"font-medium flex transition-all duration-200 text-[13px] outline-0",
		"border-[1px] items-center justify-between gap-2 whitespace-nowrap",
		"disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-gray-3 disabled:text-gray-9",
		"ring-0 ring-gray-6 ring-offset-gray-6 data-[state=open]:border-gray-7 data-[state=open]:ring-gray-7 data-[state=open]:ring-1 data-[state=open]:ring-offset-0",
		"data-[placeholder]:text-gray-12",
		"*:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
		"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:transition-transform [&_svg]:duration-200",
		"[&[data-state=open]_svg.caret-icon]:rotate-180",
	),
	{
		defaultVariants: {
			variant: "default",
			size: "default",
		},
		variants: {
			variant: {
				default:
					"bg-gray-2 border-gray-5 text-gray-12 hover:bg-gray-3 hover:border-gray-6",
				dark: "bg-gray-12 transition-all duration-200 data-[state=open]:ring-offset-2 data-[state=open]:ring-gray-10 ring-transparent ring-offset-gray-3 text-gray-1 border-gray-5 hover:bg-gray-11 hover:border-gray-6",
				light: "bg-gray-1 transition-all duration-200 data-[state=open]:ring-offset-2 data-[state=open]:ring-gray-10 ring-transparent ring-offset-gray-3 text-gray-12 border-gray-5 hover:bg-gray-3 hover:border-gray-6",
				gray: "bg-gray-5 text-gray-12 border-gray-5 hover:bg-gray-7 hover:border-gray-6",
				transparent:
					"bg-transparent text-gray-12 border-transparent hover:bg-gray-3 hover:border-gray-6",
			},
			size: {
				default: "w-full h-[44px] px-4 rounded-xl",
				fit: "w-fit h-[32px] px-3 rounded-[10px]",
				sm: "w-fit h-[32px] px-3 rounded-[10px]",
				md: "w-fit h-[40px] px-3 rounded-xl",
				lg: "w-fit h-[48px] px-4 rounded-xl",
			},
		},
	},
);

const selectContentVariants = cva(
	cx(
		"rounded-xl border-[1px] overflow-hidden",
		"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		"data-[state=open]:animate-in data-[state=closed]:animate-out",
		"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
		"data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
		"data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
		"data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
	),
	{
		defaultVariants: {
			variant: "default",
		},
		variants: {
			variant: {
				default: "bg-gray-2 border-gray-5 text-gray-12",
				dark: "hover:bg-gray-11-50 bg-gray-12 dark-button-border dark-button-shadow text-gray-1 border-gray-5",
				light: "bg-gray-1 transition-all duration-200 data-[state=open]:ring-offset-2 data-[state=open]:ring-gray-10 ring-transparent ring-offset-gray-3 text-gray-12 border-gray-5",
				gray: "bg-gray-5 text-gray-12 border-gray-5",
				transparent:
					"bg-transparent hover:bg-gray-3 text-gray-12 border-transparent",
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
				dark: "text-gray-1 hover:text-gray-12 focus:text-gray-12 hover:bg-gray-1 focus:bg-gray-1",
				light: "text-gray-12 hover:text-gray-12 hover:bg-gray-3 focus:bg-gray-3",
				gray: "text-gray-12 hover:text-gray-12 hover:bg-gray-6 focus:bg-gray-6",
				transparent:
					"text-gray-12 hover:text-gray-12 hover:bg-gray-3 focus:bg-gray-3",
			},
		},
	},
);

function Select({
	className,
	variant = "default",
	size = "default",
	options,
	icon,
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
		icon?: React.ReactNode;
		image?: React.ReactNode;
	}[];
	onValueChange: (value: string) => void;
	placeholder: string;
	size?: Size;
	icon?: React.ReactNode;
}) {
	return (
		<SelectRoot
			onValueChange={onValueChange}
			value={value}
			data-slot="select"
			{...props}
		>
			<SelectTrigger variant={variant} size={size} className={className} icon={icon}>
				<SelectValue className="text-sm" placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent variant={variant}>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value} icon={option.icon}>
						<div className="flex gap-2 items-center">
							{option.image && option.image}
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
	icon,
	size = "default",
	variant = "default",
	children,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
	size?: Size;
	variant?: SelectVariant;
	icon?: React.ReactNode;
}) {
		const iconSizeVariant = {
		default: "size-2.5",
		fit: "size-2",
		sm: "size-2",
		md: "size-3",
		lg: "size-3",
	}
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			data-size={size}
			className={cx(selectTriggerVariants({ size, variant }), className)}
			{...props}
		>
			{icon && React.cloneElement(icon as React.ReactElement<{ className: string }>, { className: cx(iconSizeVariant[size], "text-gray-9") })}
			{children}
			<SelectPrimitive.Icon asChild>
				<ChevronDownIcon className="opacity-50 size-4 caret-icon" />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	position = "popper",
	variant = "default",
	sideOffset = 4,
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
				sideOffset={sideOffset}
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
			className={cx("text-gray-10 px-3 py-1.5 text-sm", className)}
			{...props}
		/>
	);
}

function SelectItem({
	className,
	children,
	icon,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
	icon?: React.ReactNode;
}) {
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
			<div className="flex justify-between items-center w-full">
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
			{icon && React.cloneElement(icon as React.ReactElement<{ className: string }>, { className: cx("size-3", "text-gray-9") })}
			</div>
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
