"use client";

import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { Logo } from "@cap/ui";
import { useEffect, useRef, useState } from "react";
import { ShareHeader } from "./_components/ShareHeader";
import { ShareVideo } from "./_components/ShareVideo";
import { Sidebar } from "./_components/Sidebar";
import { Toolbar } from "./_components/Toolbar";

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
  authorName: string | null;
};

interface Analytics {
  views: number;
  comments: number;
  reactions: number;
}

type VideoWithSpaceInfo = typeof videos.$inferSelect & {
  spaceMembers?: string[];
  spaceId?: string;
  sharedSpaces?: { id: string; name: string }[];
};

interface ShareProps {
  data: VideoWithSpaceInfo;
  user: typeof userSelectProps | null;
  comments: CommentWithAuthor[];
  initialAnalytics: {
    views: number;
    comments: number;
    reactions: number;
  };
  customDomain: string | null;
  domainVerified: boolean;
  userSpaces?: { id: string; name: string }[];
}

export const Share: React.FC<ShareProps> = ({
  data,
  user,
  comments,
  initialAnalytics,
  customDomain,
  domainVerified,
  userSpaces = [],
}) => {
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const effectiveDate = data.metadata?.customCreatedAt
    ? new Date(data.metadata.customCreatedAt)
    : data.createdAt;

  const videoRef = useRef<HTMLVideoElement>(null);

  const handleSeek = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  useEffect(() => {
    const fetchViewCount = async () => {
      try {
        const result = await getVideoAnalytics(data.id);

        setAnalytics((prev) => ({
          ...prev,
          views: result.count || 0,
        }));
      } catch (error) {
        console.error("Error fetching view count:", error);
      }
    };

    fetchViewCount();
  }, [data.id]);

  useEffect(() => {
    setAnalytics((prev) => ({
      ...prev,
      comments: comments.filter((c) => c.type === "text").length,
      reactions: comments.filter((c) => c.type === "emoji").length,
    }));
  }, [comments]);

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA]">
      <div className="container flex-1 px-4 py-4 mx-auto">
        <ShareHeader
          data={{ ...data, createdAt: effectiveDate }}
          user={user}
          customDomain={customDomain}
          domainVerified={domainVerified}
          sharedSpaces={data.sharedSpaces || []}
          userSpaces={userSpaces}
        />

        <div className="mt-4">
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex-1">
              <div className="overflow-hidden relative p-3 aspect-video new-card-style">
                <ShareVideo
                  data={data}
                  user={user}
                  comments={comments}
                  ref={videoRef}
                />
              </div>
              <div className="mt-4 lg:hidden">
                <Toolbar data={data} user={user} />
              </div>
            </div>

            <div className="flex flex-col lg:w-80">
              <Sidebar
                data={{ ...data, createdAt: effectiveDate }}
                user={user}
                comments={comments}
                analytics={analytics}
                onSeek={handleSeek}
                videoId={data.id}
              />
            </div>
          </div>

          <div className="hidden mt-4 lg:block">
            <Toolbar data={data} user={user} />
          </div>
        </div>
      </div>

      <div className="py-4 mt-auto">
        <a
          target="_blank"
          href={`/?ref=video_${data.id}`}
          className="flex justify-center items-center px-4 py-2 mx-auto space-x-2 bg-gray-1 rounded-full new-card-style w-fit"
        >
          <span className="text-sm">Recorded with</span>
          <Logo className="w-14 h-auto" />
        </a>
      </div>
    </div>
  );
};
