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
					<svg
						className="w-[92px] h-auto block dark:hidden"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 103 40"
						aria-label="Cap Logo"
					>
						<title>Cap Logo</title>
						<rect
							width="39.5"
							height="39.5"
							x="0.25"
							y="0.25"
							fill="#fff"
							rx="7.75"
						></rect>
						<rect
							width="39.5"
							height="39.5"
							x="0.25"
							y="0.25"
							stroke="#E7EAF0"
							strokeWidth="0.5"
							rx="7.75"
						></rect>
						<path
							fill="#4785FF"
							d="M20 36c8.837 0 16-7.163 16-16S28.837 4 20 4 4 11.164 4 20s7.164 16 16 16"
						></path>
						<path
							fill="#ADC9FF"
							d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13"
						></path>
						<path
							fill="#fff"
							d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10"
						></path>
						<path
							fill="#12161F"
							d="M58.416 30.448c-5.404 0-9.212-3.864-9.212-10.36 0-6.384 3.668-10.416 9.268-10.416 5.068 0 7.784 2.66 8.624 7.168l-3.808.196c-.476-2.604-2.072-4.2-4.816-4.2-3.388 0-5.488 2.828-5.488 7.252 0 4.48 2.156 7.196 5.46 7.196 2.94 0 4.508-1.708 4.956-4.564l3.808.196c-.784 4.676-3.752 7.532-8.792 7.532m16.23-.112c-3.137 0-5.209-1.484-5.209-4.088 0-2.576 1.596-3.948 4.872-4.592l4.956-.98c0-2.1-.98-3.192-2.856-3.192-1.764 0-2.716.812-3.052 2.324l-3.668-.168c.588-3.136 2.996-4.928 6.72-4.928 4.256 0 6.44 2.24 6.44 6.216v5.432c0 .812.28 1.036.84 1.036h.476V30c-.224.056-.812.112-1.288.112-1.624 0-2.828-.588-3.136-2.436-.728 1.596-2.632 2.66-5.096 2.66m.727-2.604c2.38 0 3.892-1.512 3.892-3.78v-.84l-3.864.784c-1.596.308-2.24.98-2.24 2.016 0 1.176.784 1.82 2.212 1.82M86.874 34.2V15.048h3.444l.056 2.212c.868-1.652 2.52-2.548 4.48-2.548 4.256 0 6.356 3.5 6.356 7.812s-2.128 7.812-6.384 7.812c-1.904 0-3.556-.924-4.368-2.38V34.2zm7.112-6.776c2.184 0 3.5-1.82 3.5-4.9s-1.316-4.9-3.5-4.9-3.528 1.652-3.528 4.9 1.316 4.9 3.528 4.9"
						></path>
					</svg>
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
