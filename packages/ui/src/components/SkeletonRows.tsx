"use client";

import Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";

export const SkeletonRows = () => {
  return (
    <div className="dashboard-page">
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
  );
};
