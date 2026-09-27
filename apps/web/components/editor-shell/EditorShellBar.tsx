"use client";

import clsx from "clsx";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recorder.css";

export type EditorTab = "editor" | "record";

/**
 * The bar across the top of Cap's editor, on the blank Editor page and over
 * an open project alike: back to the dashboard, and Editor / Record tabs.
 */
export function EditorShellBar({
	tab,
	onTabChange,
	title,
	recordLabel = "Record",
	right,
	backHref = "/dashboard/caps",
	tabsDisabled = false,
}: {
	tab: EditorTab;
	onTabChange: (tab: EditorTab) => void;
	title?: ReactNode;
	recordLabel?: string;
	right?: ReactNode;
	backHref?: string;
	tabsDisabled?: boolean;
}) {
	return (
		<header className="cap-rec grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 bg-[var(--rec-window)] px-2 sm:px-3">
			<div className="flex min-w-0 items-center gap-2">
				<Link
					href={backHref}
					aria-label="Back to dashboard"
					className="rec-btn is-ghost is-icon"
				>
					<ArrowLeftIcon className="size-4" aria-hidden />
				</Link>
				<svg
					className="size-5 shrink-0"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 40 40"
					aria-hidden="true"
				>
					<path
						fill="#4785FF"
						d="M20 36c8.837 0 16-7.163 16-16S28.837 4 20 4 4 11.164 4 20s7.164 16 16 16"
					/>
					<path
						fill="#ADC9FF"
						d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13"
					/>
					<path
						fill="#fff"
						d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10"
					/>
				</svg>
				<span className="truncate text-[14px] font-medium text-[var(--rec-text-1)]">
					{title ?? "Editor"}
				</span>
			</div>
			<nav
				aria-label="Editor mode"
				className="flex rounded-lg bg-[var(--rec-ctl)] p-0.5"
			>
				{(
					[
						["editor", "Editor"],
						["record", recordLabel],
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						type="button"
						aria-pressed={tab === value}
						disabled={tabsDisabled && tab !== value}
						onClick={() => onTabChange(value)}
						className={clsx(
							"rec-focus flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
							tab === value
								? "bg-[var(--rec-card)] text-[var(--rec-text-1)] shadow-[0_1px_2px_rgba(0,0,0,0.1),0_0_0_1px_var(--rec-line)]"
								: "text-[var(--rec-text-2)] hover:text-[var(--rec-text-1)]",
						)}
					>
						{value === "record" && (
							<span className="size-2 rounded-full bg-[var(--rec-red)]" />
						)}
						{label}
					</button>
				))}
			</nav>
			<div className="flex min-w-0 items-center justify-end gap-1.5">
				{right}
			</div>
		</header>
	);
}
