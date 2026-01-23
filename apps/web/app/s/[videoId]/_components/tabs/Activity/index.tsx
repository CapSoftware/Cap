"use client";

import type { Video } from "@inflight/web-domain";
import type React from "react";
import { forwardRef, type JSX, Suspense, useState } from "react";
import { CapCardAnalytics } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { CommentType } from "../../../Share";
import { AuthOverlay } from "../../AuthOverlay";
import Analytics from "./Analytics";
import { Comments } from "./Comments";

interface ActivityProps {
	views: MaybePromise<number>;
	comments: CommentType[];
	setComments: React.Dispatch<React.SetStateAction<CommentType[]>>;
	onSeek?: (time: number) => void;
	handleCommentSuccess: (comment: CommentType) => void;
	videoId: Video.VideoId;
	optimisticComments: CommentType[];
	setOptimisticComments: (newComment: CommentType) => void;
	isOwnerOrMember: boolean;
	isOwner: boolean;
	commentsDisabled: boolean;
}

export const Activity = Object.assign(
	forwardRef<{ scrollToBottom: () => void }, ActivityProps>(
		(
			{
				videoId,
				isOwnerOrMember,
				isOwner,
				comments,
				handleCommentSuccess,
				optimisticComments,
				setOptimisticComments,
				setComments,
				commentsDisabled,
				...props
			},
			ref,
		) => {
			return (
				<Activity.Shell
					analytics={
						<Suspense fallback={<CapCardAnalytics.Skeleton />}>
							<Analytics
								videoId={videoId}
								views={props.views}
								comments={comments}
								isLoadingAnalytics={false}
								isOwner={isOwner}
							/>
						</Suspense>
					}
					isOwnerOrMember={isOwnerOrMember}
				>
					{({ setShowAuthOverlay }) => (
						<Comments
							ref={ref}
							handleCommentSuccess={handleCommentSuccess}
							optimisticComments={optimisticComments}
							setOptimisticComments={setOptimisticComments}
							setComments={setComments}
							videoId={videoId}
							setShowAuthOverlay={setShowAuthOverlay}
							onSeek={props.onSeek}
							commentsDisabled={commentsDisabled}
						/>
					)}
				</Activity.Shell>
			);
		},
	),
	{
		Shell: (props: {
			analytics?: JSX.Element;
			isOwnerOrMember: boolean;
			children?: (props: {
				setShowAuthOverlay: (show: boolean) => void;
			}) => JSX.Element;
		}) => {
			const user = useCurrentUser();
			const [showAuthOverlay, setShowAuthOverlay] = useState(false);

			return (
				<div className="flex flex-col h-full">
					{user && props.isOwnerOrMember && (
						<div className="flex flex-row items-center p-4 h-12 border-b border-gray-200">
							{props.analytics}
						</div>
					)}

					{props.children?.({ setShowAuthOverlay })}

					<AuthOverlay
						isOpen={showAuthOverlay}
						onClose={() => setShowAuthOverlay(false)}
					/>
				</div>
			);
		},
		Skeleton: (props: { isOwnerOrMember: boolean }) => (
			<Activity.Shell {...props} analytics={<CapCardAnalytics.Skeleton />}>
				{({ setShowAuthOverlay }) => (
					<Comments.Skeleton setShowAuthOverlay={setShowAuthOverlay} />
				)}
			</Activity.Shell>
		),
	},
);
