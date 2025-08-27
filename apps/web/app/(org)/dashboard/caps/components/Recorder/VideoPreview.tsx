"use client";

import { useEffect } from "react";

interface VideoPreviewProps {
  videoBlob: Blob | null;
  onRetry?: () => void;
  onSave?: () => void;
}

export function VideoPreview({
  videoBlob,
  onRetry,
  onSave,
}: VideoPreviewProps) {
  const videoUrl = videoBlob ? URL.createObjectURL(videoBlob) : null;

  useEffect(() => {
    if (videoUrl) {
      return () => URL.revokeObjectURL(videoUrl);
    }
  }, [videoUrl]);

  if (!videoBlob) return null;

  return (
    <div className="mt-4 p-4 bg-gray-2 rounded-lg">
      <h3 className="text-sm font-medium text-gray-12 mb-2">
        Recording Preview
      </h3>
      <video
        src={videoUrl || ""}
        controls
        className="w-full max-w-md mx-auto rounded-lg bg-black"
      >
        <track kind="captions" />
      </video>
      <div className="flex gap-2 mt-3 justify-center">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1.5 text-sm bg-gray-3 hover:bg-gray-4 rounded-lg transition-colors"
          >
            Record Again
          </button>
        )}
        {onSave && (
          <button
            type="button"
            onClick={onSave}
            className="px-3 py-1.5 text-sm bg-blue-9 hover:bg-blue-10 text-white rounded-lg transition-colors"
          >
            Save Recording
          </button>
        )}
      </div>
    </div>
  );
}
