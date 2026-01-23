import type { FontAwesomeIconProps } from "@fortawesome/react-fontawesome";
import { LoadingSpinner } from "@inflight/ui";
import type { ReactElement } from "react";
import React from "react";

const EmptyState = ({
	commentsDisabled,
	icon,
}: {
	commentsDisabled?: boolean;
	icon?: ReactElement<FontAwesomeIconProps>;
}) => (
	<div className="flex flex-col justify-center items-center p-8 h-full text-center animate-in fade-in">
		{!commentsDisabled && <LoadingSpinner />}
		{icon && (
			<div className="mb-4">
				{React.cloneElement(icon, { className: "text-gray-12 size-8" })}
			</div>
		)}
		<div className="space-y-1">
			<h3 className="text-base font-medium text-gray-12">
				{commentsDisabled ? "Disabled" : "No comments yet"}
			</h3>
			<p className="text-sm text-gray-10">
				{commentsDisabled
					? "Comments are disabled for this video"
					: "Be the first to share your thoughts!"}
			</p>
		</div>
	</div>
);

export default EmptyState;
