"use client";

import clsx from "clsx";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recorder.css";

export type EditorTab = "editor" | "record";

/** The bar across the top of Cap's editor pages. */
export function EditorShellBar({
	left,
	center,
	right,
}: {
	left: ReactNode;
	center: ReactNode;
	right?: ReactNode;
}) {
	return (
		<header
			className="cap-rec grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 bg-[var(--rec-window)] px-2 sm:px-3"
			style={{ viewTransitionName: "cap-shell-bar" }}
		>
			<div className="flex min-w-0 items-center gap-2">{left}</div>
			<nav
				aria-label="Editor mode"
				className="flex min-w-0 items-center rounded-lg bg-[var(--rec-ctl)] p-0.5"
			>
				{center}
			</nav>
			<div className="flex min-w-0 items-center justify-end gap-1.5">
				{right}
			</div>
		</header>
	);
}

/** A back link led by the Cap mark. */
export function EditorShellBrand({
	title,
	backHref,
	onClick,
}: {
	title: ReactNode;
	backHref: string;
	onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
	return (
		<Link
			href={backHref}
			onClick={onClick}
			className="rec-focus group flex min-w-0 items-center gap-2 rounded-md py-1 pl-1 pr-2 text-[var(--rec-text-1)]"
		>
			<ArrowLeftIcon
				className="size-4 shrink-0 text-[var(--rec-text-2)] transition-transform group-hover:-translate-x-0.5"
				aria-hidden
			/>
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
			<span className="truncate text-[14px] font-medium">{title}</span>
		</Link>
	);
}

export const shellTabClass = (active: boolean) =>
	clsx(
		"flex h-7 items-center rounded-md text-[13px] font-medium transition-colors",
		active
			? "bg-[var(--rec-card)] text-[var(--rec-text-1)] shadow-[0_1px_2px_rgba(0,0,0,0.1),0_0_0_1px_var(--rec-line)]"
			: "text-[var(--rec-text-2)] hover:text-[var(--rec-text-1)]",
	);

/** One segment of the bar's centre toggle. */
export function EditorShellTab({
	active,
	disabled,
	onClick,
	children,
}: {
	active: boolean;
	disabled?: boolean;
	onClick?: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className={clsx(
				shellTabClass(active),
				"rec-focus gap-1.5 px-3 disabled:cursor-not-allowed disabled:opacity-50",
			)}
		>
			{children}
		</button>
	);
}

/** The Editor home's Editor / Record toggle. */
export function EditorTabs({
	tab,
	onTabChange,
}: {
	tab: EditorTab;
	onTabChange: (tab: EditorTab) => void;
}) {
	return (
		<>
			<EditorShellTab
				active={tab === "editor"}
				onClick={() => onTabChange("editor")}
			>
				Editor
			</EditorShellTab>
			<EditorShellTab
				active={tab === "record"}
				onClick={() => onTabChange("record")}
			>
				<span className="size-2 rounded-full bg-[var(--rec-red)]" />
				Record
			</EditorShellTab>
		</>
	);
}

/** The way to the dashboard and to a new recording, beside the toggle. */
export function EditorShellActions({
	onNavigate,
}: {
	onNavigate?: MouseEventHandler<HTMLAnchorElement>;
}) {
	return (
		<>
			<Link
				href="/dashboard/caps"
				onClick={onNavigate}
				className="rec-btn is-ghost"
			>
				Dashboard
			</Link>
			<Link
				href="/dashboard/editor?tab=record"
				onClick={onNavigate}
				className="rec-btn"
			>
				<span className="size-2 rounded-full bg-[var(--rec-red)]" />
				Record a video
			</Link>
		</>
	);
}
