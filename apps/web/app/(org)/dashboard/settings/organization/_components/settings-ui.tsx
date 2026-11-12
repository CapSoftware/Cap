import clsx from "clsx";
import type { ReactNode } from "react";
import { doodleHost } from "./doodles";

export function SettingsSection({
	anchor,
	title,
	action,
	children,
	className,
}: {
	anchor?: string;
	title: string;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section id={anchor} className={clsx("scroll-mt-24", className)}>
			<div className="flex gap-4 justify-between items-center mb-3 min-h-8">
				<h2 className="text-sm font-medium text-gray-12">{title}</h2>
				{action}
			</div>
			{children}
		</section>
	);
}

export function SettingsCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={clsx(
				"rounded-xl border divide-y shadow-xs border-gray-3 divide-gray-3 bg-gray-1",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function SettingsRow({
	anchor,
	icon,
	title,
	description,
	meta,
	control,
	children,
	className,
}: {
	anchor?: string;
	icon?: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	meta?: ReactNode;
	control?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div
			id={anchor}
			className={clsx("px-4 py-4 scroll-mt-24 sm:px-5", doodleHost, className)}
		>
			<div className="flex flex-wrap gap-x-4 gap-y-3 justify-between items-center">
				<div className="flex flex-1 gap-3.5 items-center min-w-0 basis-64">
					{icon && (
						<div className="flex justify-center items-center rounded-xl size-11 shrink-0 bg-gray-2">
							{icon}
						</div>
					)}
					<div className="flex flex-col gap-0.5 min-w-0">
						<div className="flex flex-wrap gap-x-2 gap-y-1 items-center text-sm font-medium text-gray-12">
							{title}
							{meta}
						</div>
						{description && (
							<p className="text-[13px] leading-5 text-gray-10 text-pretty">
								{description}
							</p>
						)}
					</div>
				</div>
				{control && (
					<div className="flex flex-wrap gap-2 items-center">{control}</div>
				)}
			</div>
			{children}
		</div>
	);
}

const chipTones = {
	neutral: "bg-gray-3 text-gray-11",
	positive: "bg-green-100 text-green-800",
	warning: "bg-amber-100 text-amber-800",
	danger: "bg-red-100 text-red-700",
};

export function StatusChip({
	tone = "neutral",
	children,
}: {
	tone?: keyof typeof chipTones;
	children: ReactNode;
}) {
	return (
		<span
			className={clsx(
				"inline-flex items-center px-2 py-0.5 text-xs font-medium whitespace-nowrap rounded-full",
				chipTones[tone],
			)}
		>
			{children}
		</span>
	);
}

export function SettingsNotice({
	tone = "neutral",
	role,
	children,
}: {
	tone?: "neutral" | "danger";
	role?: "alert" | "status";
	children: ReactNode;
}) {
	return (
		<div
			role={role}
			className={clsx(
				"p-3 text-sm leading-6 rounded-xl border",
				tone === "danger"
					? "border-red-200 bg-red-50 text-red-700"
					: "border-gray-3 bg-gray-2 text-gray-11",
			)}
		>
			{children}
		</div>
	);
}
