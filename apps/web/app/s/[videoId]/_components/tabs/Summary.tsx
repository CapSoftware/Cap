"use client";

import { useEffect, useState } from "react";
import { userSelectProps } from "@cap/database/auth/session";
import { userIsPro } from "@cap/utils";
import { Button } from "@cap/ui";

interface Chapter {
  title: string;
  start: number;
}

interface SummaryProps {
  videoId: string;
  onSeek?: (time: number) => void;
  initialAiData?: {
    title?: string | null;
    summary?: string | null;
    chapters?: Chapter[] | null;
    processing?: boolean;
  };
  aiGenerationEnabled?: boolean;
  user: typeof userSelectProps | null;
}

const formatTime = (time: number) => {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
};

const SkeletonLoader = () => (
  <div className="p-4 space-y-6 animate-pulse">
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
);

export const Summary: React.FC<SummaryProps> = ({
  onSeek,
  initialAiData,
  aiGenerationEnabled = false,
  user,
}) => {
  const [aiData, setAiData] = useState<{
    title?: string | null;
    summary?: string | null;
    chapters?: Chapter[] | null;
    processing?: boolean;
  } | null>(initialAiData || null);
  const [isLoading, setIsLoading] = useState(
    aiGenerationEnabled && (!initialAiData || initialAiData.processing === true)
  );

  useEffect(() => {
    if (initialAiData) {
      setAiData(initialAiData);
      setIsLoading(aiGenerationEnabled && initialAiData.processing === true);
    } else {
      setIsLoading(aiGenerationEnabled);
    }
  }, [initialAiData, aiGenerationEnabled]);

  const handleSeek = (time: number) => {
    if (onSeek) {
      onSeek(time);
    }
  };

  const hasProAccess = userIsPro(user);

  const hasExistingAiData =
    aiData?.summary || (aiData?.chapters && aiData.chapters.length > 0);

  if (!hasProAccess && !hasExistingAiData) {
    return (
      <div className="flex flex-col justify-center items-center p-8 h-full text-center">
        <div className="space-y-4 max-w-sm">
          <div className="bg-gradient-to-br from-blue-50 to-purple-50 p-6 rounded-lg border border-blue-100">
            <div className="text-blue-600 mb-3">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mx-auto w-12 h-12"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Unlock Cap AI
            </h3>
            <p className="text-sm text-gray-600 mb-4 leading-relaxed">
              Upgrade to Cap Pro to access AI-powered features including
              automatic titles, video summaries, and intelligent chapter
              generation.
            </p>
            <Button
              href="/pricing"
              variant="primary"
              size="sm"
              className="mx-auto"
            >
              Upgrade to Cap Pro
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || aiData?.processing) {
    return (
      <div className="flex flex-col h-full">
        <div className="overflow-y-auto flex-1">
          <SkeletonLoader />
        </div>
      </div>
    );
  }

  if (!aiData?.summary && (!aiData?.chapters || aiData.chapters.length === 0)) {
    return (
      <div className="flex flex-col justify-center items-center p-8 h-full text-center">
        <div className="space-y-2 text-gray-300">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="mx-auto w-8 h-8"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="text-sm font-medium text-gray-12">
            No summary available
          </h3>
          <p className="text-sm text-gray-10">
            AI summary has not been generated for this video yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="overflow-y-auto flex-1">
        <div className="p-4 space-y-6">
          {aiData?.summary && (
            <div>
              <h3 className="text-lg font-medium">Summary</h3>
              <div className="mb-2">
                <span className="text-xs font-semibold text-gray-8">
                  Generated by Cap AI
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap text-gray-12">
                {aiData.summary}
              </p>
            </div>
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
                    <span className="ml-2 text-sm">{chapter.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
