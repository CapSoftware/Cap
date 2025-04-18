"use client";

import Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";

export const SkeletonRows = () => {
  return (
    <div className="flex flex-col gap-5 pt-5 min-h-screen">
      <div className="h-[8vh] lg:h-[5vh] border-b lg:border-0 border-gray-200 w-full mt-4 lg:mt-0 fixed top-12 lg:top-0 bg-gray-50 z-10 lg:relative flex items-center justify-between px-5 lg:pr-8 lg:pl-0">
        <Skeleton
          count={1}
          containerClassName="w-full"
          className="bg-gray-500 h-[30px] w-full max-w-[200px]"
        />
      </div>
      <div className="flex overflow-auto flex-col flex-1 p-5 pb-5 bg-gray-100 border border-gray-200 mt-[120px] lg:mt-0 lg:rounded-tl-2xl lg:p-8">
        <div className="space-y-6">
          <div className="w-full">
            <Skeleton
              count={3}
              containerClassName="w-full flex gap-6"
              className="bg-gray-500 h-[280px]"
            />
          </div>
          <div className="w-full">
            <Skeleton
              count={3}
              containerClassName="w-full flex gap-6"
              className="bg-gray-500 h-[280px]"
            />
          </div>
          <div className="w-full">
            <Skeleton
              count={3}
              containerClassName="w-full flex gap-6"
              className="bg-gray-500 h-[280px]"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
