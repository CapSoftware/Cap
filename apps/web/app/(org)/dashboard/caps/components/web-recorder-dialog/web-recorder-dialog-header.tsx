"use client";

import { ArrowLeftIcon } from "lucide-react";
import { useDashboardContext } from "../../../Contexts";

interface WebRecorderDialogHeaderProps {
	isBusy: boolean;
	freeMinutes: number;
	onClose: () => void;
}

export const WebRecorderDialogHeader = ({
	isBusy,
	freeMinutes,
	onClose,
}: WebRecorderDialogHeaderProps) => {
	const { user, setUpgradeModalOpen } = useDashboardContext();

	return (
		<header className="flex h-14 shrink-0 items-center justify-between gap-3 px-3 sm:px-5">
			<div className="flex min-w-0 items-center gap-2">
				<button
					type="button"
					aria-label="Close recorder"
					onClick={onClose}
					disabled={isBusy}
					className="flex size-9 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4785FF] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
				>
					<ArrowLeftIcon className="size-5" aria-hidden />
				</button>
				<svg
					className="size-6 shrink-0"
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
				<span className="truncate text-[0.9375rem] font-semibold text-white">
					New recording
				</span>
			</div>
			{user.isPro ? (
				<span className="rounded-full bg-[#4785FF]/15 px-2.5 py-1 text-[0.75rem] font-medium text-[#8fb3ff]">
					Pro
				</span>
			) : (
				<button
					type="button"
					onClick={() => setUpgradeModalOpen(true)}
					className="rounded-full bg-white/[0.08] px-3 py-1 text-[0.75rem] font-medium text-white/70 transition-colors hover:bg-white/[0.14] hover:text-white"
				>
					Free · up to {freeMinutes} min
				</button>
			)}
		</header>
	);
};
