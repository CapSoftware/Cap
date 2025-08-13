import { buildEnv, NODE_ENV } from "@cap/env";
import { Button } from "@cap/ui";
import { faDownload, faLink } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import type { ReactNode } from "react";
import { Tooltip } from "@/components/Tooltip";
import { usePublicEnv } from "@/utils/public-env";

interface ButtonConfig {
	tooltipContent: string;
	onClick: (e: React.MouseEvent) => void;
	className: string;
	disabled: boolean;
	icon: () => ReactNode;
}

export interface CapCardButtonsProps {
	capId: string;
	copyPressed: boolean;
	isDownloading: boolean;
	handleCopy: (url: string) => void;
	handleDownload: () => void;
	customDomain?: string | null;
	domainVerified?: boolean;
}

export const CapCardButtons: React.FC<CapCardButtonsProps> = ({
	capId,
	copyPressed,
	isDownloading,
	handleCopy,
	handleDownload,
	customDomain,
	domainVerified,
}) => {
	const { webUrl } = usePublicEnv();
	return (
		<>
			{buttons(
				capId,
				copyPressed,
				isDownloading,
				handleCopy,
				handleDownload,
				webUrl,
				customDomain,
				domainVerified,
			).map((button, index) => (
				<Tooltip key={index} content={button.tooltipContent}>
					<Button
						onClick={button.onClick}
						disabled={button.disabled}
						className={clsx(
							`!size-8 hover:bg-gray-5 hover:border-gray-7 rounded-full min-w-fit !p-0`,
							button.className,
						)}
						variant="white"
						size="sm"
						aria-label={button.tooltipContent}
					>
						{button.icon()}
					</Button>
				</Tooltip>
			))}
		</>
	);
};

const buttons = (
	capId: string,
	copyPressed: boolean,
	isDownloading: boolean,
	handleCopy: (url: string) => void,
	handleDownload: () => void,
	webUrl: string,
	customDomain?: string | null,
	domainVerified?: boolean,
): ButtonConfig[] => [
	{
		tooltipContent: "Copy link",
		onClick: (e: React.MouseEvent) => {
			e.stopPropagation();

			const getVideoLink = () => {
				if (NODE_ENV === "development" && customDomain && domainVerified) {
					return `https://${customDomain}/s/${capId}`;
				} else if (
					NODE_ENV === "development" &&
					!customDomain &&
					!domainVerified
				) {
					return `${webUrl}/s/${capId}`;
				} else if (
					buildEnv.NEXT_PUBLIC_IS_CAP &&
					customDomain &&
					domainVerified
				) {
					return `https://${customDomain}/s/${capId}`;
				} else if (
					buildEnv.NEXT_PUBLIC_IS_CAP &&
					!customDomain &&
					!domainVerified
				) {
					return `https://cap.link/${capId}`;
				} else {
					return `${webUrl}/s/${capId}`;
				}
			};

			handleCopy(getVideoLink());
		},
		className: "delay-0",
		disabled: false,
		icon: () => {
			return !copyPressed ? (
				<FontAwesomeIcon className="text-gray-12 size-4" icon={faLink} />
			) : (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="text-gray-12 size-5 svgpathanimation"
				>
					<path d="M20 6 9 17l-5-5" />
				</svg>
			);
		},
	},
	{
		tooltipContent: "Download Cap",
		onClick: (e: React.MouseEvent) => {
			e.stopPropagation();
			handleDownload();
		},
		className: "delay-25",
		disabled: isDownloading,
		icon: () => {
			return isDownloading ? (
				<div className="animate-spin size-3">
					<svg
						className="size-3"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
					>
						<circle
							className="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="4"
						></circle>
						<path
							className="opacity-75"
							fill="currentColor"
							d="m2 12c0-5.523 4.477-10 10-10v3c-3.866 0-7 3.134-7 7s3.134 7 7 7 7-3.134 7-7c0-1.457-.447-2.808-1.208-3.926l2.4-1.6c1.131 1.671 1.808 3.677 1.808 5.526 0 5.523-4.477 10-10 10s-10-4.477-10-10z"
						></path>
					</svg>
				</div>
			) : (
				<FontAwesomeIcon className="text-gray-12 size-3" icon={faDownload} />
			);
		},
	},
];
