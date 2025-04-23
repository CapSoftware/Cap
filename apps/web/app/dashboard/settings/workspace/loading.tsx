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
            <div className="flex flex-col flex-1 gap-3 justify-center items-center p-5 bg-gray-50 rounded-2xl border border-gray-200">
              <div className="overflow-hidden w-5 h-5 rounded-full">
                <Skeleton width={20} height={20} />
              </div>
              <div className="flex items-center">
                <span className="text-sm">
                  <Skeleton width={100} />
                </span>
                <span className="ml-2 font-bold">
                  <Skeleton width={20} />
                </span>
              </div>
            </div>

            {/* Seats Capacity card */}
            <div className="flex flex-col flex-1 gap-3 justify-center items-center p-5 bg-gray-50 rounded-2xl border border-gray-200">
              <div className="overflow-hidden w-5 h-5 rounded-full">
                <Skeleton width={20} height={20} />
              </div>
              <div className="flex items-center">
                <span className="text-sm">
                  <Skeleton width={100} />
                </span>
                <span className="ml-2 font-bold">
                  <Skeleton width={20} />
                </span>
              </div>
            </div>
          </div>

          {/* Workspace details and Custom domain */}
          <div className="flex flex-col gap-6 items-stretch xl:flex-row">
            {/* Workspace details card */}
            <div className="flex flex-col flex-1 justify-between p-5 bg-gray-50 rounded-2xl border border-gray-200">
              <div className="flex flex-col gap-6 lg:flex-row">
                {/* Name field */}
                <div className="flex-1 space-y-2">
                  <div>
                    <Skeleton width={60} height={16} className="mb-1" />
                    <Skeleton width={200} height={12} />
                  </div>
                  <Skeleton height={48} className="mt-4 rounded-xl" />
                </div>

                {/* Email domain field */}
                <div className="flex-1 space-y-2">
                  <div>
                    <Skeleton width={120} height={16} className="mb-1" />
                    <Skeleton width={200} height={12} />
                  </div>
                  <Skeleton height={48} className="mt-4 rounded-xl" />
                </div>
              </div>

              {/* Save button */}
              <div className="mt-8 mb-2">
                <Skeleton width={80} height={36} className="rounded-xl" />
              </div>
            </div>

            {/* Custom domain card */}
            <div className="flex-1 p-5 bg-gray-50 rounded-2xl border border-gray-200">
              <div className="space-y-2">
                <Skeleton width={100} height={16} className="mb-1" />
                <Skeleton width={300} height={12} />
                <Skeleton width={280} height={12} />
              </div>

              <div className="mt-4 space-y-4">
                {/* Domain input */}
                <Skeleton height={48} className="rounded-xl" />

                {/* Status and buttons */}
                <div className="flex justify-between items-center">
                  <Skeleton width={150} height={24} className="rounded-md" />
                </div>

                <div className="flex flex-wrap justify-between mt-4">
                  <Skeleton width={80} height={36} className="rounded-xl" />
                  <div className="flex gap-3">
                    <Skeleton width={100} height={36} className="rounded-xl" />
                    <Skeleton width={100} height={36} className="rounded-xl" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Members table */}
          <div className="p-5 bg-gray-50 rounded-2xl border border-gray-200">
            <div className="flex flex-wrap justify-between items-center mb-6">
              <div>
                <Skeleton width={80} height={20} className="mb-2" />
                <Skeleton width={180} height={12} />
              </div>
              <div className="flex gap-3">
                <Skeleton width={140} height={36} className="rounded-xl" />
                <Skeleton width={100} height={36} className="rounded-xl" />
              </div>
            </div>

            {/* Table */}
            <div className="mt-5">
              {/* Header */}
              <div className="py-3 border-b">
                <div className="flex gap-2">
                  <Skeleton width="16%" height={16} />
                  <Skeleton width="16%" height={16} />
                  <Skeleton width="16%" height={16} />
                  <Skeleton width="16%" height={16} />
                  <Skeleton width="16%" height={16} />
                  <Skeleton width="16%" height={16} />
                </div>
              </div>

              {/* Rows */}
              {[1, 2, 3].map((i) => (
                <div key={i} className="py-4 border-b">
                  <div className="flex gap-2">
                    <Skeleton width="16%" height={16} />
                    <Skeleton width="16%" height={16} />
                    <Skeleton width="16%" height={16} />
                    <Skeleton width="16%" height={16} />
                    <Skeleton width="16%" height={16} />
                    <Skeleton width="16%" height={16} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Billing section */}
          <div className="flex flex-wrap justify-between items-center p-5 bg-gray-50 rounded-2xl border border-gray-200">
            <div>
              <Skeleton width={220} height={20} className="mb-2" />
              <Skeleton width={300} height={12} />
            </div>
            <Skeleton width={120} height={36} className="rounded-xl" />
          </div>
        </div>
      )}
    />
  );
}
