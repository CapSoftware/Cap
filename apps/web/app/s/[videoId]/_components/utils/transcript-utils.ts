// Utility functions for transcript formatting

export interface TranscriptEntry {
  id: number;
  timestamp: string | number; // Allow both string and number types
  text: string;
  startTime: number;
}

/**
 * Formats transcript entries as VTT format for subtitles
 */
export const formatTranscriptAsVTT = (entries: TranscriptEntry[]): string => {
  const vttHeader = "WEBVTT\n\n";

  const vttEntries = entries.map((entry, index) => {
    const startSeconds = entry.startTime;
    const nextEntry = entries[index + 1];
    const endSeconds = nextEntry ? nextEntry.startTime : startSeconds + 3;

    const formatTime = (seconds: number): string => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const milliseconds = Math.floor((seconds % 1) * 1000);

      return `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${milliseconds
        .toString()
        .padStart(3, "0")}`;
    };

    return `${entry.id}\n${formatTime(startSeconds)} --> ${formatTime(
      endSeconds
    )}\n${entry.text}\n`;
  });

  return vttHeader + vttEntries.join("\n");
};

/**
 * Formats transcript entries for clipboard copying
 */
export const formatTranscriptForClipboard = (
  entries: TranscriptEntry[]
): string => {
  return entries
    .map((entry) => `[${entry.timestamp}] ${entry.text}`)
    .join("\n\n");
};
