"use client";

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
import { getLatestVideoId } from "../database/utils";

export const useMediaRecorder = () => {
  const isRecording = useRef(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const ffmpegRef = useRef<FfmpegType | null>(null);
  const queue = useRef<Blob[]>([]);
  const processingQueue = useRef(false);
  const segmentCounter = useRef(0);
  const [metadataRecorded, setMetadataRecorded] = useState(false);

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

  const getAudioChunksDir = async () => {
    const dir = await appDataDir();
    return join(dir, "chunks", "audio");
  };

  const appendToSegmentListFile = async (fileName: string) => {
    const dir = await getAudioChunksDir();
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
          const audioOutputFileName = `output-${String(chunkNumber).padStart(
            3,
            "0"
          )}.aac`;

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
            "-vn",
            "-acodec",
            "aac",
            "-b:a",
            "128k",
            audioOutputFileName,
          ]);

          console.log("log-4");

          try {
            const savedAudio = (await ffmpeg.readFile(
              audioOutputFileName
            )) as Uint8Array;
            const audioDir = await getAudioChunksDir();
            await createDir(audioDir, { recursive: true });
            const audioPath = await join(audioDir, audioOutputFileName);
            await writeBinaryFile(audioPath, savedAudio);
            await appendToSegmentListFile(audioOutputFileName);
            console.log("Audio saved: ", audioOutputFileName);
          } catch (error) {
            console.error("Failed to save audio:", error);
          }

          await ffmpeg.deleteFile(inputFileName);
        } catch (error) {
          console.error("Failed to process chunk:", error);
        }
      }

      processingQueue.current = false;
    }
  }, [queue]);

  const sendMetadataAPI = async () => {
    try {
      const videoId = await getLatestVideoId();
      const audioStartTime = Date.now();
      const queryParams = new URLSearchParams({
        videoId,
        audioStartTime: audioStartTime.toString(),
      }).toString();
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_URL}/api/desktop/video/metadata/create?${queryParams}`,
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        }
      );
      if (res.status === 401) {
        console.error("Unauthorized");
        return;
      }
      const data = await res.json();
      console.log("Metadata fetched successfully:", data);
    } catch (error) {
      console.error("Error fetching video and audio start time:", error);
    }
  };

  const startMediaRecording = useCallback(
    async (stream: MediaStream) => {
      if (!stream.active || !stream.getTracks().length) {
        console.error("The provided stream is not active or has no tracks.");
        return;
      }

      console.log("stream:");
      console.log(stream);

      console.log("stream.getTracks():");
      console.log(stream.getTracks());

      const initRecorder = async () => {
        if (
          mediaRecorder.current &&
          mediaRecorder.current.state !== "inactive"
        ) {
          mediaRecorder.current.stop();
        }

        if (isRecording.current === false) {
          return;
        }

        const options = {
          mimeType: "video/mp4",
          audioBitsPerSecond: 128000,
          videoBitsPerSecond: 0,
        };
        mediaRecorder.current = new MediaRecorder(stream, options);

        mediaRecorder.current.ondataavailable = async (event) => {
          console.log(`Blob size: ${event.data.size}`);
          if (event.data.size > 0) {
            queue.current.push(event.data);
            processQueue();
          }
        };

        mediaRecorder.current.onerror = (event: any) => {
          console.error("MediaRecorder error:", event.error);
        };

        mediaRecorder.current.start();
      };

      isRecording.current = true;
      initRecorder();

      const requestDataInterval = setInterval(() => {
        if (mediaRecorder.current && isRecording.current === true) {
          console.log("Stopping and restarting the recorder to gather chunks.");
          mediaRecorder.current.stop();
          mediaRecorder.current.onstop = () => {
            initRecorder();
          };
        } else {
          clearInterval(requestDataInterval);
        }
      }, 3000);

      mediaRecorder.current.onstart = async () => {
        if (metadataRecorded === false) {
          setMetadataRecorded(true);
          await sendMetadataAPI();
        }
        console.log("MediaRecorder started:", mediaRecorder.current);
      };

      return () => {
        clearInterval(requestDataInterval);
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
    if (mediaRecorder.current) {
      mediaRecorder.current.stop();
      console.log("Media recording stopped.");
    }

    isRecording.current = false;
    setMetadataRecorded(false);

    while (processingQueue.current || queue.current.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log("Queue processed and recording fully stopped.");
  }, []);

  return {
    isRecording: isRecording.current,
    startMediaRecording,
    stopMediaRecording,
  };
};
