import clsx from "clsx";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

export const StepPage = ({
	children,
	width = "wide",
	className,
}: {
	children: ReactNode;
	width?: "narrow" | "wide";
	className?: string;
}) => (
	<div
		className={clsx(
			"mx-auto flex w-full flex-1 flex-col px-5 pb-24 pt-8 sm:px-8 sm:pb-16 sm:pt-12 lg:pt-14",
			width === "narrow" ? "max-w-[640px]" : "max-w-[1120px]",
			className,
		)}
	>
		{children}
	</div>
);

export const BackLink = ({
	href = "/onboarding/start",
	children = "Other ways to start",
}: {
	href?: string;
	children?: ReactNode;
}) => (
	<Link
		href={href}
		className="ob-link ob-rise mb-6 self-start !text-[13.5px] !no-underline hover:!underline sm:mb-8"
	>
		<ArrowLeft className="size-3.5" aria-hidden />
		{children}
	</Link>
);

export const StepTitle = ({
	children,
	className,
	delay = 0,
}: {
	children: ReactNode;
	className?: string;
	delay?: number;
}) => (
	<h1
		className={clsx(
			"ob-rise text-balance text-[32px] font-medium leading-[1.08] tracking-[-0.03em] text-[var(--ob-ink)] sm:text-[42px]",
			className,
		)}
		style={{ "--d": `${delay}s` } as CSSProperties}
	>
		{children}
	</h1>
);

export const StepLede = ({
	children,
	className,
	delay = 0.06,
}: {
	children: ReactNode;
	className?: string;
	delay?: number;
}) => (
	<p
		className={clsx(
			"ob-rise mt-3 max-w-[560px] text-pretty text-[16px] leading-relaxed text-[var(--ob-ink-soft)] sm:text-[17px]",
			className,
		)}
		style={{ "--d": `${delay}s` } as CSSProperties}
	>
		{children}
	</p>
);

export const ProNote = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => (
	<div
		className={clsx(
			"flex items-start gap-3 rounded-2xl border-[1.5px] border-dashed border-[var(--ob-track-strong)] bg-[var(--ob-surface-soft)] px-4 py-3.5 text-[14px] leading-relaxed text-[var(--ob-ink-2)]",
			className,
		)}
	>
		<span className="relative mt-0.5 flex h-[22px] shrink-0 items-center px-2 text-[12px] font-medium text-[var(--ob-accent)]">
			<svg
				viewBox="0 0 44 22"
				preserveAspectRatio="none"
				className="ob-boil absolute inset-0 size-full overflow-visible"
				aria-hidden="true"
			>
				<path
					className="ob-ink is-accent"
					style={{ strokeWidth: 1.6 }}
					d="M 11 1.6 C 22 0.8 33 1 40 3 C 43.6 5.6 43.4 16.4 40 19 C 31 21.4 14 21.2 5 19.4 C 0.8 16.8 0.6 6 4 3.2 C 6 2 8.6 1.6 12 1.4"
				/>
			</svg>
			Pro
		</span>
		<div className="min-w-0">{children}</div>
	</div>
);
