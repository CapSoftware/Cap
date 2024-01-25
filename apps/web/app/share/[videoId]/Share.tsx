"use client";

import { fetchFile } from "@ffmpeg/util";
import { useEffect, useRef, useState } from "react";
import { ShareHeader } from "./_components/ShareHeader";
import { videos } from "@cap/database/schema";
import { FFmpeg as FfmpegType } from "@ffmpeg/ffmpeg";

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

  const concatenateSegments = async (
    ffmpeg: FfmpegType,
    segmentsUrls: string[],
    outputFilename: string,
    inputFormat: string,
    outputFormat: string
  ) => {
    if (!ffmpegRef.current) {
      throw new Error("FFmpeg not loaded");
    }

    console.log("concatenateSegments:", segmentsUrls);

    await ffmpegRef.current.load();

    // Feed the video segments to FFmpeg
    for (let i = 0; i < segmentsUrls.length; i++) {
      console.log("Fetching file...");
      const fetchedFile = await fetchFile(segmentsUrls[i]);
      ffmpeg.writeFile(`file${i}.${inputFormat}`, fetchedFile);
    }

    // Create a file with all the file names
    const fileList = "file_list.txt";
    const concatList = segmentsUrls
      .map((url, index) => `file file${index}.${inputFormat}`)
      .join("\n");
    ffmpeg.writeFile(fileList, concatList);

    console.log("Concatenating using ffmpeg script...");

    await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      fileList,
      "-r",
      `${outputFilename === "video_output.mp4" ? 30 : 60}`,
      "-c",
      "copy",
      outputFilename,
    ]);

    // Read the resulting file
    const data = ffmpeg.readFile(outputFilename);

    // Convert the data to a Blob
    // const videoBlob = new Blob([data.buffer], { type: `video/${outputFormat}` });

    // // Create a URL for the Blob
    // const videoUrl = URL.createObjectURL(videoBlob);

    // Return the URL to the MP4 on S3
    return data;
  };

  useEffect(() => {
    const loadVideos = async () => {
      setLoading(true);
      try {
        if (urls.videoUrls.length > 0 && ffmpegRef.current) {
          const concatenatedVideoData = await concatenateSegments(
            ffmpegRef.current,
            urls.videoUrls,
            "video_output.mp4",
            "webm",
            "mp4"
          );
          setVideoSrc(
            URL.createObjectURL(
              new Blob([concatenatedVideoData], { type: "video/mp4" })
            )
          );
        } else if (urls.singleVideoUrl) {
          setVideoSrc(urls.singleVideoUrl);
        }

        if (urls.screenUrls.length > 0 && ffmpegRef.current) {
          const concatenatedScreenData = await concatenateSegments(
            ffmpegRef.current,
            urls.screenUrls,
            "screen_output.mp4",
            "mkv",
            "mp4"
          );
          setScreenSrc(
            URL.createObjectURL(
              new Blob([concatenatedScreenData], { type: "video/mp4" })
            )
          );
        } else if (urls.singleScreenUrl) {
          setScreenSrc(urls.singleScreenUrl);
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
        <div className="aspect-video">
          {loading ? (
            <p>Loading</p>
          ) : (
            <>
              {screenSrc && (
                <div className="absolute bottom-2 right-0 w-[180px] h-[180px] m-0 p-0 rounded-full overflow-hidden">
                  <video
                    ref={screenRef}
                    className="w-full h-full object-cover"
                    controls
                    src={screenSrc}
                  />
                </div>
              )}
              {videoSrc && <video ref={videoRef} controls src={videoSrc} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
