import { classNames } from "@cap/utils";
import type React from "react";

const BaseQuantityButtonClasses =
	"flex justify-center items-center px-2 w-6 h-6 rounded-md outline-none";

export const QuantityButton = ({
	onClick,
	children,
	className,
	ariaLabel,
}: {
	onClick: () => void;
	children: React.ReactNode;
	className?: string;
	ariaLabel?: string;
}) => {
	return (
		<button
			onClick={onClick}
			className={classNames(BaseQuantityButtonClasses, className)}
			aria-label={ariaLabel}
		>
			{children}
		</button>
	);
};
