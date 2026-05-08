"use client";

import clsx from "clsx";
import { useDashboardContext } from "../../../Contexts";

interface WebRecorderDialogHeaderProps {
	isBusy: boolean;
	onClose: () => void;
}

export const WebRecorderDialogHeader = ({
	isBusy,
	onClose,
}: WebRecorderDialogHeaderProps) => {
	const { user, setUpgradeModalOpen } = useDashboardContext();
	const planLabel = user.isPro ? "Pro" : "Free";
	const planClassName = clsx(
		"ml-2 inline-flex items-center rounded-full px-2 text-[0.7rem] font-medium transition-colors",
		user.isPro
			? "bg-blue-9 text-gray-1"
			: "cursor-pointer bg-gray-3 text-gray-12 hover:bg-gray-4",
	);

	return (
		<>
			<div className="absolute left-3 top-3 flex gap-1.5 items-center">
				<button
					type="button"
					onClick={onClose}
					disabled={isBusy}
					className={clsx(
						"size-3 rounded-full bg-[#FF5F57] border-none p-0",
						isBusy
							? "opacity-50 cursor-not-allowed"
							: "cursor-pointer hover:opacity-80 transition-opacity",
					)}
					aria-label="Close dialog"
				/>
				<div className="size-3 rounded-full bg-gray-8 opacity-50"></div>
				<div className="size-3 rounded-full bg-gray-8 opacity-50"></div>
			</div>
			<div className="flex items-center justify-between pb-[0.25rem]">
				<div className="flex items-center space-x-1">
					<span className="text-sm font-medium text-gray-12">Recorder</span>
					<span
						onClick={() => {
							if (!user.isPro) setUpgradeModalOpen(true);
						}}
						className={planClassName}
					>
						{planLabel}
					</span>
				</div>
			</div>
		</>
	);
};
