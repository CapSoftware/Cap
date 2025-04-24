"use client";

import Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";

export const SkeletonRows = () => {
  return (
    <div className="flex flex-col min-h-screen lg:gap-5">
      {/* Content Area */}
      <div className="flex overflow-auto flex-col flex-1 bg-gray-100 lg:rounded-tl-2xl">
        <div className="flex flex-col w-full">
          <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {Array(15)
              .fill(0)
              .map((_, index) => (
                <div
                  key={index}
                  className="flex relative flex-col gap-4 p-4 w-full h-full bg-gray-50 rounded-2xl border-gray-200 border-[1px]"
                >
                  {/* Thumbnail */}
                  <Skeleton className="h-[150px] w-full aspect-video rounded-lg" />

                  {/* Title */}
                  <div className="flex flex-col gap-1">
                    <Skeleton className="h-[20px] w-full max-w-[180px]" />
                    <Skeleton className="h-[16px] w-[80px]" />
                  </div>

                  {/* Analytics */}
                  <div className="flex flex-wrap gap-3 items-center mt-auto text-sm">
                    {/* Views */}
                    <div className="flex gap-1 items-center">
                      <Skeleton circle width={16} height={16} />
                      <Skeleton width={20} height={16} />
                    </div>

                    {/* Comments */}
                    <div className="flex gap-1 items-center">
                      <Skeleton circle width={16} height={16} />
                      <Skeleton width={20} height={16} />
                    </div>

                    {/* Reactions */}
                    <div className="flex gap-1 items-center">
                      <Skeleton circle width={16} height={16} />
                      <Skeleton width={20} height={16} />
                    </div>
                  </div>
                </div>
              ))}
          </div>

          {/* Pagination */}
          <div className="flex justify-center mt-10">
            <Skeleton className="h-[36px] w-[300px]" />
          </div>
        </div>
      </div>
    </div>
  );
};
