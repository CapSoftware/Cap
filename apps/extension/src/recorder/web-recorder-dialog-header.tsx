"use client";

import { Logo } from "@cap/ui";
import clsx from "clsx";
import { CAP_WEB_ORIGIN } from "@/lib/cap-web";

interface WebRecorderDialogHeaderProps {
	isProUser: boolean;
}

export const WebRecorderDialogHeader = ({
	isProUser,
}: WebRecorderDialogHeaderProps) => {
	const planLabel = isProUser ? "Pro" : "Free";
	const planClassName = clsx(
		"ml-2 inline-flex items-center rounded-full px-2 text-[0.7rem] font-medium transition-colors",
		isProUser
			? "bg-blue-9 text-gray-1"
			: "cursor-pointer bg-gray-3 text-gray-12 hover:bg-gray-4",
	);

	return (
		<div className="flex items-center justify-between pb-[0.25rem]">
			<div className="flex items-center space-x-1">
				<Logo className="h-8 w-auto" />
				<button
					type="button"
					onClick={() => {
						if (isProUser) return;
						try {
							window.open(`${CAP_WEB_ORIGIN}/pricing`, "_blank", "noopener");
						} catch {}
					}}
					className={planClassName}
					disabled={isProUser}
				>
					{planLabel}
				</button>
			</div>
		</div>
	);
};
