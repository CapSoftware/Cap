"use client";

import { videos } from "@cap/database/schema";
import { useState, useEffect } from "react";
import { MessageSquare } from "lucide-react";
import { S3_BUCKET_URL } from "@cap/utils";
import { clientEnv } from "@cap/env";

interface TranscriptProps {
  data: typeof videos.$inferSelect;
  onSeek?: (time: number) => void;
}

interface TranscriptEntry {
  id: number;
  timestamp: string;
  text: string;
  startTime: number; // in seconds
}

const parseVTT = (vttContent: string): TranscriptEntry[] => {
  const lines = vttContent.split("\n");
  const entries: TranscriptEntry[] = [];
  let currentEntry: Partial<TranscriptEntry & { startTime: number }> = {};
  let currentId = 0;

  const timeToSeconds = (timeStr: string): number | null => {
    const parts = timeStr.split(":");
    if (parts.length !== 3) return null;

    const [hoursStr, minutesStr, secondsStr] = parts;
    if (!hoursStr || !minutesStr || !secondsStr) return null;

    const hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);
    const seconds = parseInt(secondsStr, 10);

    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;

    return hours * 3600 + minutes * 60 + seconds;
  };

  const parseTimestamp = (
    timestamp: string
  ): { mm_ss: string; totalSeconds: number } | null => {
    const parts = timestamp.split(":");
    if (parts.length !== 3) return null;

    const [hoursStr, minutesStr, secondsWithMs] = parts;
    if (!hoursStr || !minutesStr || !secondsWithMs) return null;

    const secondsPart = secondsWithMs.split(".")[0];
    if (!secondsPart) return null;

    const totalSeconds = timeToSeconds(
      `${hoursStr}:${minutesStr}:${secondsPart}`
    );
    if (totalSeconds === null) return null;

    return {
      mm_ss: `${minutesStr}:${secondsPart}`,
      totalSeconds,
    };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;

    const trimmedLine = line.trim();

    // Skip WEBVTT header
    if (trimmedLine === "WEBVTT") continue;

    // Parse cue ID (number)
    if (/^\d+$/.test(trimmedLine)) {
      currentId = parseInt(trimmedLine, 10);
      continue;
    }

    // Parse timestamp line
    if (trimmedLine.includes("-->")) {
      const [startTimeStr, endTimeStr] = trimmedLine.split(" --> ");
      if (!startTimeStr || !endTimeStr) continue;

      const startTimestamp = parseTimestamp(startTimeStr);
      if (startTimestamp) {
        currentEntry = {
          id: currentId,
          timestamp: startTimestamp.mm_ss,
          startTime: startTimestamp.totalSeconds,
        };
      }
      continue;
    }

    // Parse text content
    if (currentEntry.timestamp && !currentEntry.text) {
      currentEntry.text = trimmedLine;
      if (
        currentEntry.id !== undefined &&
        currentEntry.timestamp &&
        currentEntry.text &&
        currentEntry.startTime !== undefined
      ) {
        entries.push(currentEntry as TranscriptEntry);
      }
      currentEntry = {};
    }
  }

  return entries.sort((a, b) => a.startTime - b.startTime);
};

export const Transcript: React.FC<TranscriptProps> = ({ data, onSeek }) => {
  const [transcriptData, setTranscriptData] = useState<TranscriptEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<number | null>(null);
  const [isTranscriptionProcessing, setIsTranscriptionProcessing] =
    useState(false);

  useEffect(() => {
    const fetchTranscript = async () => {
      let transcriptionUrl;

      if (
        data.bucket &&
        data.awsBucket !== clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET
      ) {
        // For custom S3 buckets, fetch through the API
        transcriptionUrl = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&fileType=transcription`;
      } else {
        // For default Cap storage
        transcriptionUrl = `${S3_BUCKET_URL}/${data.ownerId}/${data.id}/transcription.vtt`;
      }

      try {
        const response = await fetch(transcriptionUrl);
        const vttContent = await response.text();
        const parsed = parseVTT(vttContent);
        setTranscriptData(parsed);
      } catch (error) {
        console.error("Error loading transcript:", error);
      }
      setIsLoading(false);
    };

    if (data.transcriptionStatus === "COMPLETE") {
      fetchTranscript();
    } else {
      const startTime = Date.now();
      const maxDuration = 2 * 60 * 1000; // 2 minutes

      const intervalId = setInterval(() => {
        if (Date.now() - startTime > maxDuration) {
          clearInterval(intervalId);
          setIsLoading(false);
          return;
        }

        fetch(`/api/video/transcribe/status?videoId=${data.id}`)
          .then((response) => response.json())
          .then(({ transcriptionStatus }) => {
            if (transcriptionStatus === "PROCESSING") {
              setIsTranscriptionProcessing(true);
            } else if (transcriptionStatus === "COMPLETE") {
              fetchTranscript();
              clearInterval(intervalId);
            } else if (transcriptionStatus === "ERROR") {
              clearInterval(intervalId);
              setIsLoading(false);
            }
          });
      }, 1000);

      return () => clearInterval(intervalId);
    }
  }, [
    data.id,
    data.ownerId,
    data.bucket,
    data.awsBucket,
    data.transcriptionStatus,
  ]);

  const handleReset = () => {
    setIsLoading(true);
    // Re-fetch the transcript
    const fetchTranscript = async () => {
      const transcriptionUrl =
        data.bucket && data.awsBucket !== clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET
          ? `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&fileType=transcription`
          : `${S3_BUCKET_URL}/${data.ownerId}/${data.id}/transcription.vtt`;

      try {
        const response = await fetch(transcriptionUrl);
        const vttContent = await response.text();
        const parsed = parseVTT(vttContent);
        setTranscriptData(parsed);
      } catch (error) {
        console.error("Error resetting transcript:", error);
      }
      setIsLoading(false);
    };

    fetchTranscript();
  };

  const handleTranscriptClick = (entry: TranscriptEntry) => {
    setSelectedEntry(entry.id);

    // Use the onSeek callback to handle video seeking
    if (onSeek) {
      onSeek(entry.startTime);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (isTranscriptionProcessing) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <MessageSquare className="w-8 h-8 mx-auto mb-2 text-gray-400 animate-pulse" />
          <p>Transcription in progress...</p>
        </div>
      </div>
    );
  }

  if (!transcriptData.length) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <MessageSquare className="w-8 h-8 mx-auto mb-2 text-gray-300" />
          <p className="text-sm text-gray-500 font-medium">
            No transcript available
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-3 p-4">
          {transcriptData.map((entry) => (
            <div
              key={entry.id}
              className={`group rounded-lg p-2 transition-colors cursor-pointer ${
                selectedEntry === entry.id ? "bg-blue-50" : "hover:bg-gray-100"
              }`}
              onClick={() => handleTranscriptClick(entry)}
            >
              <div className="text-sm text-gray-500 mb-1">
                {entry.timestamp}
              </div>
              <div className="text-sm text-gray-900">{entry.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
