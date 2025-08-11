"use client";

import { SkeletonPage } from "@cap/ui";

export default function Loading() {
  return (
    <SkeletonPage
      customSkeleton={(Skeleton) => (
        <div className="space-y-6">
          {/* Seats stats cards */}
          <div className="flex flex-col gap-6 md:flex-row">
            {/* Seats Remaining card */}
            <div className="flex flex-col flex-1 gap-3 justify-center items-center p-5 rounded-2xl border bg-gray-3 border-gray-4">
              <div className="overflow-hidden w-5 h-5 rounded-full">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={20}
                  height={20}
                />
              </div>
              <div className="flex items-center">
                <span className="text-sm">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width={100}
                  />
                </span>
                <span className="ml-2 font-medium">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width={20}
                  />
                </span>
              </div>
            </div>

            {/* Seats Capacity card */}
            <div className="flex flex-col flex-1 gap-3 justify-center items-center p-5 rounded-2xl border bg-gray-3 border-gray-4">
              <div className="overflow-hidden w-5 h-5 rounded-full">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={20}
                  height={20}
                />
              </div>
              <div className="flex items-center">
                <span className="text-sm">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width={100}
                  />
                </span>
                <span className="ml-2 font-medium">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width={20}
                  />
                </span>
              </div>
            </div>

          </div>

          {/* Main content cards - Organization Details and Cap Settings side by side */}
          <div className="flex flex-col gap-6 justify-center items-stretch xl:flex-row">
            {/* Organization Details Card */}
            <div className="flex flex-col flex-1 gap-6 p-6 w-full rounded-2xl border min-h-fit bg-gray-3 border-gray-4">
              {/* Card Header */}
              <div className="space-y-2">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[24px] w-[100px]"
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[16px] w-[280px]"
                />
              </div>

              {Array(5).fill(0).map((_, index) => (
                <div key={index} className="grid grid-cols-4 w-full">
                  <div className="col-span-3">
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      className="h-[16px] w-[320px]"
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      className="h-[14px] w-[320px]"
                    />
                  </div>
                  <div className="flex justify-end w-full">
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      className="!h-[40px] !w-[60px] !rounded-full"
                    />
                  </div>
                </div>
              ))}
              {/* Upload Icon */}
              <div className="flex justify-center items-center w-full h-[100px] border border-gray-5 rounded-xl">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="!h-[40px] !w-[60px] !rounded-full"
                />
              </div>
            </div>


            {/* Cap Settings Card */}
            <div className="flex relative flex-col flex-1 gap-6 p-6 w-full rounded-2xl border min-h-fit bg-gray-3 border-gray-4">
              {/* Card Header */}
              <div className="space-y-2">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[24px] w-[120px]"
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[16px] w-[250px]"
                />
              </div>

              {/* Coming Soon Overlay */}
              <div className="relative">
                <div className="absolute top-0 left-0 z-[20] rounded-xl flex items-center justify-center w-full h-full backdrop-blur-md bg-zinc-900/20">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    className="!h-[32px] !w-[120px] !rounded-full"
                  />
                </div>

                {/* Tabs */}
                <div className="flex gap-4 pb-4 mt-3 border-b border-gray-4">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    className="!h-[32px] !w-[100px] !rounded-xl"
                  />
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    className="!h-[32px] !w-[80px] !rounded-xl"
                  />
                </div>

                {/* Settings Items */}
                <div className="mt-4 space-y-3">
                  {Array(6)
                    .fill(0)
                    .map((_, index) => (
                      <div
                        key={index}
                        className="flex justify-between items-center p-3 rounded-xl border border-gray-4"
                      >
                        <Skeleton
                          baseColor="var(--gray-4)"
                          highlightColor="var(--gray-5)"
                          className="h-[16px] w-[150px]"
                        />
                        <Skeleton
                          baseColor="var(--gray-4)"
                          highlightColor="var(--gray-5)"
                          className="!h-[24px] !w-[44px] !rounded-full"
                        />
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>

          {/* Members Card */}
          <div className="p-6 rounded-2xl border bg-gray-3 border-gray-4">
            {/* Card Header */}
            <div className="flex justify-between items-start mb-6">
              <div className="space-y-2">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[24px] w-[80px]"
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[16px] w-[200px]"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="!h-[40px] !w-[150px] !rounded-full"
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="!h-[40px] !w-[120px] !rounded-full"
                />
              </div>
            </div>

            {/* Members List */}
            <div className="space-y-4">
              {Array(3)
                .fill(0)
                .map((_, index) => (
                  <div key={index} className="flex justify-between items-center p-4 rounded-xl border border-gray-4">
                    <div className="flex gap-3 items-center">
                      <Skeleton
                        baseColor="var(--gray-4)"
                        highlightColor="var(--gray-5)"
                        circle
                        width={40}
                        height={40}
                      />
                      <div className="space-y-1">
                        <Skeleton
                          baseColor="var(--gray-4)"
                          highlightColor="var(--gray-5)"
                          className="h-[16px] w-[120px]"
                        />
                        <Skeleton
                          baseColor="var(--gray-4)"
                          highlightColor="var(--gray-5)"
                          className="h-[14px] w-[160px]"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 items-center">
                      <Skeleton
                        baseColor="var(--gray-4)"
                        highlightColor="var(--gray-5)"
                        className="!h-[32px] !w-[80px] !rounded-full"
                      />
                      <Skeleton
                        baseColor="var(--gray-4)"
                        highlightColor="var(--gray-5)"
                        className="!h-[32px] !w-[32px] !rounded-md"
                      />
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Billing Card */}
          <div className="p-6 rounded-2xl border bg-gray-3 border-gray-4">
            {/* Card Header */}
            <div className="flex justify-between items-start mb-6">
              <div className="space-y-2">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[24px] w-[80px]"
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[16px] w-[180px]"
                />
              </div>
              <Skeleton
                baseColor="var(--gray-4)"
                highlightColor="var(--gray-5)"
                className="!h-[40px] !w-[140px] !rounded-full"
              />
            </div>

            {/* Billing Info */}
            <div className="space-y-4">
              <div className="flex justify-between items-center p-4 rounded-xl border border-gray-4">
                <div className="space-y-1">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    className="h-[16px] w-[100px]"
                  />
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    className="h-[14px] w-[140px]"
                  />
                </div>
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  className="h-[20px] w-[60px]"
                />
              </div>
            </div>
          </div>
        </div >
      )
      }
    />
  );
}
