"use client";

import Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";

export const SkeletonPage = () => {
  return (
    <div className="dashboard-page">
      <div className="mb-4 max-w-xl">
        <div className="mb-4">
          <Skeleton count={1} className="bg-gray-500 h-[30px]" />
        </div>
        <div>
          <Skeleton count={2} />
        </div>
      </div>
      <div>
        <Skeleton count={2} className="h-[125px] mb-2" />
      </div>
    </div>
  );
};
