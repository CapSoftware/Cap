import { useState, useRef, useCallback } from "react";
import { writeBinaryFile } from "@tauri-apps/api/fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { writeTextFile, readTextFile } from "@tauri-apps/api/fs";

export const useMediaRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunkCounter = useRef(0);

  const getVideoChunksDir = async () => {
    const dir = await appDataDir();
    return join(dir, "chunks", "video");
  };

  const appendToSegmentListFile = async (fileName: string) => {
    const dir = await getVideoChunksDir();
    const segmentListPath = await join(dir, "segment_list.txt");

    let fileContent;
    try {
      // Try to read the existing content
      fileContent = await readTextFile(segmentListPath);
    } catch (error) {
      // If there's an error (like file doesn't exist), we start with an empty string
      fileContent = "";
    }

    // Create new content by appending the new file name (not the full path)
    const newContent = `${fileContent}${fileName}\n`;

    // Write the new content back to the file, effectively appending it
    await writeTextFile(segmentListPath, newContent);
  };

  const handleDataAvailable = useCallback(async (event: BlobEvent) => {
    const blob = new Blob([event.data], { type: "video/webm" });
    const buffer = await blob.arrayBuffer();
    const dir = await getVideoChunksDir();
    const chunkNumber = chunkCounter.current++;
    const fileName = `recording_chunk_${String(chunkNumber).padStart(
      3,
      "0"
    )}.webm`;
    const filePath = await join(dir, fileName);

    // First write the binary file
    await writeBinaryFile({
      path: filePath,
      contents: buffer,
    })
      .then(() => {
        // After a successful write, append to the segment list file
        appendToSegmentListFile(fileName).catch((error) => {
          // Handle errors during the append operation
          console.error(
            `Failed to append to segment list file: ${error.message}`
          );
        });
      })
      .catch((error) => {
        // Handle errors during the file writing
        console.error(`Failed to write video chunk: ${error.message}`);
      });
  }, []);
  const startMediaRecording = useCallback(
    async (stream: MediaStream) => {
      chunkCounter.current = 0;
      const dir = await getVideoChunksDir();
      const segmentListPath = await join(dir, "segment_list.txt");
      await writeTextFile({ path: segmentListPath, contents: "" });

      // Set up and start the MediaRecorder
      if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) {
        mediaRecorder.current = new MediaRecorder(stream, {
          mimeType: "video/webm;codecs=vp8",
        });
      } else {
        // Fallback to the default MIME type if 'webm' is not supported
        mediaRecorder.current = new MediaRecorder(stream);
      }
      mediaRecorder.current.ondataavailable = handleDataAvailable;
      mediaRecorder.current.onerror = (event: any) => {
        console.error("Recording error:", event.error);
      };

      mediaRecorder.current.start(3000);
      setIsRecording(true);
    },
    [handleDataAvailable]
  );

  const stopMediaRecording = useCallback(async () => {
    if (mediaRecorder.current && isRecording) {
      mediaRecorder.current.onstop = async () => {
        setIsRecording(false);
        chunkCounter.current = 0;

        console.log("Media recording stopped.");
      };

      mediaRecorder.current.stop();
    }
  }, [isRecording]);

  return {
    isRecording,
    startMediaRecording,
    stopMediaRecording,
  };
};
