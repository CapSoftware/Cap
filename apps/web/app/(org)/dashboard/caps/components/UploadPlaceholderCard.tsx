"use client";

import { LogoSpinner } from "@cap/ui";
import {
  getProgressCircleConfig,
  calculateStrokeDashoffset,
  getUploadStatus,
  getDisplayProgress,
} from "@cap/utils";

export const UploadPlaceholderCard = ({
  thumbnail,
  progress,
  uploadProgress,
}: {
  thumbnail?: string;
  progress: number;
  uploadProgress?: number;
}) => {
  const { circumference } = getProgressCircleConfig();
  const status = getUploadStatus(uploadProgress);
  const displayProgress = getDisplayProgress(uploadProgress, progress);
  const strokeDashoffset = calculateStrokeDashoffset(
    displayProgress,
    circumference
  );

  console.log(displayProgress, 'display progress')

  return (
    <div className="flex flex-col gap-4 w-full h-full rounded-xl bg-gray-1 border-gray-3 border-[1px]">
      <div className="overflow-hidden relative w-full bg-black rounded-t-xl border-b border-gray-3 aspect-video group">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt="Uploading thumbnail"
            className="object-cover w-full h-full"
          />
        ) : (
          <div className="flex justify-center items-center w-full h-full">
            <LogoSpinner className="w-8 h-8 animate-spin" />
          </div>
        )}

        <div className="absolute inset-0 transition-all duration-300 bg-black/60"></div>

        <div className="flex absolute bottom-3 left-3 gap-2 items-center">
          <span className="text-sm font-semibold text-white">{status}</span>
          <svg className="w-4 h-4 transform -rotate-90" viewBox="0 0 20 20">
            <circle
              cx="10"
              cy="10"
              r="8"
              stroke="currentColor"
              strokeWidth="3"
              fill="none"
              className="text-white/30"
            />
            <circle
              cx="10"
              cy="10"
              r="8"
              stroke="currentColor"
              strokeWidth="3"
              fill="none"
              strokeLinecap="round"
              className="text-white transition-all duration-200 ease-out"
              style={{
                strokeDasharray: `${circumference} ${circumference}`,
                strokeDashoffset: `${strokeDashoffset}`,
              }}
            />
          </svg>
        </div>
      </div>
      <div className="flex flex-col flex-grow gap-3 px-4 pb-4 w-full">
        <div>
          <div className="h-[1.25rem] mb-1">
            <div className="h-4 rounded animate-pulse bg-gray-3"></div>
          </div>
          <div className="mb-1 h-[1.25rem]">
            <div className="w-24 h-3 rounded animate-pulse bg-gray-3"></div>
          </div>
          <div className="mb-1 h-[1.5rem]">
            <div className="w-20 h-3 rounded animate-pulse bg-gray-3"></div>
          </div>
        </div>
        <div className="flex gap-4 items-center text-sm text-gray-10">
          <div className="w-16 h-3 rounded animate-pulse bg-gray-3"></div>
        </div>
      </div>
    </div>
  );
};
