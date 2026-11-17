"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import { faCheck } from "@fortawesome/free-solid-svg-icons/faCheck";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons/faChevronDown";
import { faMinus } from "@fortawesome/free-solid-svg-icons/faMinus";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { type ReactNode, useTransition } from "react";
import { toast } from "sonner";
import { setDashboardPageSize } from "@/actions/caps/page-size";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import type { PageSelectionState } from "@/lib/cap-selection";
import { DASHBOARD_PAGE_SIZES } from "@/lib/dashboard-page-size";

export const listControlClass =
	"flex items-center justify-center h-8 text-[13px] font-medium rounded-lg border transition-colors duration-200 text-gray-11 bg-gray-1 border-gray-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:bg-gray-2 hover:border-gray-5 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:opacity-60";

export function SelectAllCheckbox({
	state,
	onToggle,
	disabled,
}: {
	state: PageSelectionState;
	onToggle: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			aria-pressed={state === "all" ? true : state === "some" ? "mixed" : false}
			aria-label="Select all on this page"
			title="Select all on this page"
			disabled={disabled}
			onClick={onToggle}
			className={clsx(
				"flex justify-center items-center w-[22px] h-[22px] rounded-md border shadow-sm transition-[background-color,border-color,transform] duration-150 shrink-0 active:scale-90",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-2 disabled:opacity-50",
				state === "none"
					? "border-gray-5 bg-gray-1 hover:border-gray-7"
					: "bg-blue-9 border-blue-9",
			)}
		>
			<FontAwesomeIcon
				icon={state === "some" ? faMinus : faCheck}
				className={clsx(
					"text-white size-3 transition-[opacity,transform] duration-150 ease-out",
					state === "none" ? "opacity-0 scale-50" : "opacity-100 scale-100",
				)}
			/>
		</button>
	);
}

export function PageSizeSelect({ pageSize }: { pageSize: number }) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();

	const choose = (next: number) => {
		if (next === pageSize) return;
		startTransition(async () => {
			try {
				await setDashboardPageSize(next);
			} catch {
				toast.error("Couldn't save your page size. Please try again.");
				return;
			}
			const url = new URL(window.location.href);
			url.searchParams.delete("page");
			url.searchParams.delete("limit");
			router.replace(`${url.pathname}${url.search}`, {
				scroll: false,
			});
			router.refresh();
		});
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={`Caps per page: ${pageSize}`}
					disabled={isPending}
					className={clsx(listControlClass, "gap-2 px-3 tabular-nums")}
				>
					<span>{pageSize} per page</span>
					<FontAwesomeIcon
						icon={faChevronDown}
						className="size-2.5 text-gray-9"
					/>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-36">
				{DASHBOARD_PAGE_SIZES.map((size) => (
					<DropdownMenuItem
						key={size}
						onClick={() => choose(size)}
						className={clsx(
							"gap-2 rounded-lg tabular-nums",
							size === pageSize && "text-gray-12",
						)}
					>
						<span className="flex-1">{size} per page</span>
						{size === pageSize && (
							<FontAwesomeIcon icon={faCheck} className="size-3 text-gray-12" />
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function CapListHeader({
	title,
	count,
	selectionState,
	onToggleSelectAll,
	actions,
}: {
	title: string;
	count?: number;
	selectionState?: PageSelectionState;
	onToggleSelectAll?: () => void;
	actions?: ReactNode;
}) {
	return (
		<div className="flex flex-wrap gap-3 justify-between items-center mb-5 w-full">
			<div className="flex gap-2.5 items-center min-w-0">
				{selectionState && onToggleSelectAll && (
					<SelectAllCheckbox
						state={selectionState}
						onToggle={onToggleSelectAll}
					/>
				)}
				<h2 className="text-lg font-semibold tracking-tight truncate text-gray-12">
					{title}
				</h2>
				{typeof count === "number" && (
					<span className="text-sm tabular-nums text-gray-10">
						{count.toLocaleString("en-US")}
					</span>
				)}
			</div>
			{actions && <div className="flex gap-2 items-center">{actions}</div>}
		</div>
	);
}
