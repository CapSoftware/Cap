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
import { VideoPlayer } from "./VideoPlayer";
import { useQuery } from "@tanstack/react-query";
import VideoJS from "./VideoJs";
import { forwardRef, useImperativeHandle, useRef, useState, useEffect } from "react";

declare global {
  interface Window {
    MSStream: any;
  }
}

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
  authorName: string | null;
};

export const ShareVideo = forwardRef<
  HTMLVideoElement,
  {
    data: typeof videos.$inferSelect;
    user: typeof userSelectProps | null;
    comments: MaybePromise<CommentWithAuthor[]>;
    chapters?: { title: string; start: number }[];
    aiProcessing?: boolean;
  }
>(({ data, user, comments, chapters = [], aiProcessing = false }, ref) => {
  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoMetadataLoaded, setVideoMetadataLoaded] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);

  const playerRef = useRef(null);

  const handlePlayerReady = (player: any) => {
    playerRef.current = player;

    // You can handle player events here, for example:
    player.on("waiting", () => {
      console.log("player is waiting");
    });

    player.on("dispose", () => {
      console.log("player will dispose");
    });
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

  if (data.source.type === "desktopMP4") {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=mp4`;
  } else if (
    NODE_ENV === "development" ||
    ((data.skipProcessing === true || data.jobStatus !== "COMPLETE") &&
      data.source.type === "MediaConvert")
  ) {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=master`;
  } else if (data.source.type === "MediaConvert") {
    videoSrc = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/output/video_recording_000.m3u8`;
  } else {
    videoSrc = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/combined-source/stream.m3u8`;
  }


  return (
    <>
      <div className="relative w-full h-full rounded-xl">
        {data.source.type === "desktopMP4" ? (
          <VideoJS
            onReady={handlePlayerReady}
            options={{
              autoplay: true,
              controls: true,
              responsive: true,
              fluid: true,
              sources: [
                {
                  src: videoSrc,
                  type: "video/mp4",
                },
              ],
            }}

          />
        ) : (
          <VideoPlayer ref={videoRef} videoSrc={videoSrc} />
        )}
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

