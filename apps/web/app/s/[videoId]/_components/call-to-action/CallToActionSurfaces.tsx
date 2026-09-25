"use client";

import clsx from "clsx";
import { ArrowUpRight, RotateCcw, X } from "lucide-react";
import { motion } from "motion/react";
import type { CSSProperties, MouseEvent } from "react";
import {
	callToActionDestinationLabel,
	readableTextColor,
	type ShareCallToAction,
} from "@/lib/share-call-to-action";

export type CallToActionScale = "compact" | "regular" | "large";

type ButtonProps = {
	cta: ShareCallToAction;
	scale: CallToActionScale;
	fullWidth?: boolean;
	interactive?: boolean;
	onOpen?: () => void;
};

export function CallToActionButton({
	cta,
	scale,
	fullWidth = false,
	interactive = true,
	onOpen,
}: ButtonProps) {
	const style = {
		"--cta-color": cta.color,
		color: readableTextColor(cta.color),
	} as CSSProperties;

	const className = clsx(
		"group/cta relative inline-flex max-w-full items-center justify-center gap-1.5 overflow-hidden rounded-full font-semibold tracking-[-0.01em]",
		"bg-[var(--cta-color)] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_10px_28px_-12px_var(--cta-color)] transition-[transform,filter] duration-200",
		interactive &&
			"hover:-translate-y-px hover:brightness-110 active:translate-y-0 active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/40",
		scale === "compact" && "h-9 px-4 text-[13px]",
		scale === "regular" && "h-10 px-5 text-sm",
		scale === "large" && "h-12 px-6 text-base",
		fullWidth && "w-full",
	);

	const content = (
		<>
			<span className="truncate">{cta.label}</span>
			<ArrowUpRight
				aria-hidden
				className={clsx(
					"shrink-0 transition-transform duration-200",
					interactive &&
						"group-hover/cta:-translate-y-px group-hover/cta:translate-x-px",
					scale === "large" ? "size-[18px]" : "size-4",
				)}
				strokeWidth={2.25}
			/>
		</>
	);

	if (!interactive) {
		return (
			<span className={className} style={style}>
				{content}
			</span>
		);
	}

	return (
		<a
			href={cta.url}
			target="_blank"
			rel="noopener noreferrer nofollow"
			className={className}
			style={style}
			onClick={(event: MouseEvent) => {
				event.stopPropagation();
				onOpen?.();
			}}
		>
			{content}
		</a>
	);
}

type EndScreenProps = {
	cta: ShareCallToAction;
	scale: CallToActionScale;
	interactive?: boolean;
	controlsInset?: boolean;
	onReplay?: () => void;
	onOpen?: () => void;
};

export function CallToActionEndScreen({
	cta,
	scale,
	interactive = true,
	controlsInset = false,
	onReplay,
	onOpen,
}: EndScreenProps) {
	const destination = callToActionDestinationLabel(cta.url);
	const compact = scale === "compact";
	const replayButton = onReplay && (
		<button
			type="button"
			aria-label={compact ? "Replay" : undefined}
			tabIndex={interactive ? undefined : -1}
			onClick={(event) => {
				event.stopPropagation();
				onReplay();
			}}
			className={clsx(
				"inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
				compact ? "size-9 bg-white/10" : "h-8 px-3 text-[13px]",
			)}
		>
			<RotateCcw aria-hidden className="size-3.5" strokeWidth={2.25} />
			{!compact && "Replay"}
		</button>
	);

	return (
		<motion.div
			data-slot="cta-end-screen"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.3, ease: "easeOut" }}
			className={clsx(
				"absolute inset-0 flex items-center justify-center overflow-hidden rounded-[inherit] bg-black/60 backdrop-blur-md",
				controlsInset &&
					(compact ? "pb-14" : scale === "regular" ? "pb-16" : "pb-20"),
			)}
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
		>
			<div
				aria-hidden
				className="pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-25 blur-3xl"
				style={{ background: cta.color }}
			/>
			<motion.div
				initial={{ opacity: 0, y: 10, scale: 0.98 }}
				animate={{ opacity: 1, y: 0, scale: 1 }}
				transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
				className={clsx(
					"relative flex max-w-[86%] flex-col items-center text-center",
					compact ? "gap-3" : scale === "regular" ? "gap-4" : "gap-5",
				)}
			>
				{cta.headline && (
					<p
						className={clsx(
							"text-balance font-semibold leading-tight tracking-[-0.02em] text-white",
							compact && "text-base",
							scale === "regular" && "text-xl",
							scale === "large" && "text-3xl",
						)}
					>
						{cta.headline}
					</p>
				)}
				{compact ? (
					<div className="flex max-w-full items-center gap-2">
						<CallToActionButton
							cta={cta}
							scale={scale}
							interactive={interactive}
							onOpen={onOpen}
						/>
						{replayButton}
					</div>
				) : (
					<>
						<div className="flex max-w-full flex-col items-center gap-2">
							<CallToActionButton
								cta={cta}
								scale={scale}
								interactive={interactive}
								onOpen={onOpen}
							/>
							<span className="max-w-full truncate text-xs font-medium text-white/55">
								{destination}
							</span>
						</div>
						{replayButton}
					</>
				)}
			</motion.div>
		</motion.div>
	);
}

type CornerCardProps = {
	cta: ShareCallToAction;
	interactive?: boolean;
	onDismiss?: () => void;
	onOpen?: () => void;
	className?: string;
	style?: CSSProperties;
};

export function CallToActionCornerCard({
	cta,
	interactive = true,
	onDismiss,
	onOpen,
	className,
	style,
}: CornerCardProps) {
	const dismissButton = (
		<button
			type="button"
			aria-label="Dismiss"
			tabIndex={interactive ? undefined : -1}
			onClick={(event) => {
				event.stopPropagation();
				onDismiss?.();
			}}
			className="flex size-6 shrink-0 items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
		>
			<X aria-hidden className="size-3.5" strokeWidth={2.5} />
		</button>
	);

	return (
		<motion.div
			data-slot="cta-corner-card"
			initial={{ opacity: 0, y: 12, scale: 0.97 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: 8, scale: 0.97 }}
			transition={{ type: "spring", stiffness: 420, damping: 34 }}
			className={clsx(
				"rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.78)] text-white shadow-[0_18px_40px_-16px_rgba(0,0,0,0.65)] backdrop-blur-xl",
				cta.headline ? "w-[264px] p-3" : "flex items-center gap-1 p-1.5",
				className,
			)}
			style={style}
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
		>
			{cta.headline ? (
				<div className="flex flex-col gap-3">
					<div className="flex items-start gap-2">
						<div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-0.5 pt-0.5">
							<p className="line-clamp-2 text-[13px] font-semibold leading-snug tracking-[-0.01em]">
								{cta.headline}
							</p>
							<p className="truncate text-[11px] font-medium text-white/50">
								{callToActionDestinationLabel(cta.url)}
							</p>
						</div>
						{dismissButton}
					</div>
					<CallToActionButton
						cta={cta}
						scale="compact"
						fullWidth
						interactive={interactive}
						onOpen={onOpen}
					/>
				</div>
			) : (
				<>
					<CallToActionButton
						cta={cta}
						scale="compact"
						interactive={interactive}
						onOpen={onOpen}
					/>
					{dismissButton}
				</>
			)}
		</motion.div>
	);
}
