"use client";

import { LogoSpinner } from "@cap/ui";

export const UploadPlaceholderCard = ({
  thumbnail,
  progress,
}: {
  thumbnail?: string;
  progress: number;
}) => {
  return (
    <div className="flex flex-col gap-4 w-full h-full rounded-xl bg-gray-1 border-gray-3 border-[1px]">
      <div className="relative w-full overflow-hidden bg-black rounded-t-xl border-b border-gray-3 aspect-video">
        {thumbnail ? (
          <img src={thumbnail} alt="Uploading thumbnail" className="w-full h-full object-cover" />
        ) : (
          <div className="flex items-center justify-center w-full h-full">
            <LogoSpinner className="w-8 h-8 animate-spin" />
          </div>
        )}
        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center text-white text-sm">
          <LogoSpinner className="w-5 h-5 mb-2 animate-spin" />
          <div>{Math.round(progress)}%</div>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4">
        <p className="text-md font-medium text-gray-12">Uploading...</p>
        <div className="h-2 bg-gray-3 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-9 transition-all"
            style={{ width: `${progress}%` }}
          ></div>
        </div>
      </div>
    </div>
  );
};
