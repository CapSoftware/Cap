import { buildEnv, NODE_ENV } from "@cap/env";
import { Button } from "@cap/ui";
import { faGear, faLink } from "@fortawesome/free-solid-svg-icons";
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
	handleCopy: (url: string) => void;
	customDomain?: string | null;
	domainVerified?: boolean;
	setIsSettingsDialogOpen: (isOpen: boolean) => void;
}

export const CapCardButtons: React.FC<CapCardButtonsProps> = ({
	capId,
	copyPressed,
	handleCopy,
	customDomain,
	domainVerified,
	setIsSettingsDialogOpen,
}) => {
	const { webUrl } = usePublicEnv();
	return (
		<>
			{buttons(
				capId,
				copyPressed,
				handleCopy,
				webUrl,
				customDomain,
				domainVerified,
				setIsSettingsDialogOpen,
			).map((button, index) => (
				<Tooltip key={index.toString()} content={button.tooltipContent}>
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
	handleCopy: (url: string) => void,
	webUrl: string,
	customDomain?: string | null,
	domainVerified?: boolean,
	setIsSettingsDialogOpen?: (isOpen: boolean) => void,
): ButtonConfig[] => [
	{
		tooltipContent: "Settings",
		onClick: (e: React.MouseEvent) => {
			e.stopPropagation();
			setIsSettingsDialogOpen?.(true);
		},
		className: "delay-0",
		disabled: false,
		icon: () => {
			return (
				<FontAwesomeIcon className="text-gray-12 size-3.5" icon={faGear} />
			);
		},
	},
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
];
