"use client";

import { ShareHeader } from "./_components/ShareHeader";
import { ShareVideo } from "./_components/ShareVideo";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";
import { Toolbar } from "./_components/Toolbar";
import { Logo } from "@cap/ui";
import { Sidebar } from "./_components/Sidebar";
import { useEffect, useState, useRef } from "react";
import { clientEnv } from "@cap/env";

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
}

export const Share: React.FC<ShareProps> = ({
  data,
  user,
  comments,
  individualFiles,
  initialAnalytics,
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
      <div className="flex-1 container mx-auto px-4 py-4">
        <ShareHeader
          data={data}
          user={user}
          individualFiles={individualFiles}
        />

        <div className="mt-4">
          <div className="flex flex-col lg:flex-row gap-4">
            <div className="flex-1">
              <div className="relative aspect-video new-card-style p-3 overflow-hidden">
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

            <div className="lg:w-80 flex flex-col">
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

          <div className="hidden lg:block mt-4">
            <Toolbar data={data} user={user} />
          </div>
        </div>
      </div>

      <div className="mt-auto py-4">
        <a
          target="_blank"
          href={`${clientEnv.NEXT_PUBLIC_WEB_URL}?ref=video_${data.id}`}
          className="flex items-center justify-center space-x-2 py-2 px-4 bg-gray-100 new-card-style rounded-full mx-auto w-fit"
        >
          <span className="text-sm">Recorded with</span>
          <Logo className="w-14 h-auto" />
        </a>
      </div>
    </div>
  );
};
