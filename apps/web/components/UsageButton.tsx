import { Button, Popover, PopoverContent, PopoverTrigger } from "@cap/ui";
import { faCheck, faCircleInfo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { HardDrive, Link2, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { memo, useEffect, useRef, useState } from "react";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { Tooltip } from "@/components/Tooltip";

export const UsageButton = memo(
	({
		subscribed,
		toggleMobileNav,
	}: {
		subscribed: boolean;
		toggleMobileNav?: () => void;
	}) => {
		const { sidebarCollapsed, shareableLinkUsage, setUpgradeModalOpen } =
			useDashboardContext();

		if (subscribed) {
			if (sidebarCollapsed) {
				return (
					<Tooltip
						position="right"
						content="Cap Pro. Unlimited shareable links."
					>
						<Link
							className="flex justify-center mx-auto w-full"
							href="/dashboard/settings/workspace"
						>
							<Button
								size="lg"
								className="overflow-hidden p-0 w-10 h-10 rounded-full truncate min-w-[unset] max-w-10"
								variant="blue"
							>
								<FontAwesomeIcon className="text-white size-4" icon={faCheck} />
							</Button>
						</Link>
					</Tooltip>
				);
			}

			return (
				<div className="p-3 w-full rounded-xl bg-gray-3">
					<div className="flex justify-between items-center">
						<span className="text-xs font-medium text-gray-11">
							Shareable links
						</span>
						<span className="text-xs font-semibold text-gray-12">
							Unlimited
						</span>
					</div>
					<Link className="block mt-3" href="/dashboard/settings/workspace">
						<Button size="sm" variant="blue" className="w-full">
							<FontAwesomeIcon
								className="mr-1 text-white size-4"
								icon={faCheck}
							/>
							<p className="text-white">Cap Pro</p>
						</Button>
					</Link>
				</div>
			);
		}

		const openUpgrade = () => {
			setUpgradeModalOpen(true);
			toggleMobileNav?.();
		};

		if (sidebarCollapsed) {
			return (
				<Tooltip
					position="right"
					content={
						shareableLinkUsage
							? `Upgrade to Pro. ${shareableLinkUsage.used}/${shareableLinkUsage.limit} shareable links used this month.`
							: "Upgrade to Pro"
					}
				>
					<Button
						variant="blue"
						onClick={openUpgrade}
						aria-label="Upgrade to Pro"
						className="p-0 mx-auto w-10 h-10 rounded-full min-w-[unset] max-w-10"
					>
						<Sparkles className="text-white size-4" />
					</Button>
				</Tooltip>
			);
		}

		if (!shareableLinkUsage) {
			return (
				<Button variant="blue" onClick={openUpgrade} className="w-full">
					Upgrade to Pro
				</Button>
			);
		}

		return (
			<div className="p-3 w-full rounded-xl bg-gray-3">
				<ShareableLinksMeter
					used={shareableLinkUsage.used}
					limit={shareableLinkUsage.limit}
					onShowBenefits={openUpgrade}
				/>
				<Button
					variant="blue"
					size="sm"
					onClick={openUpgrade}
					className="mt-3 w-full"
				>
					Upgrade to Pro
				</Button>
				<button
					type="button"
					onClick={openUpgrade}
					className="mt-2 w-full text-[11px] text-center text-gray-10 transition-colors hover:text-gray-12"
				>
					What&apos;s included in Pro?
				</button>
			</div>
		);
	},
);

const ShareableLinksMeter = ({
	used,
	limit,
	onShowBenefits,
}: {
	used: number;
	limit: number;
	onShowBenefits?: () => void;
}) => {
	const atLimit = used >= limit;
	const [infoOpen, setInfoOpen] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const openInfo = () => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		setInfoOpen(true);
	};
	// Grace delay so the pointer can cross the gap between the trigger and
	// the panel without the panel closing underneath it.
	const scheduleInfoClose = () => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(() => setInfoOpen(false), 150);
	};
	useEffect(
		() => () => {
			if (closeTimer.current) clearTimeout(closeTimer.current);
		},
		[],
	);

	return (
		<div>
			<div className="flex justify-between items-center">
				<div className="flex gap-1.5 items-center">
					<span className="text-xs font-medium text-gray-11">
						Shareable links
					</span>
					<Popover open={infoOpen} onOpenChange={setInfoOpen}>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label="About video limits"
								onMouseEnter={openInfo}
								onMouseLeave={scheduleInfoClose}
								onFocus={openInfo}
								onBlur={scheduleInfoClose}
								// preventDefault stops Radix's toggle-on-click, so a tap
								// (which fires mouseenter then click) opens instead of
								// opening and immediately closing again.
								onClick={(event) => {
									event.preventDefault();
									openInfo();
								}}
								className="flex items-center text-gray-9 transition-colors hover:text-gray-11 data-[state=open]:text-gray-11"
							>
								<FontAwesomeIcon icon={faCircleInfo} className="size-3" />
							</button>
						</PopoverTrigger>
						<PopoverContent
							side="top"
							align="start"
							sideOffset={8}
							onOpenAutoFocus={(event) => event.preventDefault()}
							onMouseEnter={openInfo}
							onMouseLeave={scheduleInfoClose}
							className="z-[60] p-0 w-72 border shadow-lg bg-gray-1 border-gray-4"
						>
							<div className="px-4 py-3 border-b border-gray-4">
								<p className="text-[13px] font-medium text-gray-12">
									Video limits
								</p>
								<p className="mt-0.5 text-xs text-gray-10">
									What counts toward your free plan
								</p>
							</div>
							<div className="flex flex-col gap-3.5 px-4 py-3.5">
								<div className="flex gap-3 items-start">
									<div className="flex justify-center items-center mt-0.5 rounded-md bg-gray-3 shrink-0 size-7">
										<Link2 className="size-3.5 text-gray-11" />
									</div>
									<div>
										<p className="text-xs font-medium text-gray-12">
											Shareable links
										</p>
										<p className="mt-0.5 text-xs leading-relaxed text-gray-10">
											{limit} per month on the free plan. Resets on the 1st of
											each month.
										</p>
									</div>
								</div>
								<div className="flex gap-3 items-start">
									<div className="flex justify-center items-center mt-0.5 rounded-md bg-gray-3 shrink-0 size-7">
										<HardDrive className="size-3.5 text-gray-11" />
									</div>
									<div>
										<p className="text-xs font-medium text-gray-12">
											Unlimited Studio mode videos
										</p>
										<p className="mt-0.5 text-xs leading-relaxed text-gray-10">
											Saved to your device. Always free.
										</p>
									</div>
								</div>
							</div>
							{onShowBenefits && (
								<button
									type="button"
									onClick={() => {
										setInfoOpen(false);
										onShowBenefits();
									}}
									className="flex justify-between items-center px-4 py-2.5 w-full text-xs font-medium border-t transition-colors border-gray-4 text-gray-11 hover:text-gray-12 hover:bg-gray-2"
								>
									What are the benefits of Pro?
									<span aria-hidden className="text-gray-9">
										&rarr;
									</span>
								</button>
							)}
						</PopoverContent>
					</Popover>
				</div>
				<span
					className={clsx(
						"text-xs font-semibold tabular-nums",
						atLimit ? "text-red-500" : "text-gray-12",
					)}
				>
					{used}/{limit}
				</span>
			</div>
			<div className="overflow-hidden mt-2.5 w-full h-1.5 rounded-full bg-gray-5">
				<motion.div
					initial={{ width: 0 }}
					animate={{
						width: `${Math.min(100, Math.round((used / limit) * 100))}%`,
					}}
					transition={{
						type: "spring",
						stiffness: 110,
						damping: 20,
						delay: 0.15,
					}}
					className={clsx(
						"h-full rounded-full",
						atLimit ? "bg-red-500" : "bg-blue-500",
					)}
				/>
			</div>
			{atLimit && (
				<p className="mt-2 text-[11px] leading-snug text-gray-10">
					New shareable links are locked until next month. Upgrade for
					unlimited.
				</p>
			)}
		</div>
	);
};
