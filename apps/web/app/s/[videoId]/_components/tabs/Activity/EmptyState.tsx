import { LoadingSpinner } from "@cap/ui";
import type { FontAwesomeIconProps } from "@fortawesome/react-fontawesome";
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
				{commentsDisabled ? "已关闭" : "暂无评论"}
			</h3>
			<p className="text-sm text-gray-10">
				{commentsDisabled ? "此视频已关闭评论" : "来发表第一条评论吧！"}
			</p>
		</div>
	</div>
);

export default EmptyState;
