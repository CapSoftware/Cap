"use client";

import { useUploadingContext } from "../UploadingContext";
import { LogoSpinner } from "@cap/ui";
import Image from "next/image";
import { useEffect, useState } from "react";

interface UploadPlaceholderCardProps {
  id?: string;
  thumbnailUrl?: string;
  progress?: number;
}

export const UploadPlaceholderCard = ({ id, thumbnailUrl: propThumbnailUrl, progress: propProgress }: UploadPlaceholderCardProps) => {

  const { uploadingThumbnailUrl, uploadProgress } = useUploadingContext();
  const thumbnailUrl = propThumbnailUrl || uploadingThumbnailUrl;

  const [progress, setProgress] = useState(propProgress || uploadProgress || 0);

  useEffect(() => {
    if (propProgress !== undefined) {
      setProgress(propProgress);
      return;
    } else if (uploadProgress > 0) {
      setProgress(uploadProgress);
      return;
    }

    if (progress < 100) {
      const timer = setTimeout(() => {
        const increment = Math.max(1, Math.floor((100 - progress) / 10));
        setProgress(prev => Math.min(99, prev + increment));
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [progress, propProgress, uploadProgress]);

  return (
    <div className="flex flex-col gap-4 w-full h-full rounded-xl bg-gray-1 border-gray-3 border-[1px]">
      <div className="overflow-hidden relative w-full bg-black rounded-t-xl border-b border-gray-3 aspect-video group">
        {thumbnailUrl ? (
          <Image
            src={thumbnailUrl}
            alt="Upload thumbnail"
            fill={true}
            sizes="(max-width: 768px) 100vw, 33vw"
            objectFit="cover"
          />
        ) : (
          <div className="flex justify-center items-center w-full h-full">
            <LogoSpinner className="w-8 h-8 animate-spin" />
          </div>
        )}

        {/* Circular progress indicator with text */}
        <div className="flex absolute bottom-4 left-4 z-10 gap-2 items-center">
          <svg className="w-6 h-6" width="28" height="28" viewBox="0 0 28 28">
            <circle
              cx="14"
              cy="14"
              r="12"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="3"
            />
            <circle
              cx="14"
              cy="14"
              r="12"
              fill="none"
              stroke="white"
              strokeWidth="3"
              strokeDasharray="75.4"
              strokeDashoffset={75.4 * (1 - progress / 100)}
              transform="rotate(-90 14 14)"
              strokeLinecap="round"
            />
          </svg>
          <div className="text-sm font-medium text-white">
            Uploading...
          </div>
        </div>
      </div>

      <div className="flex flex-col flex-grow gap-3 px-4 pb-4 w-full">
        <div>
          <div className="mb-1 h-[1.25rem]">
            <div className="w-36 h-3 rounded animate-pulse bg-gray-3"></div>
          </div>
          <div className="mb-2 h-[1.25rem]">
            <div className="w-24 h-3 rounded animate-pulse bg-gray-3"></div>
          </div>
          <div className="mb-1 h-[1.25rem]">
            <div className="w-16 h-3 rounded animate-pulse bg-gray-3"></div>
          </div>
          <div className="mt-5 h-[1.25rem]">
            <div className="w-32 h-3 rounded animate-pulse bg-gray-3"></div>
          </div>
        </div>
      </div>
    </div>
  );
};
