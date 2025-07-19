import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo } from "@cap/ui";
import { isUserOnProPlan } from "@cap/utils";
import { forwardRef, useImperativeHandle, useRef, useState, useEffect } from "react";
import { formatChaptersAsVTT, formatTranscriptAsVTT, TranscriptEntry } from "./utils/transcript-utils";
import { useTranscript } from "hooks/use-transcript";
import { parseVTT } from "./utils/transcript-utils";
import { CapVideoPlayer } from "./CapVideoPlayer";

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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [transcriptData, setTranscriptData] = useState<TranscriptEntry[]>([]);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [chaptersUrl, setChaptersUrl] = useState<string | null>(null);

  const { data: transcriptContent, error: transcriptError } = useTranscript(
    data.id,
    data.transcriptionStatus
  );

  useEffect(() => {
    if (transcriptContent) {
      const parsed = parseVTT(transcriptContent);
      setTranscriptData(parsed);
    } else if (transcriptError) {
      console.error(
        "[Transcript] Transcript error from React Query:",
        transcriptError.message
      );
    }
  }, [transcriptContent, transcriptError]);

  // Handle subtitle URL creation
  useEffect(() => {
    if (data.transcriptionStatus === "COMPLETE" && transcriptData && transcriptData.length > 0) {
      const vttContent = formatTranscriptAsVTT(transcriptData);
      const blob = new Blob([vttContent], { type: "text/vtt" });
      const newUrl = URL.createObjectURL(blob);

      // Clean up previous URL
      if (subtitleUrl) {
        URL.revokeObjectURL(subtitleUrl);
      }

      setSubtitleUrl(newUrl);

      return () => {
        URL.revokeObjectURL(newUrl);
      };
    } else {
      // Clean up if no longer needed
      if (subtitleUrl) {
        URL.revokeObjectURL(subtitleUrl);
        setSubtitleUrl(null);
      }
    }
  }, [data.transcriptionStatus, transcriptData]);

  // Handle chapters URL creation
  useEffect(() => {
    if (chapters?.length > 0) {
      const vttContent = formatChaptersAsVTT(chapters);
      const blob = new Blob([vttContent], { type: "text/vtt" });
      const newUrl = URL.createObjectURL(blob);

      // Clean up previous URL
      if (chaptersUrl) {
        URL.revokeObjectURL(chaptersUrl);
      }

      setChaptersUrl(newUrl);

      return () => {
        URL.revokeObjectURL(newUrl);
      };
    } else {
      // Clean up if no longer needed
      if (chaptersUrl) {
        URL.revokeObjectURL(chaptersUrl);
        setChaptersUrl(null);
      }
    }
  }, [chapters]);

  const publicEnv = usePublicEnv();

  let videoSrc: string;
  let videoType: string = "video/mp4";
  let enableCrossOrigin = false;
  let enableThumbnails = false;

  if (data.source.type === "desktopMP4") {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=mp4`;
    // API videos: disable CORS and thumbnails due to R2 CORS issues
    enableCrossOrigin = true;
    enableThumbnails = true;
  } else if (NODE_ENV === "development") {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=master`;
    videoType = "application/x-mpegURL"
    enableThumbnails = true;
    enableCrossOrigin = true;
  } else if (
    ((data.skipProcessing === true || data.jobStatus !== "COMPLETE") &&
      data.source.type === "MediaConvert")
  ) {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=master`;
    videoType = "application/x-mpegURL";
    // API videos: disable CORS and thumbnails due to R2 CORS issues
    enableCrossOrigin = false;
    enableThumbnails = false;
  } else if (data.source.type === "MediaConvert") {
    videoSrc = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/output/video_recording_000.m3u8`;
    videoType = "application/x-mpegURL";
    // Direct S3 videos: disable CORS and thumbnails to avoid CORS errors
    enableCrossOrigin = false;
    enableThumbnails = false;
  } else {
    videoSrc = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/combined-source/stream.m3u8`;
    videoType = "application/x-mpegURL";
    // Direct S3 videos: disable CORS and thumbnails to avoid CORS errors
    enableCrossOrigin = false;
    enableThumbnails = false;
  }

  return (
    <>

      <div className="relative h-full">
        <CapVideoPlayer
          hlsVideo={videoType === "application/x-mpegURL"}
          mediaPlayerClassName="w-full h-full max-w-full max-h-full rounded-xl"
          videoSrc={videoSrc}
          chaptersSrc={chaptersUrl || ""}
          captionsSrc={subtitleUrl || ""}
          videoRef={videoRef}
          enableCrossOrigin={enableCrossOrigin}
          enableThumbnails={enableThumbnails}
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
