"use client";

import { buildEnv } from "@cap/env";
import { Button, Logo } from "@cap/ui";
import { Video } from "@cap/web-domain";
import clsx from "clsx";
import { BarChart3, Infinity as InfinityIcon, Share2 } from "lucide-react";

const LIMIT = Video.FREE_PLAN_SHAREABLE_LINKS_PER_MONTH;
const MAX_MINUTES = Video.FREE_PLAN_MAX_RECORDING_SECONDS / 60;

const COPY = {
	links: {
		ownerTitle: "You've run out of shareable links",
		viewerTitle: "This video is over its free limit",
		ownerBody: `You've used all ${LIMIT} shareable links included with Cap's free plan this month. Upgrade to Cap Pro and this video becomes instantly viewable, along with everything else you record.`,
		viewerBody: `The owner of this video has used all ${LIMIT} shareable links included with Cap's free plan this month. As soon as they upgrade to Cap Pro, this video will be instantly viewable.`,
		viewerNote: `Cap's free plan includes ${LIMIT} shareable links per month.`,
	},
	duration: {
		ownerTitle: `This video is longer than ${MAX_MINUTES} minutes`,
		viewerTitle: "This video is over its free limit",
		ownerBody: `Cap's free plan shares videos up to ${MAX_MINUTES} minutes long. Upgrade to Cap Pro and this video becomes instantly viewable, along with everything else you record.`,
		viewerBody: `This video is longer than the ${MAX_MINUTES} minutes Cap's free plan shares. As soon as the owner upgrades to Cap Pro, it will be instantly viewable.`,
		viewerNote: `Cap's free plan shares videos up to ${MAX_MINUTES} minutes long.`,
	},
};

const PRO_BENEFITS = [
	{ icon: Share2, label: "Unlimited shareable links" },
	{ icon: InfinityIcon, label: "No recording length limits" },
	{ icon: BarChart3, label: "Analytics, Cap AI and password protection" },
];

export function ShareableLinkLimitOverlay({
	isOwner,
	reason = "links",
	onUpgrade,
	onUpgradeHover,
	className,
}: {
	isOwner: boolean;
	reason?: keyof typeof COPY;
	onUpgrade: () => void;
	onUpgradeHover?: () => void;
	className?: string;
}) {
	const copy = COPY[reason];
	return (
		<div
			className={clsx(
				"flex overflow-y-auto flex-col justify-center items-center rounded-xl bg-black px-4 py-6",
				className,
			)}
		>
			<div className="flex flex-col items-center max-w-md text-center">
				<Logo className="w-auto h-6 sm:h-8" white />
				<h3 className="mt-4 text-lg font-semibold text-white sm:text-xl">
					{isOwner ? copy.ownerTitle : copy.viewerTitle}
				</h3>
				<p className="mt-2 max-w-sm text-xs leading-relaxed sm:text-sm text-white/60">
					{isOwner ? copy.ownerBody : copy.viewerBody}
				</p>
				<div className="hidden flex-col gap-2 items-start mt-5 sm:flex">
					{PRO_BENEFITS.map(({ icon: Icon, label }) => (
						<div key={label} className="flex gap-2.5 items-center">
							<Icon className="size-4 shrink-0 text-blue-400" />
							<span className="text-sm text-white/80">{label}</span>
						</div>
					))}
				</div>
				{isOwner ? (
					<Button
						variant="blue"
						size="sm"
						className="mt-6"
						onClick={onUpgrade}
						onPointerEnter={onUpgradeHover}
					>
						Upgrade to Cap Pro
					</Button>
				) : (
					<Button
						variant="white"
						size="sm"
						className="mt-6"
						href={buildEnv.NEXT_PUBLIC_WEB_URL}
						target="_blank"
					>
						Record with Cap for free
					</Button>
				)}
				<p className="mt-3 text-xs text-white/40">
					{isOwner
						? "Videos recorded in Studio mode are saved to your device, free and unlimited."
						: copy.viewerNote}
				</p>
			</div>
		</div>
	);
}
