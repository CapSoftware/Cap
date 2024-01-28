"use client";

import { fetchFile } from "@ffmpeg/util";
import { useEffect, useRef, useState } from "react";
import { ShareHeader } from "./_components/ShareHeader";
import { videos } from "@cap/database/schema";
import { FFmpeg as FfmpegType } from "@ffmpeg/ffmpeg";
import { concatenateSegments } from "@/utils/video/ffmpeg/helpers";

export const Share = ({
  data,
  urls,
}: {
  data: typeof videos.$inferSelect;
  urls: {
    videoUrls: string[];
    screenUrls: string[];
    singleScreenUrl: string;
    singleVideoUrl: string;
  };
}) => {
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [screenSrc, setScreenSrc] = useState<string>("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const ffmpegRef = useRef<FfmpegType | null>(null);

  useEffect(() => {
    const loadFfmpeg = async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      ffmpegRef.current = new FFmpeg();
      setFfmpegLoaded(true);
    };

    if (!ffmpegLoaded && !ffmpegRef.current) {
      loadFfmpeg();
    }
  }, [ffmpegLoaded]);

  useEffect(() => {
    const loadVideos = async () => {
      setLoading(true);
      try {
        console.log("urls", urls);

        if (urls.singleVideoUrl) {
          setVideoSrc(urls.singleVideoUrl);
        }

        if (urls.singleScreenUrl) {
          setScreenSrc(urls.singleScreenUrl);
        }

        if (urls.videoUrls.length > 0 && ffmpegRef.current) {
          const concatenatedVideoData = await concatenateSegments(
            ffmpegRef.current,
            urls.videoUrls,
            data.id,
            "video_output.mp4",
            "webm",
            "mp4"
          );
          setVideoSrc(
            URL.createObjectURL(
              new Blob([concatenatedVideoData], { type: "video/mp4" })
            )
          );
        }

        if (urls.screenUrls.length > 0 && ffmpegRef.current) {
          const concatenatedScreenData = await concatenateSegments(
            ffmpegRef.current,
            urls.screenUrls,
            data.id,
            "screen_output.mp4",
            "mkv",
            "mp4"
          );
          setScreenSrc(
            URL.createObjectURL(
              new Blob([concatenatedScreenData], { type: "video/mp4" })
            )
          );
        }
      } catch (error) {
        console.error("Error loading videos", error);
        // Handle video loading error if desired
      } finally {
        setLoading(false); // End loading process
      }
    };

    loadVideos();
  }, [urls, ffmpegLoaded]);

  return (
    <div className="wrapper py-6">
      <div className="space-y-8">
        <ShareHeader title={data.name} />
        <div>
          {loading ? (
            <p>Loading</p>
          ) : (
            <div className="aspect-video relative bg-gradient-to-b from-secondary to-secondary-3 p-10 flex items-center justify-center rounded-lg">
              {videoSrc && (
                <div className="absolute bottom-2 right-2 w-[180px] h-[180px] m-0 p-0 rounded-full overflow-hidden z-10 shadow-[0px 0px 200px rgba(0,0,0,0.18)] border-2 border-white">
                  <video
                    ref={videoRef}
                    className="w-full h-full object-cover"
                    controls
                    src={videoSrc}
                  />
                </div>
              )}
              {screenSrc && (
                <video
                  className="rounded-lg"
                  ref={screenRef}
                  controls
                  src={screenSrc}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
