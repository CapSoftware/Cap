"use client";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import clsx from "clsx";
import { SpaceDialog } from "./SpaceDialog";
import { Input } from "@cap/ui";
import { shareCap } from "@/actions/caps/share";
import { toast } from "sonner";
import { useParams, useRouter } from "next/navigation";
import { Tooltip } from "@/components/Tooltip";

export const SpacesList = () => {
  const { spacesData, sidebarCollapsed } = useSharedContext();
  const [showSpaceDialog, setShowSpaceDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAllSpaces, setShowAllSpaces] = useState(false);
  const [activeDropTarget, setActiveDropTarget] = useState<string | null>(null);
  const router = useRouter();
  const params = useParams();

  if (!spacesData) return null;

  const filteredSpaces = spacesData.filter((space) =>
    space.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const displayedSpaces = showAllSpaces
    ? filteredSpaces
    : filteredSpaces.slice(0, 3);

  const hasMoreSpaces = filteredSpaces.length > 3;
  const hiddenSpacesCount = filteredSpaces.length - 3;

  const handleDragOver = (e: React.DragEvent, spaceId: string) => {
    e.preventDefault();
    setActiveDropTarget(spaceId);
  };

  const handleDragLeave = () => {
    setActiveDropTarget(null);
  };

  const handleDrop = async (e: React.DragEvent, spaceId: string) => {
    e.preventDefault();
    setActiveDropTarget(null);

    try {
      const capData = e.dataTransfer.getData("application/cap");
      if (!capData) return;

      const cap = JSON.parse(capData);

      // Call the share action with just this space ID
      const result = await shareCap({
        capId: cap.id,
        spaceIds: [spaceId],
      });

      if (result.success) {
        const space = spacesData.find((s) => s.id === spaceId);
        toast.success(`Shared "${cap.name}" to ${space?.name || "space"}`);
        router.refresh();
      } else {
        toast.error(result.error || "Failed to share cap");
      }
    } catch (error) {
      console.error("Error sharing cap:", error);
      toast.error("Failed to share cap");
    }
  };

  const activeSpaceParams = (spaceId: string) => params.spaceId === spaceId;

  return (
    <div className="flex flex-col mt-4">
      <div className="flex items-center mb-3">
        <h2
          className={clsx(
            "text-sm font-medium text-gray-12",
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

      <div className={clsx("relative mb-2", sidebarCollapsed ? "hidden" : "")}>
        <div className="flex absolute inset-y-0 left-3 items-center pointer-events-none">
          <Search className="size-3.5 text-gray-9" />
        </div>
        <Input
          type="text"
          placeholder="Search spaces..."
          className="pr-3 pl-8 w-full h-9 text-xs placeholder-gray-8"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Wrapper div with overflow hidden to prevent scrollbar flash */}
      <div className="overflow-hidden">
        <div
          className={clsx(
            "transition-all duration-300",
            showAllSpaces && !sidebarCollapsed
              ? "max-h-[calc(100vh-450px)] overflow-y-auto pr-1"
              : "max-h-max overflow-hidden"
          )}
          style={{
            scrollbarWidth: "none",
            msOverflowStyle: "none",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {displayedSpaces.map((space) => (
            <Tooltip
              position="right"
              disable={!sidebarCollapsed}
              content={space.name}
            >
              <div
                key={space.id}
                className={clsx(
                  "relative transition-colors duration-150 rounded-xl mb-2",
                  activeDropTarget === space.id && "ring-2 ring-blue-500",
                  activeSpaceParams(space.id) ? "bg-gray-3" : "bg-transparent"
                )}
                onDragOver={(e) => handleDragOver(e, space.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, space.id)}
              >
                {activeDropTarget === space.id && (
                  <div className="absolute inset-0 z-10 rounded-xl pointer-events-none bg-blue-500/10" />
                )}
                <Link
                  href={`/dashboard/spaces/${space.id}`}
                  className={clsx(
                    "flex items-center px-2 py-2 truncate rounded-xl transition-colors group hover:bg-gray-2",
                    sidebarCollapsed ? "justify-center" : ""
                  )}
                >
                  <Avatar
                    letterClass="text-gray-1 text-xs"
                    className="relative flex-shrink-0 size-5"
                    name={space.name}
                  />
                  {!sidebarCollapsed && (
                    <span className="ml-3 text-sm transition-colors text-gray-11 group-hover:text-gray-12">
                      {space.name}
                    </span>
                  )}
                </Link>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>

      <SpaceToggleControl
        showAllSpaces={showAllSpaces}
        hasMoreSpaces={hasMoreSpaces}
        sidebarCollapsed={sidebarCollapsed}
        hiddenSpacesCount={hiddenSpacesCount}
        setShowAllSpaces={setShowAllSpaces}
      />

      <SpaceDialog
        open={showSpaceDialog}
        onClose={() => setShowSpaceDialog(false)}
      />
    </div>
  );
};

const SpaceToggleControl = ({
  showAllSpaces,
  hasMoreSpaces,
  sidebarCollapsed,
  hiddenSpacesCount,
  setShowAllSpaces,
}: {
  showAllSpaces: boolean;
  hasMoreSpaces: boolean;
  sidebarCollapsed: boolean;
  hiddenSpacesCount: number;
  setShowAllSpaces: (show: boolean) => void;
}) => {
  if (sidebarCollapsed) return null;
  if (!showAllSpaces && hasMoreSpaces) {
    return (
      <div
        onClick={() => setShowAllSpaces(true)}
        className="flex justify-between items-center p-2 w-full truncate rounded-xl transition-colors cursor-pointer text-gray-10 hover:text-gray-12 hover:bg-gray-3"
      >
        <span className="text-sm text-gray-10">+ {hiddenSpacesCount} more</span>
        <ChevronDown size={16} className="ml-2" />
      </div>
    );
  }
  if (showAllSpaces) {
    return (
      <div
        onClick={() => setShowAllSpaces(false)}
        className="flex justify-between items-center p-2 w-full truncate rounded-xl transition-colors cursor-pointer text-gray-10 hover:text-gray-12 hover:bg-gray-3"
      >
        <span className="text-sm text-gray-10">Show less</span>
        <ChevronUp size={16} className="ml-2" />
      </div>
    );
  }
  return null;
};

export default SpacesList;
