"use client";

import { LogoBadge } from "@cap/ui";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useRouter } from "next/navigation";

export const Base = ({
	children,
	title,
	description,
	descriptionClassName,
	hideBackButton = false,
}: {
	children: React.ReactNode;
	title: string;
	description: string | React.ReactNode;
	descriptionClassName?: string;
	hideBackButton?: boolean;
}) => {
	const router = useRouter();
	return (
		<div className="relative w-[calc(100%-2%)] space-y-7 p-7 max-w-[472px] bg-gray-2 border border-gray-4 rounded-2xl">
			{!hideBackButton && (
				<div
					onClick={() => router.back()}
					className="absolute overflow-hidden flex top-5 rounded-full left-5 z-20 hover:bg-gray-1 gap-2 items-center py-1.5 px-3 text-gray-12 bg-transparent border border-gray-4 transition-colors duration-300 cursor-pointer"
				>
					<FontAwesomeIcon className="w-2" icon={faArrowLeft} />
					<p className="text-xs text-inherit">Back</p>
				</div>
			)}
			<a href="/">
				<LogoBadge className="mx-auto w-auto h-12" />
			</a>
			<div className="flex flex-col justify-center items-center space-y-1 text-center">
				<h2 className="text-2xl font-semibold text-gray-12">{title}</h2>
				{typeof description === "string" ? (
					<p
						className={clsx(
							"w-full text-base max-w-[260px] text-gray-10",
							descriptionClassName,
						)}
					>
						{description}
					</p>
				) : (
					description
				)}
			</div>
			{children}
		</div>
	);
};
