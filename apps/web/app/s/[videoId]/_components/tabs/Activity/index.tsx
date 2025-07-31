"use client";

import { CapCardAnalytics } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";
import { userSelectProps } from "@cap/database/auth/session";
import React, { Suspense, useState, forwardRef } from "react";

import { AuthOverlay } from "../../AuthOverlay";
import { CommentType } from "../../../Share";
import Analytics from "./Analytics";
import { Comments } from "./Comments";


interface ActivityProps {
  views: MaybePromise<number>;
  comments: CommentType[];
  setComments: React.Dispatch<React.SetStateAction<CommentType[]>>;
  user: typeof userSelectProps | null;
  onSeek?: (time: number) => void;
  handleCommentSuccess: (comment: CommentType) => void;
  videoId: string;
  optimisticComments: CommentType[];
  setOptimisticComments: (newComment: CommentType) => void;
  isOwnerOrMember: boolean;
}

export const Activity = Object.assign(
  forwardRef<{ scrollToBottom: () => void }, ActivityProps>(
    ({ user, videoId, isOwnerOrMember, comments, handleCommentSuccess, optimisticComments, setOptimisticComments, setComments, ...props }, ref) => {

      return (
        <Activity.Shell
          analytics={
            <Suspense fallback={<CapCardAnalytics.Skeleton />}>
              <Analytics
                videoId={videoId}
                views={props.views}
                comments={comments}
              />
            </Suspense>
          }
          user={user}
          isOwnerOrMember={isOwnerOrMember}
        >
          {({ setShowAuthOverlay }) => (
            <Comments
              ref={ref}
              handleCommentSuccess={handleCommentSuccess}
              optimisticComments={optimisticComments}
              setOptimisticComments={setOptimisticComments}
              setComments={setComments}
              user={user}
              videoId={videoId}
              setShowAuthOverlay={setShowAuthOverlay}
            />
          )}
        </Activity.Shell>
      );
    }
  ),
  {
    Shell: (props: {
      analytics?: JSX.Element;
      user: typeof userSelectProps | null;
      isOwnerOrMember: boolean;
      children?: (props: {
        setShowAuthOverlay: (show: boolean) => void;
      }) => JSX.Element;
    }) => {
      const [showAuthOverlay, setShowAuthOverlay] = useState(false);

      return (
        <div className="flex flex-col h-full">
          {props.user && props.isOwnerOrMember && (
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
    Skeleton: (props: {
      user: typeof userSelectProps | null;
      isOwnerOrMember: boolean;
    }) => (
      <Activity.Shell {...props} analytics={<CapCardAnalytics.Skeleton />}>
        {({ setShowAuthOverlay }) => (
          <Comments.Skeleton
            setShowAuthOverlay={setShowAuthOverlay}
            user={props.user}
          />
        )}
      </Activity.Shell>
    ),
  }
);
