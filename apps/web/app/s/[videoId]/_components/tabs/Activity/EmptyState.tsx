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
		<div className="mb-4">
			{icon ? (
				React.cloneElement(icon, { className: "text-gray-12 size-8" })
			) : (
				<CommentGlyph />
			)}
		</div>
		<div className="space-y-1">
			<h3 className="text-base font-medium text-gray-12">
				{commentsDisabled ? "Disabled" : "Be the first to comment"}
			</h3>
			<p className="text-sm text-gray-10">
				{commentsDisabled ? (
					"Comments are disabled for this video"
				) : (
					<>
						Hit{" "}
						<kbd className="rounded border border-gray-5 bg-gray-2 px-1 font-sans text-[11px] text-gray-11">
							C
						</kbd>{" "}
						or use the box below.
					</>
				)}
			</p>
		</div>
	</div>
);

/** Stands in for the list that isn't there yet. Muted: an empty panel should
 * read as an invitation, not as a state that failed to load. */
const CommentGlyph = () => (
	<svg
		viewBox="0 0 32 32"
		className="size-8 text-gray-8"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.6"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden
	>
		<title>No comments yet</title>
		<path d="M5 8.5A2.5 2.5 0 0 1 7.5 6h17A2.5 2.5 0 0 1 27 8.5v11a2.5 2.5 0 0 1-2.5 2.5H14l-6 4.5V22H7.5A2.5 2.5 0 0 1 5 19.5v-11Z" />
		<path d="M11 11.5h10M11 16h6" />
	</svg>
);

export default EmptyState;
