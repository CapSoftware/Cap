import { classNames } from "@cap/utils";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import * as React from "react";
import { type ButtonProps, buttonVariants } from "./Button";

const Pagination = ({ className, ...props }: React.ComponentProps<"nav">) => (
	<nav
		aria-label="分页导航"
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
} & Pick<ButtonProps, "size"> &
	React.ComponentProps<"a">;

const PaginationLink = ({
	className,
	isActive,
	size = "md",
	...props
}: PaginationLinkProps) => (
	<a
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
PaginationLink.displayName = "PaginationLink";

const PaginationPrevious = ({
	className,
	...props
}: React.ComponentProps<typeof PaginationLink>) => (
	<PaginationLink
		aria-label="转到上一页"
		size="md"
		className={classNames("gap-1 pl-2.5", className)}
		{...props}
	>
		<ChevronLeft className="size-4" />
		<p className="text-sm text-gray-12">上一页</p>
	</PaginationLink>
);
PaginationPrevious.displayName = "PaginationPrevious";

const PaginationNext = ({
	className,
	...props
}: React.ComponentProps<typeof PaginationLink>) => (
	<PaginationLink
		aria-label="转到下一页"
		size="md"
		className={classNames("gap-1 pr-2.5", className)}
		{...props}
	>
		<p className="text-sm text-gray-12">下一页</p>
		<ChevronRight className="size-4" />
	</PaginationLink>
);
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
		<span className="sr-only">更多页面</span>
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
