"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
  return (
    <SkeletonPage
      customSkeleton={(Skeleton) => (
        <form>
          <div className="flex flex-col flex-wrap gap-6 w-full md:flex-row">
            {/* First card - Name fields */}
            <div className="flex-1 p-5 space-y-1 rounded-2xl border bg-gray-3 border-gray-4">
              <Skeleton
                baseColor="var(--gray-4)"
                highlightColor="var(--gray-5)"
                className="w-32 h-7"
              />{" "}
              {/* Card title */}
              <Skeleton
                baseColor="var(--gray-4)"
                highlightColor="var(--gray-5)"
                count={2}
                className="mt-1 h-4"
              />{" "}
              {/* Card description */}
              <div className="flex flex-col flex-wrap gap-5 pt-4 w-full md:flex-row">
                <div className="flex-1 space-y-2">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    className="w-full h-12 rounded-xl"
                  />{" "}
                  {/* First name input */}
                </div>
                <div className="flex-1 space-y-2">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    className="w-full h-12 rounded-xl"
                  />{" "}
                  {/* Last name input */}
                </div>
              </div>
            </div>

            {/* Second card - Email field */}
            <div className="flex flex-col flex-1 gap-4 justify-between items-stretch p-5 rounded-2xl border bg-gray-3 border-gray-4">
              <div className="space-y-1">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="w-44 h-7"
                />{" "}
                {/* Card title */}
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  count={1}
                  className="mt-1 h-4"
                />{" "}
                {/* Card description */}
              </div>
              <Skeleton
                baseColor="var(--gray-4)"
                highlightColor="var(--gray-5)"
                className="w-full h-12 rounded-xl"
              />{" "}
              {/* Email input */}
            </div>
          </div>

          {/* Save button */}
          <div className="mt-6 w-24">
            <Skeleton
              baseColor="var(--gray-4)"
              highlightColor="var(--gray-5)"
              className="h-10 rounded-xl"
            />{" "}
            {/* Button */}
          </div>
        </form>
      )}
    />
  );
}
