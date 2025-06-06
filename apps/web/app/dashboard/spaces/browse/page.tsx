"use client";
import React from "react";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Space } from "../../layout";

export default function BrowseSpacesPage() {
  const { spacesData } = useSharedContext();
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-full rounded-xl shadow-sm bg-gray-1">
          <thead>
            <tr className="text-sm font-medium text-left text-gray-10">
              <th className="px-6 py-3">Name</th>
              <th className="px-6 py-3">Members</th>
              <th className="px-6 py-3">Videos</th>
              <th className="px-6 py-3">Role</th>
            </tr>
          </thead>
          <tbody>
            {!spacesData && (
              <tr>
                <td colSpan={4} className="px-6 py-6 text-center text-gray-8">
                  Loading spaces…
                </td>
              </tr>
            )}
            {spacesData && spacesData.length === 0 && (
              <tr>
                <td colSpan={4} className="px-6 py-6 text-center text-gray-8">
                  No spaces found.
                </td>
              </tr>
            )}
            {spacesData &&
              spacesData.map((space: Space) => (
                <tr
                  key={space.id}
                  className="border-t transition-colors hover:bg-gray-2 border-gray-3"
                >
                  <td className="flex gap-3 items-center px-6 py-3">
                    <span className="flex justify-center items-center w-7 h-7 text-sm font-bold rounded-full bg-gray-3 text-gray-12">
                      {space.iconUrl ? (
                        <img
                          src={space.iconUrl}
                          alt={space.name}
                          className="object-cover w-7 h-7 rounded-full"
                        />
                      ) : (
                        (space.name?.charAt(0) || "?").toUpperCase()
                      )}
                    </span>
                    <span className="font-semibold text-gray-12">
                      {space.name}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-gray-12">
                    {space.memberCount} member
                    {space.memberCount === 1 ? "" : "s"}
                  </td>
                  <td className="px-6 py-3 text-gray-12">
                    {space.videoCount} video{space.videoCount === 1 ? "" : "s"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
