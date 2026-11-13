import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export const MONO =
	"[font-family:var(--font-infra-mono),ui-monospace,SFMono-Regular,monospace]";

export const TEXT = "text-[#E8ECF4]";
export const MUTED = "text-[rgba(232,236,244,0.62)]";
export const FAINT = "text-[rgba(232,236,244,0.44)]";
export const RULE = "border-[rgba(222,230,246,0.08)]";

export const BG = "#0A0B0D";
export const SURFACE =
	"bg-[linear-gradient(180deg,rgba(222,230,246,0.045),rgba(222,230,246,0.022))] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.085),inset_0_1px_0_rgba(255,255,255,0.04)]";
export const PANEL = clsx("rounded-[14px]", SURFACE);
export const LIT =
	"bg-white shadow-[0_0_8px_1px_rgba(214,228,255,0.7),0_0_28px_4px_rgba(190,210,255,0.28)]";

export const FOCUS =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.8)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0B0D]";

export const FOCUS_INSET =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgba(232,236,244,0.8)]";

export const TEXT_LINK =
	"underline decoration-[rgba(232,236,244,0.28)] underline-offset-[4px] transition-colors duration-200 hover:text-[#E8ECF4] hover:decoration-[#E8ECF4]";

type ButtonVariant = "primary" | "ghost" | "danger" | "quiet";
type ButtonSize = "md" | "sm";

const BUTTON_BASE =
	"inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[8px] font-medium transition-[background-color,box-shadow,color,opacity] duration-200 disabled:pointer-events-none disabled:opacity-40";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
	primary:
		"bg-[#E8ECF4] text-[#050506] shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_1px_2px_rgba(0,0,0,0.4)] hover:bg-white hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_0_18px_rgba(214,228,255,0.18)]",
	ghost:
		"font-normal text-[#E8ECF4] bg-[rgba(222,230,246,0.035)] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.14)] hover:bg-[rgba(222,230,246,0.07)] hover:shadow-[inset_0_0_0_1px_rgba(222,230,246,0.26)]",
	danger:
		"font-normal text-[#F2A199] shadow-[inset_0_0_0_1px_rgba(242,161,153,0.28)] hover:bg-[rgba(242,161,153,0.08)] hover:shadow-[inset_0_0_0_1px_rgba(242,161,153,0.5)]",
	quiet:
		"font-normal text-[rgba(232,236,244,0.58)] hover:bg-[rgba(222,230,246,0.05)] hover:text-[#E8ECF4]",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
	md: "h-9 px-4 text-[14px]",
	sm: "h-8 px-3 text-[13px]",
};

export const buttonClass = (
	variant: ButtonVariant = "primary",
	size: ButtonSize = "md",
	className?: string,
) =>
	clsx(
		BUTTON_BASE,
		BUTTON_VARIANT[variant],
		BUTTON_SIZE[size],
		FOCUS,
		className,
	);

export function Button({
	variant = "primary",
	size = "md",
	loading = false,
	className,
	children,
	disabled,
	type = "button",
	...props
}: ComponentProps<"button"> & {
	variant?: ButtonVariant;
	size?: ButtonSize;
	loading?: boolean;
}) {
	return (
		<button
			type={type}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			className={buttonClass(variant, size, className)}
			{...props}
		>
			{loading && (
				<span
					aria-hidden="true"
					className="size-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
				/>
			)}
			{children}
		</button>
	);
}

export function ButtonLink({
	variant = "primary",
	size = "md",
	className,
	...props
}: ComponentProps<typeof Link> & {
	variant?: ButtonVariant;
	size?: ButtonSize;
}) {
	return <Link className={buttonClass(variant, size, className)} {...props} />;
}

export const inputClass = (className?: string) =>
	clsx(
		"h-9 w-full min-w-0 rounded-[8px] border-0 bg-[rgba(5,6,8,0.5)] px-3 text-[14px] text-[#E8ECF4] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)] outline-none transition-shadow duration-200 placeholder:text-[rgba(232,236,244,0.32)] hover:shadow-[inset_0_0_0_1px_rgba(222,230,246,0.22)] focus:shadow-[inset_0_0_0_1px_rgba(232,236,244,0.7)] focus:ring-0",
		className,
	);

export function Input({ className, ...props }: ComponentProps<"input">) {
	return <input className={inputClass(className)} {...props} />;
}

export function PageHeader({
	title,
	description,
	action,
}: {
	title: string;
	description?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
			<div className="min-w-0">
				<h1 className="m-0 text-[28px] font-medium leading-[1.12] tracking-[-0.032em] text-[#E8ECF4]">
					{title}
				</h1>
				{description && (
					<p
						className={clsx(
							MUTED,
							"m-0 mt-2 max-w-[520px] text-pretty text-[14.5px] leading-[1.55]",
						)}
					>
						{description}
					</p>
				)}
			</div>
			{action}
		</header>
	);
}

