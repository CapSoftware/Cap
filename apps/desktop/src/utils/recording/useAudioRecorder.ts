import { useRef, useEffect, useCallback } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  writeBinaryFile,
  writeTextFile,
  readTextFile,
  createDir,
} from "@tauri-apps/api/fs";
import { getLatestVideoId } from "../database/utils";

export const useAudioRecorder = () => {
  const isRecordingAudio = useRef(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const queue = useRef<Blob[]>([]);
  const processingQueue = useRef(false);
  const segmentCounter = useRef(0);
  const firstRecordingStarted = useRef(false);

  const getAudioSegmentsDir = async () => {
    const dir = await appDataDir();
    return join(dir, "chunks", "audio");
  };

  const appendToAudioSegmentListFile = async (fileName: string) => {
    const dir = await getAudioSegmentsDir();
    const segmentListPath = await join(dir, "segment_list.txt");
    let fileContent;
    try {
      fileContent = await readTextFile(segmentListPath);
    } catch (error) {
      fileContent = "";
    }
    const newContent = `${fileContent}${fileName}\n`;
    await writeTextFile({ path: segmentListPath, contents: newContent });
  };

  const saveAudioSegment = async (data: Uint8Array, fileName: string) => {
    const dir = await getAudioSegmentsDir();
    await createDir(dir, { recursive: true });
    const filePath = await join(dir, fileName);
    await writeBinaryFile({ path: filePath, contents: data });
    await appendToAudioSegmentListFile(fileName);
  };

  const processQueue = useCallback(async () => {
    if (!processingQueue.current && queue.current.length > 0) {
      processingQueue.current = true;
      while (queue.current.length > 0) {
        try {
          const chunk = queue.current.shift();
          if (!chunk) continue;
          const buffer = new Uint8Array(await chunk.arrayBuffer());
          const segmentNumber = segmentCounter.current++;
          const fileName = `audio_segment_${segmentNumber
            .toString()
            .padStart(3, "0")}.webm`;
          await saveAudioSegment(buffer, fileName);
        } catch (error) {
          console.error("Failed to process audio chunk:", error);
        }
      }
      processingQueue.current = false;
    }
  }, []);

  const sendMetadataAPI = useCallback(async () => {
    if (!firstRecordingStarted.current) {
      firstRecordingStarted.current = true;
      try {
        const videoId = getLatestVideoId();
        const response = await fetch("/api/desktop/video/metadata/create", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            videoId: videoId,
            audioStartTime: Date.now(),
          }),
        });
        if (!response.ok) {
          throw new Error(`API call failed with status ${response.status}`);
        }
        const jsonResponse = await response.json();
        console.log("Metadata updated successfully:", jsonResponse);
      } catch (error) {
        console.error("Error updating video and audio start time:", error);
      }
    }
  }, []);

  const startAudioRecording = useCallback(
    async (mediaStream: MediaStream) => {
      if (!mediaStream) {
        console.error("Media stream is null.");
        return;
      }

      console.log("mediaStream:", mediaStream);

      const audioTracks = mediaStream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.error("No audio track found in the media stream.");
        return;
      }

      const audioStream = new MediaStream(audioTracks);

      mediaRecorder.current = new MediaRecorder(audioStream, {
        mimeType: "audio/webm",
      });
      if (!mediaRecorder.current) {
        console.error("mediaRecorder is null.");
        return;
      }
      mediaRecorder.current.start();
      isRecordingAudio.current = true;

      mediaRecorder.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          queue.current.push(event.data);
          processQueue();
        }
      };

      await sendMetadataAPI();

      const requestDataInterval = setInterval(() => {
        if (mediaRecorder.current && isRecordingAudio.current === true) {
          mediaRecorder.current.stop();
          mediaRecorder.current.onstop = () => {
            if (isRecordingAudio.current) {
              mediaRecorder.current?.start();
            }
          };
        } else {
          clearInterval(requestDataInterval);
        }
      }, 3000);

      return () => {
        clearInterval(requestDataInterval);
        if (mediaRecorder.current) {
          mediaRecorder.current.stop();
          isRecordingAudio.current = false;
        }
      };
    },
    [processQueue, sendMetadataAPI]
  );

  const stopAudioRecording = useCallback(async () => {
    if (mediaRecorder.current) {
      mediaRecorder.current.stop();
      console.log("Audio recording stopped.");
    }
    isRecordingAudio.current = false;
    while (processingQueue.current || queue.current.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    firstRecordingStarted.current = false;
    console.log("Queue processed and audio recording fully stopped.");
  }, []);

  useEffect(() => {
    return () => {
      if (isRecordingAudio.current && mediaRecorder.current) {
        mediaRecorder.current.stop();
        isRecordingAudio.current = false;
      }
    };
  }, []);

  return {
    isRecordingAudio: isRecordingAudio.current,
    startAudioRecording,
    stopAudioRecording,
  };
};
