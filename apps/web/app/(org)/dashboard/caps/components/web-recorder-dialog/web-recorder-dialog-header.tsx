"use client";

import clsx from "clsx";
import { CircleHelpIcon, Settings2Icon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useDashboardContext } from "../../../Contexts";

interface WebRecorderDialogHeaderProps {
	isBusy: boolean;
	onClose: () => void;
	onOpenSettings: () => void;
	onOpenHelp: () => void;
}

const IconButton = ({ className, ...props }: ComponentProps<"button">) => (
	<button
		type="button"
		className={clsx(
			"flex size-8 items-center justify-center rounded-lg text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
			className,
		)}
		{...props}
	/>
);

export const WebRecorderDialogHeader = ({
	isBusy,
	onClose,
	onOpenSettings,
	onOpenHelp,
}: WebRecorderDialogHeaderProps) => {
	const { user, setUpgradeModalOpen } = useDashboardContext();

	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex min-w-0 items-center gap-2.5">
				<svg
					className="size-7 shrink-0"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 40 40"
					aria-hidden
				>
					<title>Cap</title>
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
				<div className="flex min-w-0 flex-col">
					<span className="truncate text-[0.9375rem] font-semibold leading-tight text-gray-12">
						Record a Cap
					</span>
					<span className="text-[0.75rem] leading-tight text-gray-10">
						Screen, camera and audio on separate tracks
					</span>
				</div>
				{user.isPro ? (
					<span className="ml-1 hidden shrink-0 rounded-full bg-blue-9 px-2 py-0.5 text-[0.6875rem] font-medium text-white sm:inline-flex">
						Pro
					</span>
				) : (
					<button
						type="button"
						onClick={() => setUpgradeModalOpen(true)}
						className="ml-1 hidden shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-12 transition-colors hover:bg-gray-4 sm:inline-flex"
					>
						Free
					</button>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-0.5">
				<IconButton aria-label="How the recorder works" onClick={onOpenHelp}>
					<CircleHelpIcon className="size-[1.125rem]" aria-hidden />
				</IconButton>
				<IconButton aria-label="Recorder settings" onClick={onOpenSettings}>
					<Settings2Icon className="size-[1.125rem]" aria-hidden />
				</IconButton>
				<IconButton
					aria-label="Close recorder"
					onClick={onClose}
					disabled={isBusy}
				>
					<XIcon className="size-[1.125rem]" aria-hidden />
				</IconButton>
			</div>
		</div>
	);
};