export function Block({
	title,
	description,
	action,
	children,
	className,
}: {
	title: string;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={clsx("min-w-0", className)}>
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-4">
				<div className="min-w-0">
					<h2 className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
						{title}
					</h2>
					{description && (
						<p
							className={clsx(
								MUTED,
								"m-0 mt-1 max-w-[560px] text-pretty text-[13.5px] leading-[1.55]",
							)}
						>
							{description}
						</p>
					)}
				</div>
				{action}
			</div>
			<div className={clsx(PANEL, CARD_ROWS, "px-5 py-1")}>{children}</div>
		</section>
	);
}

export const CARD_ROWS =
	"min-w-0 [&>:last-child]:border-b-0 [&_li:last-child]:border-b-0 [&_tbody>tr:last-child]:border-b-0";

export function Panel({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={clsx(PANEL, CARD_ROWS, "px-5 py-1", className)}>
			{children}
		</div>
	);
}

export function Split({
	title,
	description,
	children,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			className={clsx(
				"grid gap-x-16 gap-y-5 p-6 sm:p-8 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] [section+&]:mt-3",
				PANEL,
			)}
		>
			<div className="min-w-0">
				<h2 className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
					{title}
				</h2>
				{description && (
					<p
						className={clsx(
							MUTED,
							"m-0 mt-1.5 text-pretty text-[13.5px] leading-[1.55]",
						)}
					>
						{description}
					</p>
				)}
			</div>
			<div className="min-w-0 [&>:last-child]:border-b-0">{children}</div>
		</section>
	);
}

export function Disclosure({
	summary,
	note,
	open = false,
	children,
}: {
	summary: string;
	note?: string;
	open?: boolean;
	children: ReactNode;
}) {
	return (
		<details open={open} className={clsx("group min-w-0 px-5 py-4", PANEL)}>
			<summary
				className={clsx(
					"flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[6px] text-[14px] text-[#E8ECF4] [&::-webkit-details-marker]:hidden",
					FOCUS,
				)}
			>
				<span className="inline-flex items-center gap-1.5">
					<ChevronRight
						size={14}
						aria-hidden="true"
						className="shrink-0 self-center text-[rgba(232,236,244,0.5)] transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
					/>
					{summary}
				</span>
				{note && (
					<span className="text-[13px] text-[rgba(232,236,244,0.46)]">
						{note}
					</span>
				)}
			</summary>
			<div className="min-w-0 pb-2 pt-6">{children}</div>
		</details>
	);
}

export function Figures({ children }: { children: ReactNode }) {
	return (
		<dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
			{children}
		</dl>
	);
}

export function Figure({
	label,
	value,
	hint,
	lead = false,
}: {
	label: string;
	value: ReactNode;
	hint?: ReactNode;
	lead?: boolean;
}) {
	return (
		<div
			className={clsx(
				"relative flex min-w-0 flex-col-reverse justify-end gap-2.5 overflow-hidden px-4 py-4 sm:px-5 sm:py-5",
				PANEL,
			)}
		>
			{lead && (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 top-0 h-full bg-[radial-gradient(120%_90%_at_0%_0%,rgba(214,228,255,0.09),transparent_60%)]"
				/>
			)}
			<dt className="relative min-w-0 text-[13px] leading-[1.35] text-[rgba(232,236,244,0.56)]">
				{label}
				{hint && (
					<span className="block text-[12px] text-[rgba(232,236,244,0.34)]">
						{hint}
					</span>
				)}
			</dt>
			<dd
				className={clsx(
					MONO,
					"relative m-0 text-[19px] leading-[1.1] tracking-[-0.04em] tabular-nums [overflow-wrap:anywhere]",
					"sm:text-[22px] xl:text-[26px]",
					lead ? "text-white" : "text-[rgba(232,236,244,0.82)]",
				)}
			>
				{value}
			</dd>
		</div>
	);
}

export function EnvTag({
	environment,
	className,
}: {
	environment: "development" | "production";
	className?: string;
}) {
	const live = environment === "production";
	return (
		<span
			className={clsx(
				"inline-flex h-[20px] w-fit items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11.5px] leading-none",
				live
					? "bg-[rgba(214,228,255,0.08)] text-[#E8ECF4] shadow-[inset_0_0_0_1px_rgba(214,228,255,0.16)]"
					: "bg-[rgba(222,230,246,0.05)] text-[rgba(232,236,244,0.6)] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.08)]",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={clsx(
					"size-[5px] rounded-full",
					live
						? "bg-white shadow-[0_0_6px_1px_rgba(214,228,255,0.8)]"
						: "bg-[rgba(232,236,244,0.4)]",
				)}
			/>
			{live ? "Production" : "Development"}
		</span>
	);
}

export const TH =
	"whitespace-nowrap py-3 pr-6 text-left text-[12.5px] font-normal text-[rgba(232,236,244,0.48)] last:pr-0";
export const TD =
	"whitespace-nowrap py-3 pr-6 text-[13.5px] text-[rgba(232,236,244,0.78)] last:pr-0";
export const TR = "border-b border-[rgba(222,230,246,0.07)]";

export function Empty({ children }: { children: ReactNode }) {
	return (
		<p className={clsx(MUTED, "m-0 py-10 text-[14px] leading-[1.55]")}>
			{children}
		</p>
	);
}
