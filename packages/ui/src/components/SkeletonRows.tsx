"use client";

import Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";

export const SkeletonRows = () => {
  return (
    <div className="flex flex-col pt-5 min-h-screen lg:gap-5">
      {/* Top Bar */}
      <div className="flex sticky z-10 justify-between items-center px-5 mt-10 w-full h-16 bg-gray-50 border-b border-gray-200 lg:border-b-0 lg:pl-0 lg:pr-5 lg:top-0 lg:relative top-[64px] lg:mt-0 lg:h-8">
        <Skeleton
          count={1}
          containerClassName="w-full"
          className="bg-gray-500 h-[30px] w-full max-w-[200px]"
        />
        <Skeleton count={1} className="bg-gray-500 h-[30px] w-[100px]" />
      </div>
      {/* Content Area */}
      <div className="flex overflow-auto flex-col flex-1 p-5 pb-5 bg-gray-100 border border-gray-200 lg:rounded-tl-2xl lg:p-8">
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
                  <div className="flex flex-wrap gap-3 items-center text-sm mt-auto">
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
          <div className="mt-10 flex justify-center">
            <Skeleton className="h-[36px] w-[300px]" />
          </div>
        </div>
      </div>
    </div>
  );
};
