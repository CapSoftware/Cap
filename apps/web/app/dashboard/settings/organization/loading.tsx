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

          <div className="flex flex-col gap-6 items-stretch xl:flex-row">
            {/* Organization details card */}
            <div className="flex flex-col flex-1 justify-between p-5 rounded-2xl border bg-gray-3 border-gray-4">
              <div className="flex flex-col gap-6 lg:flex-row">
                {/* Name field */}
                <div className="flex-1 space-y-2">
                  <div>
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width={60}
                      height={16}
                      className="mb-1"
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width={200}
                      height={12}
                    />
                  </div>
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    height={48}
                    className="mt-4 rounded-xl"
                  />
                </div>

                {/* Email domain field */}
                <div className="flex-1 space-y-2">
                  <div>
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width={120}
                      height={16}
                      className="mb-1"
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width={200}
                      height={12}
                    />
                  </div>
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    height={48}
                    className="mt-4 rounded-xl"
                  />
                </div>
              </div>

              {/* Save button */}
              <div className="mt-8 mb-2">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={80}
                  height={36}
                  className="rounded-xl"
                />
              </div>
            </div>

            {/* Custom domain card */}
            <div className="flex-1 p-5 rounded-2xl border bg-gray-3 border-gray-4">
              <div className="space-y-2">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={100}
                  height={16}
                  className="mb-1"
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={300}
                  height={12}
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={280}
                  height={12}
                />
              </div>

              <div className="mt-4 space-y-4">
                {/* Domain input */}
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  height={48}
                  className="rounded-xl"
                />

                {/* Status and buttons */}
                <div className="flex justify-between items-center">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width={150}
                    height={24}
                    className="rounded-md"
                  />
                </div>

                <div className="flex flex-wrap justify-between mt-4">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width={80}
                    height={36}
                    className="rounded-xl"
                  />
                  <div className="flex gap-3">
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width={100}
                      height={36}
                      className="rounded-xl"
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width={100}
                      height={36}
                      className="rounded-xl"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Members table */}
          <div className="p-5 rounded-2xl border bg-gray-3 border-gray-4">
            <div className="flex flex-wrap justify-between items-center mb-6">
              <div>
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={80}
                  height={20}
                  className="mb-2"
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={180}
                  height={12}
                />
              </div>
              <div className="flex gap-3">
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={140}
                  height={36}
                  className="rounded-xl"
                />
                <Skeleton
                  baseColor="var(--gray-4)"
                  highlightColor="var(--gray-5)"
                  width={100}
                  height={36}
                  className="rounded-xl"
                />
              </div>
            </div>

            {/* Table */}
            <div className="mt-5">
              {/* Header */}
              <div className="py-3 border-b border-gray-5">
                <div className="flex gap-2">
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width="16%"
                    height={16}
                  />
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width="16%"
                    height={16}
                  />
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width="16%"
                    height={16}
                  />
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width="16%"
                    height={16}
                  />
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width="16%"
                    height={16}
                  />
                  <Skeleton
                    baseColor="var(--gray-4)"
                    highlightColor="var(--gray-5)"
                    width="16%"
                    height={16}
                  />
                </div>
              </div>

              {/* Rows */}
              {[1, 2, 3].map((i) => (
                <div key={i} className="py-4 border-b border-gray-5">
                  <div className="flex gap-2">
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width="16%"
                      height={16}
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width="16%"
                      height={16}
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width="16%"
                      height={16}
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width="16%"
                      height={16}
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width="16%"
                      height={16}
                    />
                    <Skeleton
                      baseColor="var(--gray-4)"
                      highlightColor="var(--gray-5)"
                      width="16%"
                      height={16}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Billing section */}
          <div className="flex flex-wrap justify-between items-center p-5 rounded-2xl border bg-gray-3 border-gray-4">
            <div>
              <Skeleton
                baseColor="var(--gray-4)"
                highlightColor="var(--gray-5)"
                width={220}
                height={20}
                className="mb-2"
              />
              <Skeleton
                baseColor="var(--gray-4)"
                highlightColor="var(--gray-5)"
                width={300}
                height={12}
              />
            </div>
            <Skeleton
              baseColor="var(--gray-4)"
              highlightColor="var(--gray-5)"
              width={120}
              height={36}
              className="rounded-xl"
            />
          </div>
        </div>
      )}
    />
  );
}
