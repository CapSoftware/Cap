import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";
import { useApiClient } from "@/utils/web-api";
import { useTranscript } from "hooks/use-transcript";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo } from "@cap/ui";
import { isUserOnProPlan } from "@cap/utils";
import { fromVtt, Subtitle } from "subtitles-parser-vtt";
import { VideoJS } from "./VideoJs";
import { useQuery } from "@tanstack/react-query";
import { forwardRef, useImperativeHandle, useRef, useState, useEffect, useMemo } from "react";
import Player from "video.js/dist/types/player";
import { formatTranscriptAsVTT } from "./utils/transcript-utils";

declare global {
  interface Window {
    MSStream: any;
  }
}

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
  authorName: string | null;
};

export const ShareVideo = forwardRef<
  Player,
  {
    data: typeof videos.$inferSelect;
    user: typeof userSelectProps | null;
    comments: MaybePromise<CommentWithAuthor[]>;
    chapters?: { title: string; start: number }[];
    aiProcessing?: boolean;
  }
>(({ data, user, comments, chapters = [], aiProcessing = false }, ref) => {
  useImperativeHandle(ref, () => playerRef.current as Player);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoMetadataLoaded, setVideoMetadataLoaded] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);

  const playerRef = useRef<Player | null>(null);

  const handlePlayerReady = (player: Player) => {
    playerRef.current = player;
  };

  const isLargeScreen = useScreenSize();

  // Use TanStack Query for video source validation
  const { data: videoSourceData } = useVideoSourceValidation(
    data,
    videoMetadataLoaded
  );

  const publicEnv = usePublicEnv();
  const apiClient = useApiClient();

  const { data: transcriptContent, error: transcriptError } = useTranscript(
    data.id,
    data.transcriptionStatus
  );

  let videoSrc: string;
  let videoType: string = "video/mp4";

  if (data.source.type === "desktopMP4") {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=mp4`;
    videoType = "video/mp4";
  } else if (
    NODE_ENV === "development" ||
    ((data.skipProcessing === true || data.jobStatus !== "COMPLETE") &&
      data.source.type === "MediaConvert")
  ) {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=master`;
    videoType = "application/x-mpegURL";
  } else if (data.source.type === "MediaConvert") {
    videoSrc = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/output/video_recording_000.m3u8`;
    videoType = "application/x-mpegURL";
  } else {
    videoSrc = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/combined-source/stream.m3u8`;
    videoType = "application/x-mpegURL";
  }

  // Create a Blob URL for the transcript VTT content
  useEffect(() => {
    if (transcriptContent) {
      try {
        // Parse the transcript content to get the entries
        const parsedEntries = fromVtt(transcriptContent);

        // Format the entries as VTT
        const vttContent = formatTranscriptAsVTT(
          parsedEntries.map((entry, index) => ({
            id: index + 1,
            timestamp: entry.startTime,
            text: entry.text,
            startTime: parseFloat(entry.startTime)
          }))
        );

        // Create a Blob URL
        const blob = new Blob([vttContent], { type: 'text/vtt' });
        const url = URL.createObjectURL(blob);

        setSubtitleUrl(url);

        // Clean up the URL when component unmounts
        return () => {
          URL.revokeObjectURL(url);
        };
      } catch (error) {
        console.error("Error creating subtitle URL:", error);
      }
    }
  }, [transcriptContent]);

  const videoJsOptions = useMemo(() => ({
    autoplay: true,
    playbackRates: [0.5, 1, 1.5, 2],
    controls: true,
    responsive: true,
    fluid: false,
    tracks: subtitleUrl ? [
      {
        kind: "subtitles",
        src: subtitleUrl,
        srclang: "en",
        label: "English",
        default: true
      },
    ] : [],
    sources: [
      { src: videoSrc, type: videoType },
    ]
  }), [videoSrc, videoType, subtitleUrl]);

  return (
    <>
      <div className="relative w-full h-full rounded-xl">
        <VideoJS
          onReady={handlePlayerReady}
          options={videoJsOptions}
          ref={ref}
        />
      </div>

      {user &&
        !isUserOnProPlan({
          subscriptionStatus: user.stripeSubscriptionStatus,
        }) && (
          <div className="absolute top-4 left-4 z-30">
            <div
              className="block cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setUpgradeModalOpen(true);
              }}
            >
              <div className="relative">
                <div className="opacity-50 transition-opacity hover:opacity-100 peer">
                  <Logo className="w-auto h-4 sm:h-8" white={true} />
                </div>

                <div className="absolute left-0 top-8 transition-transform duration-300 ease-in-out origin-top scale-y-0 peer-hover:scale-y-100">
                  <p className="text-white text-xs font-medium whitespace-nowrap bg-black bg-opacity-50 px-2 py-0.5 rounded">
                    Remove watermark
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
      />
    </>
  );
});

// Custom hook for video source validation using TanStack Query
const useVideoSourceValidation = (
  data: typeof videos.$inferSelect,
  videoMetadataLoaded: boolean
) => {
  return useQuery({
    queryKey: ["video-source-validation", data.id, data.source.type],
    queryFn: async () => {
      if (data.source.type !== "desktopMP4") {
        return { isMP4Source: false };
      }

      const thumbUrl = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&thumbnailTime=0`;

      try {
        const response = await fetch(thumbUrl, { method: "HEAD" });
        return { isMP4Source: response.ok };
      } catch (error) {
        console.error("Error checking thumbnails:", error);
        return { isMP4Source: false };
      }
    },
    enabled: videoMetadataLoaded && data.source.type === "desktopMP4",
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

// Custom hook for screen size detection
const useScreenSize = () => {
  const [isLargeScreen, setIsLargeScreen] = useState(false);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsLargeScreen(window.innerWidth >= 1024);
    };

    checkScreenSize();
    window.addEventListener("resize", checkScreenSize);

    return () => window.removeEventListener("resize", checkScreenSize);
  }, []);

  return isLargeScreen;
};

// Custom hook for transcription processing
const useTranscriptionProcessing = (
  data: typeof videos.$inferSelect,
  transcriptContent: string | undefined,
  transcriptError: any
) => {
  const [isTranscriptionProcessing, setIsTranscriptionProcessing] = useState(
    data.transcriptionStatus === "PROCESSING"
  );
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);

  useEffect(() => {
    if (!transcriptContent && data.transcriptionStatus === "PROCESSING") {
      return setIsTranscriptionProcessing(false);
    }
    if (transcriptContent) {
      const parsedSubtitles = fromVtt(transcriptContent);
      setSubtitles(parsedSubtitles);
      setIsTranscriptionProcessing(false);
    } else if (transcriptError) {
      console.error(
        "[ShareVideo] Subtitle error from React Query:",
        transcriptError.message
      );
      if (transcriptError.message === "TRANSCRIPT_NOT_READY") {
        setIsTranscriptionProcessing(true);
      } else {
        setIsTranscriptionProcessing(false);
      }
    } else if (data.transcriptionStatus === "PROCESSING") {
      setIsTranscriptionProcessing(true);
    } else if (data.transcriptionStatus === "ERROR") {
      setIsTranscriptionProcessing(false);
    }
  }, [transcriptContent, transcriptError, data.transcriptionStatus]);

  return { isTranscriptionProcessing, subtitles };
};
