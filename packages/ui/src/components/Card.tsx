import { classNames } from "@cap/utils";
import { forwardRef } from "react";

const Card = forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement> & { noStyle?: boolean }
>(({ className, noStyle, ...props }, ref) => (
	<div
		ref={ref}
		className={classNames(
			!noStyle &&
				"border p-5 bg-gray-1 rounded-2xl border-gray-3 text-card-foreground",
			className,
		)}
		{...props}
	/>
));
Card.displayName = "Card";

const CardHeader = forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={classNames("flex flex-col space-y-1.5", className)}
		{...props}
	/>
));
CardHeader.displayName = "CardHeader";

const CardTitle = forwardRef<
	HTMLParagraphElement,
	React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
	<h3
		ref={ref}
		className={classNames(
			"text-lg font-semibold tracking-tight leading-none text-gray-12",
			className,
		)}
		{...props}
	/>
));
CardTitle.displayName = "CardTitle";

const CardDescription = forwardRef<
	HTMLParagraphElement,
	React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
	<p
		ref={ref}
		className={classNames(
			"text-[0.875rem] text-gray-10 leading-[1.25rem]",
			className,
		)}
		{...props}
	/>
));
CardDescription.displayName = "CardDescription";

const CardFooter = forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={classNames("flex items-center p-6 pt-0", className)}
		{...props}
	/>
));
CardFooter.displayName = "CardFooter";

export { Card, CardDescription, CardFooter, CardHeader, CardTitle };
