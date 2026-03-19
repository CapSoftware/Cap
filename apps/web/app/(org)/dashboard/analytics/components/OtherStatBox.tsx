import type { FontAwesomeIconProps } from "@fortawesome/react-fontawesome";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { clsx } from "clsx";

interface OtherStatBoxProps {
	title: string;
	icon: FontAwesomeIconProps["icon"];
	children: React.ReactNode;
	className?: string;
}

export default function OtherStatBox({
	title,
	icon,
	children,
	className,
}: OtherStatBoxProps) {
	return (
		<div
			className={clsx(
				className,
				"p-6 space-y-6 w-full rounded-xl border bg-gray-1 border-gray-3 h-fit",
			)}
		>
			<div className="flex gap-2 items-center">
				<FontAwesomeIcon icon={icon} className="size-4 text-gray-10" />
				<p className="text-xl font-medium text-gray-12">{title}</p>
			</div>
			{children}
		</div>
	);
}
