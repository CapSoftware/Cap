"use client";

import { videos } from "@cap/database/schema";
import { useState, useEffect } from "react";
import { MessageSquare, Edit3, Check, X } from "lucide-react";
import { editTranscriptEntry } from "@/actions/videos/edit-transcript";
import { useTranscript, useInvalidateTranscript } from "hooks/use-transcript";
import { Button } from "@cap/ui";

interface TranscriptProps {
  data: typeof videos.$inferSelect;
  onSeek?: (time: number) => void;
  user?: { id: string } | null;
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
      const textContent =
        trimmedLine.startsWith('"') && trimmedLine.endsWith('"')
          ? trimmedLine.slice(1, -1)
          : trimmedLine;

      currentEntry.text = textContent;
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

  const sortedEntries = entries.sort((a, b) => a.startTime - b.startTime);
  return sortedEntries;
};

export const Transcript: React.FC<TranscriptProps> = ({
  data,
  onSeek,
  user,
}) => {
  const [transcriptData, setTranscriptData] = useState<TranscriptEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<number | null>(null);
  const [isTranscriptionProcessing, setIsTranscriptionProcessing] =
    useState(false);
  const [hasTimedOut, setHasTimedOut] = useState(false);
  const [editingEntry, setEditingEntry] = useState<number | null>(null);
  const [editText, setEditText] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);

  const {
    data: transcriptContent,
    isLoading: isTranscriptLoading,
    error: transcriptError,
  } = useTranscript(data.id, data.transcriptionStatus);

  const invalidateTranscript = useInvalidateTranscript();

  useEffect(() => {
    if (transcriptContent) {
      const parsed = parseVTT(transcriptContent);
      setTranscriptData(parsed);
      setIsTranscriptionProcessing(false);
      setIsLoading(false);
    } else if (transcriptError) {
      console.error(
        "[Transcript] Transcript error from React Query:",
        transcriptError.message
      );
      if (transcriptError.message === "TRANSCRIPT_NOT_READY") {
        setIsTranscriptionProcessing(true);
      } else {
        setIsTranscriptionProcessing(false);
      }
      setIsLoading(false);
    }
  }, [transcriptContent, transcriptError]);

  useEffect(() => {
    if (isTranscriptLoading) {
      setIsLoading(true);
    }
  }, [isTranscriptLoading]);

  useEffect(() => {
    const videoCreationTime = new Date(data.createdAt).getTime();
    const fiveMinutesInMs = 5 * 60 * 1000;
    const isVideoOlderThanFiveMinutes =
      Date.now() - videoCreationTime > fiveMinutesInMs;

    if (data.transcriptionStatus === "PROCESSING") {
      setIsTranscriptionProcessing(true);
      setIsLoading(true);
    } else if (data.transcriptionStatus === "ERROR") {
      setIsTranscriptionProcessing(false);
      setIsLoading(false);
    } else if (isVideoOlderThanFiveMinutes && !data.transcriptionStatus) {
      setIsLoading(false);
      setHasTimedOut(true);
    } else if (!data.transcriptionStatus) {
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
              clearInterval(intervalId);
            } else if (transcriptionStatus === "ERROR") {
              clearInterval(intervalId);
              setIsLoading(false);
            }
          });
      }, 1000);

      return () => clearInterval(intervalId);
    }
  }, [data.id, data.transcriptionStatus, data.createdAt]);

  const handleReset = () => {
    setIsLoading(true);
    invalidateTranscript(data.id);
  };

  const handleTranscriptClick = (entry: TranscriptEntry) => {
    if (editingEntry === entry.id) {
      return;
    }

    setSelectedEntry(entry.id);

    if (onSeek) {
      onSeek(entry.startTime);
    }
  };

  const startEditing = (entry: TranscriptEntry) => {
    setEditingEntry(entry.id);
    setEditText(entry.text);
  };

  const cancelEditing = () => {
    setEditingEntry(null);
    setEditText("");
  };

  const saveEdit = async () => {
    if (!editingEntry || !editText.trim()) {
      return;
    }

    const originalEntry = transcriptData.find(
      (entry) => entry.id === editingEntry
    );

    setIsSaving(true);
    try {
      const result = await editTranscriptEntry(data.id, editingEntry, editText);

      if (result.success) {
        setTranscriptData((prev) =>
          prev.map((entry) =>
            entry.id === editingEntry
              ? { ...entry, text: editText.trim() }
              : entry
          )
        );
        setEditingEntry(null);
        setEditText("");
        invalidateTranscript(data.id);
      } else {
        console.error("[Transcript] Failed to save transcript edit:", {
          entryId: editingEntry,
          videoId: data.id,
          errorMessage: result.message,
          result,
        });
      }
    } catch (error) {
      console.error("[Transcript] Error saving transcript edit:", {
        entryId: editingEntry,
        videoId: data.id,
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const canEdit = user?.id === data.ownerId;

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
              className={`group rounded-lg transition-colors ${
                editingEntry === entry.id
                  ? "bg-gray-1 border border-gray-4 p-3"
                  : selectedEntry === entry.id
                  ? "bg-gray-2 p-3"
                  : "hover:bg-gray-2 p-3"
              } ${editingEntry === entry.id ? "" : "cursor-pointer"}`}
              onClick={() => handleTranscriptClick(entry)}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="text-xs text-gray-8 font-medium">
                  {entry.timestamp}
                </div>
                {canEdit && editingEntry !== entry.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      startEditing(entry);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-gray-3 rounded-md transition-all duration-200"
                    title="Edit transcript"
                  >
                    <Edit3 className="w-3.5 h-3.5 text-gray-9" />
                  </button>
                )}
              </div>

              {editingEntry === entry.id ? (
                <div className="space-y-3">
                  <div className="rounded-lg bg-gray-1 border border-gray-4 p-3">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      className="w-full text-sm leading-relaxed text-gray-12 bg-transparent placeholder:text-gray-8 resize-none focus:outline-none"
                      rows={Math.max(2, Math.ceil(editText.length / 60))}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      placeholder="Edit transcript text..."
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelEditing();
                      }}
                      disabled={isSaving}
                      variant="white"
                      size="xs"
                      className="min-w-[70px]"
                    >
                      <X className="w-3 h-3 mr-1" />
                      Cancel
                    </Button>
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        saveEdit();
                      }}
                      disabled={isSaving || !editText.trim()}
                      variant="primary"
                      size="xs"
                      className="min-w-[70px]"
                      spinner={isSaving}
                    >
                      <Check className="w-3 h-3 mr-1" />
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm leading-relaxed text-gray-12">
                  {entry.text}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
