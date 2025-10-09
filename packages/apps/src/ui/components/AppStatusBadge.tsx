"use client";

import type { Apps } from "@cap/web-domain";
import clsx from "clsx";

type AppStatus = typeof Apps.AppStatus.Type;

type StatusKey = AppStatus | "not_installed";

type BadgeConfig = {
	label: string;
	className: string;
	indicatorClassName: string;
};

const STATUS_CONFIG: Record<StatusKey, BadgeConfig> = {
	connected: {
		label: "Connected",
		className: "bg-blue-4 text-blue-11 border border-blue-6",
		indicatorClassName: "bg-blue-9",
	},
	paused: {
		label: "Paused",
		className: "bg-gray-4 text-gray-11 border border-gray-6",
		indicatorClassName: "bg-gray-11",
	},
	needs_attention: {
		label: "Needs attention",
		className: "bg-red-100 text-red-400 border border-red-300",
		indicatorClassName: "bg-red-400",
	},
	not_installed: {
		label: "Not connected",
		className: "bg-gray-4 text-gray-11 border border-gray-6",
		indicatorClassName: "bg-gray-9",
	},
};

const AppStatusBadge = ({ status }: { status: StatusKey }) => {
	const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.not_installed;

	return (
		<span
			className={clsx(
				"inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium",
				config.className,
			)}
		>
			<span
				className={clsx("size-1.5 rounded-full", config.indicatorClassName)}
			/>
			{config.label}
		</span>
	);
};

export type { StatusKey as AppStatusKey };
export { AppStatusBadge };
