"use client";

import { classNames } from "@cap/utils";
import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { ReactNode } from "react";

interface PlanFeatureProps {
	children: ReactNode;
	strong?: boolean;
}

export const PlanFeature = ({ children, strong }: PlanFeatureProps) => {
	return (
		<li className="flex gap-3 items-start">
			<FontAwesomeIcon
				icon={faCheck}
				className="mt-1 text-blue-500 shrink-0 size-3.5"
			/>
			<span
				className={classNames(
					"text-sm leading-relaxed",
					strong ? "font-medium text-gray-12" : "text-gray-11",
				)}
			>
				{children}
			</span>
		</li>
	);
};
