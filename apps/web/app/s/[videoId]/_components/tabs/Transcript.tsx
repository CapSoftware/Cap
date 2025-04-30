"use client";

import { videos } from "@cap/database/schema";
import { useState, useEffect } from "react";
import { MessageSquare } from "lucide-react";
import { usePublicEnv } from "@/utils/public-env";

interface TranscriptProps {
  data: typeof videos.$inferSelect;
  onSeek?: (time: number) => void;
}

interface TranscriptEntry {
  id: number;
  timestamp: string;
  text: string;
  startTime: number;
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

    if (trimmedLine === "WEBVTT") continue;

    if (/^\d+$/.test(trimmedLine)) {
      currentId = parseInt(trimmedLine, 10);
      continue;
    }

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
  const [hasTimedOut, setHasTimedOut] = useState(false);

  const publicEnv = usePublicEnv();

  useEffect(() => {
    const fetchTranscript = async () => {
      let transcriptionUrl;

      if (data.bucket && data.awsBucket !== publicEnv.awsBucket) {
        // For custom S3 buckets, fetch through the API
        transcriptionUrl = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&fileType=transcription`;
      } else {
        // For default Cap storage
        transcriptionUrl = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/transcription.vtt`;
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

    const videoCreationTime = new Date(data.createdAt).getTime();
    const fiveMinutesInMs = 5 * 60 * 1000;
    const isVideoOlderThanFiveMinutes =
      Date.now() - videoCreationTime > fiveMinutesInMs;

    if (data.transcriptionStatus === "COMPLETE") {
      fetchTranscript();
    } else if (isVideoOlderThanFiveMinutes && !data.transcriptionStatus) {
      setIsLoading(false);
      setHasTimedOut(true);
    } else {
      const startTime = Date.now();
      const maxDuration = 2 * 60 * 1000;

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
    data.createdAt,
  ]);

  const handleReset = () => {
    setIsLoading(true);
    const fetchTranscript = async () => {
      const transcriptionUrl =
        data.bucket && data.awsBucket !== publicEnv.awsBucket
          ? `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&fileType=transcription`
          : `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/transcription.vtt`;

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

    if (onSeek) {
      onSeek(entry.startTime);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-full">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-8 h-8"
          viewBox="0 0 24 24"
        >
          <style>
            {"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
          </style>
          <path
            fill="#4B5563"
            d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
            opacity={0.25}
          />
          <path
            fill="#4B5563"
            d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
            style={{
              transformOrigin: "center",
              animation: "spinner_AtaB .75s infinite linear",
            }}
          />
        </svg>
      </div>
    );
  }

  if (isTranscriptionProcessing) {
    return (
      <div className="flex justify-center items-center h-full text-gray-1">
        <div className="text-center">
          <div className="mb-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="mx-auto w-8 h-8"
              viewBox="0 0 24 24"
            >
              <style>
                {"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
              </style>
              <path
                fill="#9CA3AF"
                d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
                opacity={0.25}
              />
              <path
                fill="#9CA3AF"
                d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
                style={{
                  transformOrigin: "center",
                  animation: "spinner_AtaB .75s infinite linear",
                }}
              />
            </svg>
          </div>
          <p>Transcription in progress...</p>
        </div>
      </div>
    );
  }

  if (hasTimedOut || (!transcriptData.length && !isTranscriptionProcessing)) {
    return (
      <div className="flex justify-center items-center h-full text-gray-1">
        <div className="text-center">
          <MessageSquare className="mx-auto mb-2 w-8 h-8 text-gray-300" />
          <p className="text-sm font-medium text-gray-12">
            No transcript available
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="overflow-y-auto flex-1">
        <div className="p-4 space-y-3">
          {transcriptData.map((entry) => (
            <div
              key={entry.id}
              className={`group rounded-lg p-2 transition-colors cursor-pointer ${
                selectedEntry === entry.id ? "bg-gray-2" : "hover:bg-gray-2"
              }`}
              onClick={() => handleTranscriptClick(entry)}
            >
              <div className="mb-1 text-sm text-gray-8 font-semibold">
                {entry.timestamp}
              </div>
              <div className="text-sm text-gray-12">{entry.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
