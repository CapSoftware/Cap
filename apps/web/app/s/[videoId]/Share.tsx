"use client";

import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { getVideoStatus, VideoStatusResult } from "@/actions/videos/get-status";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { ShareVideo } from "./_components/ShareVideo";
import { Sidebar } from "./_components/Sidebar";
import { Toolbar } from "./_components/Toolbar";

const formatTime = (time: number) => {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
};

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
  authorName: string | null;
};

type VideoWithOrganizationInfo = typeof videos.$inferSelect & {
  organizationMembers?: string[];
  organizationId?: string;
  sharedOrganizations?: { id: string; name: string }[];
  hasPassword?: boolean;
};

interface ShareProps {
  data: VideoWithOrganizationInfo;
  user: typeof userSelectProps | null;
  comments: MaybePromise<CommentWithAuthor[]>;
  views: MaybePromise<number>;
  customDomain: string | null;
  domainVerified: boolean;
  userOrganizations?: { id: string; name: string }[];
  initialAiData?: {
    title?: string | null;
    summary?: string | null;
    chapters?: { title: string; start: number }[] | null;
    processing?: boolean;
  } | null;
  aiGenerationEnabled: boolean;
}

const useVideoStatus = (
  videoId: string,
  aiGenerationEnabled: boolean,
  initialData?: {
    transcriptionStatus?: string | null;
    aiData?: {
      title?: string | null;
      summary?: string | null;
      chapters?: { title: string; start: number }[] | null;
      processing?: boolean;
    } | null;
  }
) => {
  return useQuery({
    queryKey: ["videoStatus", videoId],
    queryFn: async (): Promise<VideoStatusResult> => {
      return await getVideoStatus(videoId);
    },
    initialData: initialData
      ? {
        transcriptionStatus: initialData.transcriptionStatus as
          | "PROCESSING"
          | "COMPLETE"
          | "ERROR"
          | null,
        aiProcessing: initialData.aiData?.processing || false,
        aiTitle: initialData.aiData?.title || null,
        summary: initialData.aiData?.summary || null,
        chapters: initialData.aiData?.chapters || null,
        generationError: null,
      }
      : undefined,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;

      const shouldContinuePolling = () => {
        if (
          !data.transcriptionStatus ||
          data.transcriptionStatus === "PROCESSING"
        ) {
          return true;
        }

        if (data.transcriptionStatus === "ERROR") {
          return false;
        }

        if (data.transcriptionStatus === "COMPLETE") {
          if (!aiGenerationEnabled) {
            return false;
          }

          if (data.aiProcessing) {
            return true;
          }

          if (!data.summary && !data.chapters) {
            return true;
          }

          return false;
        }

        return false;
      };

      return shouldContinuePolling() ? 2000 : false;
    },
    refetchIntervalInBackground: false,
    staleTime: 1000,
  });
};

