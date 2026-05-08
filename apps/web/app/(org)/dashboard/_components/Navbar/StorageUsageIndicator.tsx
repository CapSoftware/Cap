"use client";

import clsx from "clsx";
import { HardDrive } from "lucide-react";
import { useEffect, useState } from "react";

type StorageUsage = {
	bucket: string;
	usedBytes: number;
	limitBytes: number;
	usedPercent: number;
	objectCount: number;
};

const formatBytes = (bytes: number) => {
	if (bytes === 0) return "0 B";

	const units = ["B", "KB", "MB", "GB", "TB"];
	const index = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	const value = bytes / 1024 ** index;
	const unit = units[index] ?? "B";

	return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
};

export function StorageUsageIndicator({ collapsed }: { collapsed: boolean }) {
	const [usage, setUsage] = useState<StorageUsage | null>(null);

	useEffect(() => {
		let active = true;

		fetch("/api/storage/r2-usage", { cache: "no-store" })
			.then((response) => (response.ok ? response.json() : null))
			.then((data: StorageUsage | null) => {
				if (active) setUsage(data);
			})
			.catch(() => {
				if (active) setUsage(null);
			});

		return () => {
			active = false;
		};
	}, []);

	if (!usage) {
		return null;
	}

	const percent = Math.max(0, Math.min(100, usage.usedPercent));
	const label = `${formatBytes(usage.usedBytes)} / ${formatBytes(
		usage.limitBytes,
	)}`;

	return (
		<div
			className={clsx(
				"mx-3 mb-4 rounded-lg border border-gray-4 bg-gray-2 text-gray-11",
				collapsed ? "px-2 py-2" : "px-3 py-3",
			)}
			title={`Cloudflare R2 ${label}`}
		>
			<div
				className={clsx(
					"flex items-center",
					collapsed ? "justify-center" : "justify-between gap-2",
				)}
			>
				<div className="flex items-center gap-2 min-w-0">
					<HardDrive className="size-4 shrink-0" />
					{!collapsed && (
						<div className="min-w-0">
							<p className="text-xs font-medium truncate text-gray-12">
								Cloudflare R2
							</p>
							<p className="text-[11px] truncate text-gray-10">{label}</p>
						</div>
					)}
				</div>
				{!collapsed && (
					<p className="text-[11px] font-medium text-gray-11">
						{Math.round(percent)}%
					</p>
				)}
			</div>
			{!collapsed && (
				<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-4">
					<div
						className="h-full rounded-full bg-blue-9"
						style={{ width: `${percent}%` }}
					/>
				</div>
			)}
		</div>
	);
}
