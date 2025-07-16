import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo } from "@cap/ui";
import { isUserOnProPlan } from "@cap/utils";
import { VideoJS } from "./VideoJs";
import { forwardRef, useImperativeHandle, useRef, useState, useMemo, useEffect } from "react";
import Player from "video.js/dist/types/player";
import { formatChaptersAsVTT, formatTranscriptAsVTT, TranscriptEntry } from "./utils/transcript-utils";
import { fromVtt, Subtitle } from "subtitles-parser-vtt";
import { useTranscript } from "hooks/use-transcript";
import { parseVTT } from "./utils/transcript-utils";

declare global {
  interface Window {
    MSStream: any;
  }
}

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
  authorName: string | null;
};

function showTooltip(index: number, cuePoint: number, videoDuration: number, chapters: { title: string; start: number }[], element: Element) {
  if (!chapters[index]) return;
  // Remove any existing tooltip first to avoid duplicates
  const existingTooltip = element.querySelector('.vjs-tooltip');
  if (existingTooltip) existingTooltip.remove();

  const tooltip = document.createElement("div");
  tooltip.className = "vjs-tooltip";
  tooltip.textContent = chapters[index].title || "";
  tooltip.style.left = `${(cuePoint / videoDuration) * 100}%`;
  element.appendChild(tooltip);
}

function hideTooltip(element: Element) {
  const tooltip = element.querySelector(".vjs-tooltip");
  if (tooltip) tooltip.remove();
}

const addMarkers = (cuePointsAra: number[], videoDuration: number, chapters: { title: string; start: number }[], playerRef: React.RefObject<Player>) => {
  const playheadWell = document.querySelector(".vjs-progress-control.vjs-control");
  if (!playheadWell) {
    console.warn("Progress control not found");
    return;
  }
  const slider = playheadWell.querySelector('.vjs-slider');
  if (!slider) {
    console.warn("Slider not found");
    return;
  }

  const existingMarkers = slider.querySelectorAll(".vjs-marker");
  existingMarkers.forEach((marker) => marker.remove());

  cuePointsAra.forEach((cuePoint, index) => {
    const elem = document.createElement("div");
    elem.className = "vjs-marker";
    elem.id = `cp${index}`;
    elem.ontouchstart = () => showTooltip(index, cuePoint, videoDuration, chapters, slider);
    elem.onmouseenter = () => showTooltip(index, cuePoint, videoDuration, chapters, slider);
    elem.onmouseleave = () => hideTooltip(slider);
    elem.ontouchend = () => hideTooltip(slider);
    elem.style.left = `${(cuePoint / videoDuration) * 100}%`;
    slider.appendChild(elem);
  });
}

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

  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [transcriptData, setTranscriptData] = useState<TranscriptEntry[]>([]);
  const [subtitleBlobUrl, setSubtitleBlobUrl] = useState<string | null>(null);
  const [chaptersBlobUrl, setChaptersBlobUrl] = useState<string | null>(null);

  const playerRef = useRef<Player | null>(null);

  const handlePlayerReady = (player: Player) => {
    playerRef.current = player;
    player.on("loadedmetadata", () => {
      const chapterStartTimesAra: number[] = [];

      const chapterTT: TextTrack[] = [].filter.call(
        player.textTracks(),
        (tt: TextTrack) => tt.kind === "chapters"
      );

      if (chapterTT.length > 0) {
        if (!chapterTT[0]) return;
        const cues = chapterTT[0].cues;
        if (cues) {
          for (let i = 0; i < cues.length; i++) {
            chapterStartTimesAra[i] = cues[i]?.startTime || 0;
          }
        }

        const videoDuration = player.duration();
        if (videoDuration) {
          addMarkers(chapterStartTimesAra, videoDuration, chapters, playerRef);
        }
      }
    });
  }

  const publicEnv = usePublicEnv();


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

  const chaptersUrl = useMemo(() => {
    if (chapters?.length > 0) {
      const vttContent = formatChaptersAsVTT(chapters);
      const blob = new Blob([vttContent], { type: "text/vtt" });
      return URL.createObjectURL(blob);
    }
    return null;
  }, [chapters]);

  const subtitleUrl = useMemo(() => {
    if (data.transcriptionStatus === "COMPLETE" && transcriptData && transcriptData.length > 0) {
      const vttContent = formatTranscriptAsVTT(transcriptData);
      const blob = new Blob([vttContent], { type: "text/vtt" });
      const newUrl = URL.createObjectURL(blob);

      return newUrl;
    }
    return null;
  }, [data.transcriptionStatus, transcriptData]);

  useEffect(() => {
    if (!playerRef.current) return;
    const tracks = playerRef.current.textTracks().tracks_;

    if (subtitleUrl && subtitleUrl !== subtitleBlobUrl) {
      if (subtitleBlobUrl) {
        URL.revokeObjectURL(subtitleBlobUrl);
      }
      setSubtitleBlobUrl(subtitleUrl);

      if (playerRef.current && subtitleUrl) {

        // subtitles
        playerRef.current.addRemoteTextTrack(
          {
            kind: "subtitles",
            srclang: "en",
            label: "English",
            src: subtitleUrl,
            default: true,
          },
          true
        );

        for (const track of tracks) {
          if (track.kind === "subtitles" && track.language === "en") {
            track.mode = "showing";
          }
        }

      }

    }

    if (chaptersUrl && chaptersUrl !== chaptersBlobUrl) {
      if (chaptersBlobUrl) {
        URL.revokeObjectURL(chaptersBlobUrl);
      }
      setChaptersBlobUrl(chaptersUrl);

      playerRef.current.addRemoteTextTrack(
        {
          kind: "chapters",
          srclang: "en",
          label: "Chapters",
          src: chaptersUrl,
        },
        true
      );

      for (const track of tracks) {
        if (track.kind === "chapters") {
          track.mode = "showing";
        }
      }
    }

    // Cleanup Blob URL on unmount or when subtitleUrl changes
    return () => {
      if (subtitleBlobUrl) {
        URL.revokeObjectURL(subtitleBlobUrl);
      }
      if (chaptersBlobUrl) {
        URL.revokeObjectURL(chaptersBlobUrl);
      }
    };
  }, [subtitleUrl, subtitleBlobUrl, chaptersUrl, chaptersBlobUrl]);

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

  const videoJsOptions = useMemo(() => ({
    autoplay: true,
    playbackRates: [0.5, 1, 1.5, 2],
    controls: true,
    responsive: true,
    fluid: false,
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
