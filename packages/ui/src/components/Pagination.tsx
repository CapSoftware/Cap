import { classNames } from "@cap/utils";
import { Slot } from "@radix-ui/react-slot";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import * as React from "react";
import { type ButtonProps, buttonVariants } from "./Button";

const Pagination = ({ className, ...props }: React.ComponentProps<"nav">) => (
	<nav
		aria-label="pagination"
		className={classNames("flex justify-center mx-auto w-full", className)}
		{...props}
	/>
);
Pagination.displayName = "Pagination";

const PaginationContent = React.forwardRef<
	HTMLUListElement,
	React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
	<ul
		ref={ref}
		className={classNames("flex flex-row gap-2 items-center", className)}
		{...props}
	/>
));
PaginationContent.displayName = "PaginationContent";

const PaginationItem = React.forwardRef<
	HTMLLIElement,
	React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
	<li ref={ref} className={classNames("", className)} {...props} />
));
PaginationItem.displayName = "PaginationItem";

type PaginationLinkProps = {
	isActive?: boolean;
	asChild?: boolean;
} & Pick<ButtonProps, "size"> &
	React.ComponentProps<"a">;

const PaginationLink = ({
	className,
	isActive,
	size = "md",
	asChild = false,
	...props
}: PaginationLinkProps) => {
	const Comp = asChild ? Slot : "a";
	return (
		<Comp
			aria-current={isActive ? "page" : undefined}
			className={classNames(
				buttonVariants({
					variant: isActive ? "dark" : "white",
					size,
				}),
				className,
			)}
			{...props}
		/>
	);
};
PaginationLink.displayName = "PaginationLink";

const PaginationPrevious = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof PaginationLink>) => {
	let content = children;
	if (props.asChild && React.isValidElement(children)) {
		const child = children as React.ReactElement<{ children?: React.ReactNode }>;
		if (!child.props.children) {
			content = React.cloneElement(child, {}, (
				<>
					<ChevronLeft className="size-4" />
					<p className="text-sm text-gray-12">Previous</p>
				</>
			));
		}
	} else if (!children) {
		content = (
			<>
				<ChevronLeft className="size-4" />
				<p className="text-sm text-gray-12">Previous</p>
			</>
		);
	}

	return (
		<PaginationLink
			aria-label="Go to previous page"
			size="md"
			className={classNames("gap-1 pl-2.5", className)}
			{...props}
		>
			{content}
		</PaginationLink>
	);
};
PaginationPrevious.displayName = "PaginationPrevious";

const PaginationNext = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof PaginationLink>) => {
	let content = children;
	if (props.asChild && React.isValidElement(children)) {
		const child = children as React.ReactElement<{ children?: React.ReactNode }>;
		if (!child.props.children) {
			content = React.cloneElement(child, {}, (
				<>
					<p className="text-sm text-gray-12">Next</p>
					<ChevronRight className="size-4" />
				</>
			));
		}
	} else if (!children) {
		content = (
			<>
				<p className="text-sm text-gray-12">Next</p>
				<ChevronRight className="size-4" />
			</>
		);
	}

	return (
		<PaginationLink
			aria-label="Go to next page"
			size="md"
			className={classNames("gap-1 pr-2.5", className)}
			{...props}
		>
			{content}
		</PaginationLink>
	);
};
PaginationNext.displayName = "PaginationNext";

const PaginationEllipsis = ({
	className,
	...props
}: React.ComponentProps<"span">) => (
	<span
		aria-hidden
		className={classNames(
			"flex justify-center items-center w-9 h-9",
			className,
		)}
		{...props}
	>
		<MoreHorizontal className="w-4 h-4" />
		<span className="sr-only">More pages</span>
	</span>
);
PaginationEllipsis.displayName = "PaginationEllipsis";

export {
	Pagination,
	PaginationContent,
	PaginationEllipsis,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
};
