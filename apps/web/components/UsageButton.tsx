import { Button } from "@cap/ui";
import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { Link2 } from "lucide-react";
import Link from "next/link";
import { memo } from "react";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { Tooltip } from "@/components/Tooltip";
import { formatUtcMonthDayOrdinal } from "@/lib/utils";

export const UsageButton = memo(
	({
		subscribed,
		toggleMobileNav,
	}: {
		subscribed: boolean;
		toggleMobileNav?: () => void;
	}) => {
		const { setUpgradeModalOpen, shareableLinkUsage, sidebarCollapsed } =
			useDashboardContext();
		if (subscribed) {
			return (
				<Tooltip position="right" content="Cap Pro">
					<Link
						className="flex justify-center mx-auto w-full"
						href="/dashboard/settings/workspace"
					>
						<Button
							size="lg"
							className={clsx(
								"overflow-hidden truncate",
								sidebarCollapsed
									? "p-0 w-10 h-10 rounded-full min-w-[unset] max-w-10"
									: "w-full",
							)}
							variant="blue"
						>
							<FontAwesomeIcon
								className={clsx(
									"text-white size-4",
									sidebarCollapsed ? "mr-0" : "mr-1",
								)}
								icon={faCheck}
							/>
							{sidebarCollapsed ? null : <p className="text-white">Cap Pro</p>}
						</Button>
					</Link>
				</Tooltip>
			);
		}

		const percent = Math.min(
			100,
			(shareableLinkUsage.used / shareableLinkUsage.limit) * 100,
		);
		const resetDate = formatUtcMonthDayOrdinal(shareableLinkUsage.resetAt);
		const openUpgrade = () => {
			setUpgradeModalOpen(true);
			toggleMobileNav?.();
		};

		if (sidebarCollapsed) {
			return (
				<Tooltip
					position="right"
					content={`${shareableLinkUsage.used}/${shareableLinkUsage.limit} share links used`}
				>
					<Button
						type="button"
						size="lg"
						variant="white"
						onClick={openUpgrade}
						className="p-0 mx-auto w-10 h-10 min-w-[unset] rounded-full"
					>
						<span className="flex flex-col items-center leading-none">
							<Link2 className="size-4 text-gray-12" />
							<span className="text-[10px] text-gray-11">
								{shareableLinkUsage.used}/{shareableLinkUsage.limit}
							</span>
						</span>
					</Button>
				</Tooltip>
			);
		}

		return (
			<div className="mx-auto w-full rounded-lg border border-gray-5 bg-gray-3 p-3">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						<Link2 className="size-4 shrink-0 text-gray-12" />
						<p className="truncate text-sm font-medium text-gray-12">
							Share links
						</p>
					</div>
					<p className="shrink-0 text-sm font-medium text-gray-12">
						{shareableLinkUsage.used}/{shareableLinkUsage.limit}
					</p>
				</div>
				<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-6">
					<div
						className="h-full rounded-full bg-blue-9"
						style={{ width: `${percent}%` }}
					/>
				</div>
				<div className="mt-2 flex items-center justify-between gap-2">
					<p className="truncate text-xs text-gray-10">
						{shareableLinkUsage.remaining} left - 5 min max - resets {resetDate}
					</p>
					<button
						type="button"
						onClick={openUpgrade}
						className="shrink-0 text-xs font-medium text-blue-11 hover:text-blue-12"
					>
						Upgrade
					</button>
				</div>
			</div>
		);
	},
);