const useVideoAnalytics = (videoId: string, initialCount: number) => {
  return useQuery({
    queryKey: ["videoAnalytics", videoId],
    queryFn: async () => {
      const result = await getVideoAnalytics(videoId);
      return result.count || 0;
    },
    initialData: initialCount,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
};

export const Share = ({
  data,
  user,
  comments,
  views,
  initialAiData,
  aiGenerationEnabled,
}: ShareProps) => {
  const effectiveDate: Date = data.metadata?.customCreatedAt
    ? new Date(data.metadata.customCreatedAt)
    : data.createdAt;

  const playerRef = useRef<HTMLVideoElement | null>(null);

  const { data: videoStatus } = useVideoStatus(data.id, aiGenerationEnabled, {
    transcriptionStatus: data.transcriptionStatus,
    aiData: initialAiData,
  });

  const transcriptionStatus =
    videoStatus?.transcriptionStatus || data.transcriptionStatus;

  const aiData = useMemo(
    () => ({
      title: videoStatus?.aiTitle || null,
      summary: videoStatus?.summary || null,
      chapters: videoStatus?.chapters || null,
      processing: videoStatus?.aiProcessing || false,
      generationError: videoStatus?.generationError || null,
    }),
    [videoStatus]
  );

  const shouldShowLoading = () => {
    if (!aiGenerationEnabled) {
      return false;
    }

    if (!transcriptionStatus || transcriptionStatus === "PROCESSING") {
      return true;
    }

    if (transcriptionStatus === "ERROR") {
      return false;
    }

    if (transcriptionStatus === "COMPLETE") {
      if (aiData.generationError) {
        return false;
      }
      if (aiData.processing === true) {
        return true;
      }
      if (!aiData.summary && !aiData.chapters) {
        return true;
      }
    }

    return false;
  };

  const aiLoading = shouldShowLoading();

  const handleSeek = (time: number) => {
    if (playerRef.current) {
      playerRef.current.currentTime = time;
    }
  };

  return (
    <div className="mt-4">
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex-1">
          <div className="relative p-3 aspect-video new-card-style">
            <ShareVideo
              data={{ ...data, transcriptionStatus }}
              user={user}
              comments={comments}
              chapters={aiData?.chapters || []}
              aiProcessing={aiData?.processing || false}
              ref={playerRef}
            />
          </div>
          <div className="mt-4 lg:hidden">
            <Toolbar data={data} user={user} />
          </div>
        </div>

        <div className="flex flex-col lg:w-80">
          <Sidebar
            data={{
              ...data,
              createdAt: effectiveDate,
              transcriptionStatus,
            }}
            user={user}
            comments={comments}
            views={views}
            onSeek={handleSeek}
            videoId={data.id}
            aiData={aiData}
            aiGenerationEnabled={aiGenerationEnabled}
          />
        </div>
      </div>

      <div className="hidden mt-4 lg:block">
        <Toolbar data={data} user={user} />
      </div>

      <div className="hidden mt-4 lg:block">
        {aiLoading &&
          (transcriptionStatus === "PROCESSING" ||
            transcriptionStatus === "COMPLETE") && (
            <div className="p-4 animate-pulse new-card-style">
              <div className="space-y-6">
                <div>
                  <div className="mb-3 w-24 h-6 bg-gray-200 rounded"></div>
                  <div className="mb-4 w-32 h-3 bg-gray-100 rounded"></div>
                  <div className="space-y-3">
                    <div className="w-full h-4 bg-gray-200 rounded"></div>
                    <div className="w-5/6 h-4 bg-gray-200 rounded"></div>
                    <div className="w-4/5 h-4 bg-gray-200 rounded"></div>
                    <div className="w-full h-4 bg-gray-200 rounded"></div>
                    <div className="w-3/4 h-4 bg-gray-200 rounded"></div>
                  </div>
                </div>

                <div>
                  <div className="mb-4 w-24 h-6 bg-gray-200 rounded"></div>
                  <div className="space-y-2">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="flex items-center p-2">
                        <div className="mr-3 w-12 h-4 bg-gray-200 rounded"></div>
                        <div className="flex-1 h-4 bg-gray-200 rounded"></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

        {!aiLoading &&
          (aiData?.summary ||
            (aiData?.chapters && aiData.chapters.length > 0)) && (
            <div className="p-4 new-card-style">
              {aiData?.summary && (
                <>
                  <h3 className="text-lg font-medium">Summary</h3>
                  <div className="mb-2">
                    <span className="text-xs font-semibold text-gray-8">
                      Generated by Cap AI
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">
                    {aiData.summary}
                  </p>
                </>
              )}

              {aiData?.chapters && aiData.chapters.length > 0 && (
                <div className={aiData?.summary ? "mt-6" : ""}>
                  <h3 className="mb-2 text-lg font-medium">Chapters</h3>
                  <div className="divide-y">
                    {aiData.chapters.map((chapter) => (
                      <div
                        key={chapter.start}
                        className="flex items-center p-2 rounded transition-colors cursor-pointer hover:bg-gray-100"
                        onClick={() => handleSeek(chapter.start)}
                      >
                        <span className="w-16 text-xs text-gray-500">
                          {formatTime(chapter.start)}
                        </span>
                        <span className="ml-2 text-sm">{chapter.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
      </div>
    </div>
  );
};
