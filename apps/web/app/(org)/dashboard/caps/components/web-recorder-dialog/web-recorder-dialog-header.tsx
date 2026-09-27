"use client";

import { Switch } from "@cap/ui";
import { XIcon } from "lucide-react";
import { useId } from "react";
import { useDashboardContext } from "../../../Contexts";

interface WebRecorderDialogHeaderProps {
	isBusy: boolean;
	rememberDevices: boolean;
	onRememberDevicesChange: (value: boolean) => void;
	onClose: () => void;
}

export const WebRecorderDialogHeader = ({
	isBusy,
	rememberDevices,
	onRememberDevicesChange,
	onClose,
}: WebRecorderDialogHeaderProps) => {
	const { user, setUpgradeModalOpen } = useDashboardContext();
	const rememberId = useId();

	return (
		<header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-gray-3 px-4 sm:px-6">
			<div className="flex min-w-0 items-center gap-3">
				<button
					type="button"
					aria-label="Close recorder"
					onClick={onClose}
					disabled={isBusy}
					className="flex size-9 items-center justify-center rounded-full text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
				>
					<XIcon className="size-5" aria-hidden />
				</button>
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
				<span className="truncate text-[0.9375rem] font-semibold text-gray-12">
					New recording
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-4">
				<div className="hidden items-center gap-2 text-[0.8125rem] text-gray-11 sm:flex">
					<Switch
						id={rememberId}
						checked={rememberDevices}
						onCheckedChange={onRememberDevicesChange}
						disabled={isBusy}
						aria-label="Remember camera and microphone"
					/>
					<label htmlFor={rememberId}>Remember devices</label>
				</div>
				{user.isPro ? (
					<span className="rounded-full bg-blue-9 px-2.5 py-0.5 text-[0.75rem] font-medium text-white">
						Pro
					</span>
				) : (
					<button
						type="button"
						onClick={() => setUpgradeModalOpen(true)}
						className="rounded-full bg-gray-3 px-2.5 py-0.5 text-[0.75rem] font-medium text-gray-12 transition-colors hover:bg-gray-4"
					>
						Free
					</button>
				)}
			</div>
		</header>
	);
};
