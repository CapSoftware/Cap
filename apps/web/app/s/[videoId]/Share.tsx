"use client";

import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { clientEnv } from "@cap/env";
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
};

interface ShareProps {
  data: VideoWithSpaceInfo;
  user: typeof userSelectProps | null;
  comments: CommentWithAuthor[];
  individualFiles: {
    fileName: string;
    url: string;
  }[];
  initialAnalytics: {
    views: number;
    comments: number;
    reactions: number;
  };
  customDomain: string | null;
  domainVerified: boolean;
}

export const Share: React.FC<ShareProps> = ({
  data,
  user,
  comments,
  individualFiles,
  initialAnalytics,
  customDomain,
  domainVerified,
}) => {
  const [analytics, setAnalytics] = useState(initialAnalytics);

  const videoRef = useRef<HTMLVideoElement>(null);

  const handleSeek = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  useEffect(() => {
    const fetchViewCount = async () => {
      try {
        const response = await fetch(`/api/video/analytics?videoId=${data.id}`);
        if (!response.ok) {
          throw new Error("Failed to fetch analytics");
        }
        const viewData = await response.json();

        setAnalytics((prev) => ({
          ...prev,
          views: viewData.count || 0,
        }));
      } catch (error) {
        console.error("Error fetching view count:", error);
      }
    };

    fetchViewCount();
  }, [data.id]);

  // Update analytics when comments change
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
          data={data}
          user={user}
          individualFiles={individualFiles}
          customDomain={customDomain}
          domainVerified={domainVerified}
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
                data={data}
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
          href={`${clientEnv.NEXT_PUBLIC_WEB_URL}?ref=video_${data.id}`}
          className="flex justify-center items-center px-4 py-2 mx-auto space-x-2 bg-gray-100 rounded-full new-card-style w-fit"
        >
          <span className="text-sm">Recorded with</span>
          <Logo className="w-14 h-auto" />
        </a>
      </div>
    </div>
  );
};
