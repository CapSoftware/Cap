"use client";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import clsx from "clsx";
import { SpaceDialog } from "./SpaceDialog";

export const SpacesList = () => {
  const { spacesData, sidebarCollapsed } = useSharedContext();
  const [showSpaceDialog, setShowSpaceDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAllSpaces, setShowAllSpaces] = useState(false);

  if (!spacesData) return null;

  const filteredSpaces = spacesData.filter((space) =>
    space.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const displayedSpaces = showAllSpaces
    ? filteredSpaces
    : filteredSpaces.slice(0, 3);

  const hasMoreSpaces = filteredSpaces.length > 3;
  const hiddenSpacesCount = filteredSpaces.length - 3;

  return (
    <div className="mt-4 flex flex-col">
      <div className="flex items-center mb-2">
        <h2
          className={clsx(
            "text-gray-12 font-medium",
            sidebarCollapsed ? "hidden" : "text-base"
          )}
        >
          Spaces
        </h2>
        {!sidebarCollapsed && (
          <div className="ml-auto">
            <button
              className="p-1 rounded-lg hover:bg-gray-4"
              onClick={() => {
                setShowSpaceDialog(true);
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-gray-11"
              >
                <path d="M12 5v14M5 12h14"></path>
              </svg>
            </button>
          </div>
        )}
      </div>

      <div className={clsx("relative mb-3", sidebarCollapsed ? "hidden" : "")}>
        <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
          <Search className="h-4 w-4 text-gray-9" />
        </div>
        <input
          type="text"
          placeholder="Search spaces"
          className="w-full h-9 pl-10 pr-3 py-2 bg-gray-3 border border-gray-4 rounded-lg text-sm text-gray-11 placeholder-gray-8 focus:outline-none focus:ring-1 focus:ring-gray-7"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div
        className={clsx(
          "space-y-2",
          showAllSpaces && !sidebarCollapsed
            ? "max-h-[calc(100vh-450px)] overflow-y-auto pr-1 mb-3"
            : ""
        )}
      >
        {displayedSpaces.map((space) => (
          <Link
            key={space.id}
            href={`/dashboard/spaces/${space.id}`}
            className={clsx(
              "flex items-center group py-1 px-3 rounded-xl transition-colors hover:bg-gray-3",
              sidebarCollapsed ? "justify-center" : ""
            )}
          >
            <Avatar
              letterClass="text-gray-1 text-xs"
              className="relative flex-shrink-0 size-[25px]"
              name={space.name}
            />
            {!sidebarCollapsed && (
              <span className="ml-3 text-sm text-gray-11 group-hover:text-gray-12">
                {space.name}
              </span>
            )}
          </Link>
        ))}

        {!showAllSpaces && hasMoreSpaces && !sidebarCollapsed && (
          <button
            onClick={() => setShowAllSpaces(true)}
            className="flex items-center w-full py-1 px-3 text-gray-10 hover:text-gray-12 rounded-xl transition-colors hover:bg-gray-3"
          >
            <span className="ml-3 text-gray-10 text-sm">
              + {hiddenSpacesCount} more
            </span>
          </button>
        )}

        {showAllSpaces && !sidebarCollapsed && (
          <button
            onClick={() => setShowAllSpaces(false)}
            className="flex items-center w-full py-1 px-3 text-gray-10 hover:text-gray-12 rounded-xl transition-colors hover:bg-gray-3"
          >
            <span className="ml-3 text-gray-10 text-sm">Show less</span>
          </button>
        )}
      </div>

      <SpaceDialog
        open={showSpaceDialog}
        onClose={() => setShowSpaceDialog(false)}
      />
    </div>
  );
};

export default SpacesList;
