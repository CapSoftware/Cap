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
};

interface ShareProps {
  data: VideoWithOrganizationInfo;
  user: typeof userSelectProps | null;
  comments: CommentWithAuthor[];
  initialAnalytics: {
    views: number;
    comments: number;
    reactions: number;
  };
  customDomain: string | null;
  domainVerified: boolean;
  userOrganizations?: { id: string; name: string }[];
  initialAiData?: {
    title?: string | null;
    summary?: string | null;
    chapters?: { title: string; start: number }[] | null;
    processing?: boolean;
  } | null;
}

export const Share: React.FC<ShareProps> = ({
  data,
  user,
  comments,
  initialAnalytics,
  customDomain,
  domainVerified,
  userOrganizations = [],
  initialAiData,
}) => {
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const effectiveDate: Date = data.metadata?.customCreatedAt
    ? new Date(data.metadata.customCreatedAt)
    : data.createdAt;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [transcriptionStatus, setTranscriptionStatus] = useState<string | null>(
    data.transcriptionStatus || null
  );

  useEffect(() => {
    if (initialAiData) {
      console.log("[Share] Received initial AI data:", {
        hasTitle: !!initialAiData.title,
        hasSummary: !!initialAiData.summary,
        hasChapters: !!initialAiData.chapters,
        chaptersCount: initialAiData.chapters?.length || 0,
      });
    } else {
      console.log("[Share] No initial AI data provided");
    }
  }, [initialAiData]);

  const [aiData, setAiData] = useState<{
    title?: string | null;
    summary?: string | null;
    chapters?: { title: string; start: number }[] | null;
    processing?: boolean;
  } | null>(initialAiData || null);

  const shouldShowLoading = () => {
    if (!transcriptionStatus || transcriptionStatus === "PROCESSING") {
      return true;
    }

    if (transcriptionStatus === "COMPLETE") {
      if (!initialAiData || initialAiData.processing === true) {
        return true;
      }
      if (!initialAiData.summary && !initialAiData.chapters) {
        return true;
      }
    }

    return false;
  };

  const [aiLoading, setAiLoading] = useState(shouldShowLoading());

  const aiDataRef = useRef(aiData);
  useEffect(() => {
    aiDataRef.current = aiData;
  }, [aiData]);

  useEffect(() => {
    let active = true;
    let pollInterval: NodeJS.Timeout | null = null;
    let pollCount = 0;
    const MAX_POLLS = 300;
    const POLL_INTERVAL = 2000;

    const shouldPoll = () => {
      if (pollCount >= MAX_POLLS) {
        console.log("[Share] Max polling count reached, stopping");
        return false;
      }

      if (!transcriptionStatus || transcriptionStatus === "PROCESSING") {
        return true;
      }

      if (transcriptionStatus === "ERROR") {
        return false;
      }

      if (transcriptionStatus === "COMPLETE") {
        const currentAiData = aiDataRef.current;

        if (!currentAiData || currentAiData.processing) {
          return true;
        }

        if (!currentAiData.summary && !currentAiData.chapters) {
          return true;
        }

        return false;
      }

      return false;
    };

    const pollStatus = async () => {
      if (!active) return;

      pollCount++;
      console.log(
        `[Share] Polling attempt ${pollCount}/${MAX_POLLS} for video ${data.id}`,
        {
          transcriptionStatus,
          currentAiData: aiDataRef.current,
        }
      );

      try {
        const res = await fetch(`/api/video/status?videoId=${data.id}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const json = await res.json();

        if (!active) return;

        console.log(`[Share] Poll response:`, json);

        if (
          json.transcriptionStatus &&
          json.transcriptionStatus !== transcriptionStatus
        ) {
          console.log(
            `[Share] Transcription status changed: ${transcriptionStatus} -> ${json.transcriptionStatus}`
          );
          setTranscriptionStatus(json.transcriptionStatus);
        }

        const hasAiData = json.summary || json.chapters || json.aiTitle;
        if (hasAiData) {
          console.log(`[Share] Received AI data, updating state`);
          const newAiData = {
            title: json.aiTitle || null,
            summary: json.summary || null,
            chapters: json.chapters || null,
            processing: json.aiProcessing || false,
          };
          setAiData(newAiData);
          setAiLoading(json.aiProcessing || false);
        } else if (json.aiProcessing) {
          console.log(`[Share] AI processing in progress`);
          setAiData((prev) => ({ ...prev, processing: true }));
          setAiLoading(true);
        } else if (
          json.transcriptionStatus === "COMPLETE" &&
          !json.aiProcessing
        ) {
          console.log(
            `[Share] Transcription complete but no AI processing yet`
          );
          setAiData((prev) => ({ ...prev, processing: false }));
        }

        if (!shouldPoll()) {
          console.log("[Share] Stopping polling - conditions met");
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          setAiLoading(false);
        }
      } catch (err) {
        console.error("[Share] Error polling video status:", err);
      }
    };

    console.log("[Share] Evaluating whether to start polling:", {
      transcriptionStatus,
      aiData: aiDataRef.current,
      shouldPoll: shouldPoll(),
    });

    if (shouldPoll()) {
      console.log("[Share] Starting polling for video status");

      pollStatus();

      pollInterval = setInterval(pollStatus, POLL_INTERVAL);
    } else {
      console.log("[Share] Not starting polling, conditions already met");
      setAiLoading(false);
    }

    return () => {
      console.log("[Share] Cleaning up polling");
      active = false;
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [data.id, transcriptionStatus]);

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

  const headerData =
    aiData && aiData.title && !aiData.processing
      ? { ...data, name: aiData.title, createdAt: effectiveDate }
      : { ...data, createdAt: effectiveDate };

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA]">
      <div className="container flex-1 px-4 py-4 mx-auto">
        <ShareHeader
          data={headerData}
          user={user}
          customDomain={customDomain}
          domainVerified={domainVerified}
          sharedOrganizations={data.sharedOrganizations || []}
          userOrganizations={userOrganizations}
        />

        <div className="mt-4">
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex-1">
              <div className="overflow-hidden relative p-3 aspect-video new-card-style">
                <ShareVideo
                  data={{ ...data, transcriptionStatus }}
                  user={user}
                  comments={comments}
                  chapters={aiData?.chapters || []}
                  aiProcessing={aiData?.processing || false}
                  ref={videoRef}
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
                analytics={analytics}
                onSeek={handleSeek}
                videoId={data.id}
                aiData={aiData}
              />
            </div>
          </div>

          <div className="hidden mt-4 lg:block">
            <Toolbar data={data} user={user} />
          </div>

          <div className="mt-4 hidden lg:block">
            {aiLoading &&
              (transcriptionStatus === "PROCESSING" ||
                transcriptionStatus === "COMPLETE") && (
                <div className="p-4 new-card-style animate-pulse">
                  <div className="space-y-6">
                    <div>
                      <div className="h-6 w-24 bg-gray-200 rounded mb-3"></div>
                      <div className="h-3 w-32 bg-gray-100 rounded mb-4"></div>
                      <div className="space-y-3">
                        <div className="h-4 bg-gray-200 rounded w-full"></div>
                        <div className="h-4 bg-gray-200 rounded w-5/6"></div>
                        <div className="h-4 bg-gray-200 rounded w-4/5"></div>
                        <div className="h-4 bg-gray-200 rounded w-full"></div>
                        <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                      </div>
                    </div>

                    <div>
                      <div className="h-6 w-24 bg-gray-200 rounded mb-4"></div>
                      <div className="space-y-2">
                        {[1, 2, 3, 4].map((i) => (
                          <div key={i} className="flex items-center p-2">
                            <div className="h-4 w-12 bg-gray-200 rounded mr-3"></div>
                            <div className="h-4 bg-gray-200 rounded flex-1"></div>
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
                            className="p-2 cursor-pointer hover:bg-gray-100 rounded transition-colors flex items-center"
                            onClick={() => handleSeek(chapter.start)}
                          >
                            <span className="text-xs text-gray-500 w-16">
                              {formatTime(chapter.start)}
                            </span>
                            <span className="ml-2 text-sm">
                              {chapter.title}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
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
