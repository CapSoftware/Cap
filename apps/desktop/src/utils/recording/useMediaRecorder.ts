import { useState, useRef, useCallback, useEffect } from "react";
import { FFmpeg as FfmpegType } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import {
  writeBinaryFile,
  writeTextFile,
  readTextFile,
  createDir,
} from "@tauri-apps/api/fs";
import { appDataDir, join } from "@tauri-apps/api/path";

export const useMediaRecorder = () => {
  const isRecording = useRef(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const ffmpegRef = useRef<FfmpegType | null>(null);
  const queue = useRef<Blob[]>([]);
  const processingQueue = useRef(false);
  const segmentCounter = useRef(0);

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

  const getVideoChunksDir = async () => {
    const dir = await appDataDir();
    return join(dir, "chunks", "video");
  };

  const appendToSegmentListFile = async (fileName: string) => {
    const dir = await getVideoChunksDir();
    const segmentListPath = await join(dir, "segment_list.txt");

    let fileContent;
    try {
      fileContent = await readTextFile(segmentListPath);
    } catch (error) {
      fileContent = "";
    }

    const newContent = `${fileContent}${fileName}\n`;
    await writeTextFile(segmentListPath, newContent);
  };

  const saveFile = async (
    data: Uint8Array,
    fileName: string,
    screenshot: boolean
  ) => {
    try {
      const dir =
        screenshot === false ? await getVideoChunksDir() : await appDataDir();
      await createDir(dir, { recursive: true });
      const filePath = await join(dir, fileName);
      await writeBinaryFile(filePath, data);
      if (screenshot === false) {
        await appendToSegmentListFile(fileName);
      }
    } catch (error) {
      console.error("Failed to save file:", error);
    }
  };

  const processQueue = useCallback(async () => {
    if (
      ffmpegRef.current &&
      !processingQueue.current &&
      queue.current.length > 0
    ) {
      processingQueue.current = true;

      if (ffmpegRef.current) {
        try {
          await ffmpegRef.current.load();
        } catch (error) {
          console.error("Failed to load FFmpeg:", error);
          return;
        }
      }

      while (queue.current.length > 0) {
        try {
          const chunk = queue.current.shift();

          if (!chunk) {
            continue;
          }

          console.log("log-1");

          const chunkNumber = segmentCounter.current++;

          const ffmpeg = ffmpegRef.current;

          if (!ffmpeg) {
            console.error("FFmpeg not loaded");
            return;
          }

          const inputFileName = `input-${String(chunkNumber).padStart(
            3,
            "0"
          )}.mp4`;
          const outputFileName = `output-${String(chunkNumber).padStart(
            3,
            "0"
          )}.ts`;

          const buffer = new Uint8Array(await chunk.arrayBuffer());
          const videoBuffer = await fetchFile(new Blob([buffer]));

          console.log("video buffer:");
          console.log(videoBuffer);

          console.log("log-2");

          await ffmpeg.writeFile(inputFileName, videoBuffer);

          console.log("log-3");

          await ffmpeg.exec([
            "-i",
            inputFileName,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-c:a",
            "aac",
            "-strict",
            "experimental",
            "-b:a",
            "128k",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-f",
            "mpegts",
            outputFileName,
          ]);

          console.log("log-4");

          try {
            const savedVideo = (await ffmpeg.readFile(
              outputFileName
            )) as Uint8Array;
            await saveFile(savedVideo, outputFileName, false);
            console.log("log-5");
          } catch (error) {
            console.error("Failed to save file:", error);
          }

          console.log("log-6");

          if (segmentCounter.current === 2) {
            const screenshotFileName = "video-capture.jpeg";

            console.log("Generating screenshot...");

            await ffmpeg.exec([
              "-i",
              outputFileName,
              "-ss",
              "0",
              "-frames:v",
              "1",
              "-q:v",
              "1",
              screenshotFileName,
            ]);

            try {
              const savedScreenshot = (await ffmpeg.readFile(
                screenshotFileName
              )) as Uint8Array;
              await saveFile(savedScreenshot, screenshotFileName, true);
              console.log("Screenshot saved.");
            } catch (error) {
              console.error("Failed to save screenshot:", error);
            }

            // Clean up by deleting the temporary screenshot file generated by FFmpeg
            await ffmpeg.deleteFile(screenshotFileName);

            console.log("Screenshot process completed.");
          }

          await ffmpeg.deleteFile(inputFileName);
          await ffmpeg.deleteFile(outputFileName);
        } catch (error) {
          console.error("Failed to process chunk:", error);
        }
      }

      processingQueue.current = false;
    }
  }, [queue]);

  const startMediaRecording = useCallback(
    async (stream: MediaStream) => {
      // Reset queue and counters here to ensure a fresh start
      queue.current = []; // Clear the queue
      segmentCounter.current = 0;
      processingQueue.current = false;
      isRecording.current = true;
      console.log("Recording started");

      const options = { mimeType: "video/mp4;" };
      mediaRecorder.current = new MediaRecorder(stream, options);

      mediaRecorder.current.ondataavailable = (event) => {
        console.log(`Blob size: ${event.data.size}`);
        if (event.data.size > 0) {
          queue.current.push(event.data);
          processQueue();
        }
      };

      mediaRecorder.current.start();

      const requestDataInterval = setInterval(() => {
        if (mediaRecorder.current && isRecording.current) {
          console.log("Requesting data periodically");
          mediaRecorder.current.stop();
          mediaRecorder.current.start();
        } else {
          clearInterval(requestDataInterval);
        }
      }, 3000);

      return () => {
        if (
          mediaRecorder.current &&
          mediaRecorder.current.state !== "inactive"
        ) {
          mediaRecorder.current.stop();
          isRecording.current = false;
        }
        console.log("Recording stopped");
      };
    },
    [processQueue]
  );

  const stopMediaRecording = useCallback(async () => {
    isRecording.current = false;

    while (processingQueue.current || queue.current.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") {
      mediaRecorder.current.stop();
      console.log("Media recording stopped and queue processed.");
    }
  }, []);

  return {
    isRecording: isRecording.current,
    startMediaRecording,
    stopMediaRecording,
  };
};
