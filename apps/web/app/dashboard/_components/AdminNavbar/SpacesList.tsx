"use client";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import Link from "next/link";
import { memo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPlus,
  faShareNodes,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import { deleteSpace } from "@/actions/organization/delete-space";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import clsx from "clsx";
import { SpaceDialog } from "./SpaceDialog";
import { Button, Input } from "@cap/ui";
import { shareCap } from "@/actions/caps/share";
import { toast } from "sonner";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Tooltip } from "@/components/Tooltip";
import { motion } from "framer-motion";
import { useMemo } from "react";
import Image from "next/image";

import { useEffect } from "react";
import { navItemClass } from "./AdminNavItems";

export const SpacesList = ({
  toggleMobileNav,
}: {
  toggleMobileNav?: () => void;
}) => {
  useEffect(() => {
    console.log("SpacesList mounted");
  }, []);
  const { spacesData, sidebarCollapsed } = useSharedContext();
  const [showSpaceDialog, setShowSpaceDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAllSpaces, setShowAllSpaces] = useState(false);
  const [activeDropTarget, setActiveDropTarget] = useState<string | null>(null);
  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();

  const handleDeleteSpace = async (e: React.MouseEvent, spaceId: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (
      confirm(
        "Are you sure you want to delete this space? This action cannot be undone."
      )
    ) {
      try {
        const result = await deleteSpace(spaceId);

        if (result.success) {
          toast.success("Space deleted successfully");

          // If the number of spaces will drop to 3 or fewer after deletion,
          // automatically set showAllSpaces to false
          if (filteredSpaces.length <= 4) {
            setShowAllSpaces(false);
          }

          router.refresh();

          // If we're currently on the deleted space's page, redirect to dashboard
          if (params.spaceId === spaceId) {
            router.push("/dashboard");
          }
        } else {
          toast.error(result.error || "Failed to delete space");
        }
      } catch (error) {
        console.error("Error deleting space:", error);
        toast.error("Failed to delete space");
      }
    }
  };

  if (!spacesData) return null;

  const { displayedSpaces, hasMoreSpaces, hiddenSpacesCount, filteredSpaces } =
    useMemo(() => {
      const filtered = spacesData.filter((space) =>
        space.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      return {
        filteredSpaces: filtered,
        displayedSpaces: showAllSpaces ? filtered : filtered.slice(0, 3),
        hasMoreSpaces: filtered.length > 3,
        hiddenSpacesCount: Math.max(0, filtered.length - 3),
      };
    }, [spacesData, searchQuery, showAllSpaces]);

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
      <div
        className={clsx(
          "flex items-center mb-3",
          sidebarCollapsed ? "justify-center" : "justify-between"
        )}
      >
        <h2
          className={clsx(
            "text-sm font-medium truncate text-gray-12",
            sidebarCollapsed ? "hidden" : "flex"
          )}
        >
          Spaces
        </h2>
        <Tooltip position="right" content="Create space">
          <Button
            className={clsx(
              "p-0 bg-transparent hover:bg-gray-3",
              sidebarCollapsed ? "size-8" : "size-7"
            )}
            onClick={() => {
              setShowSpaceDialog(true);
            }}
          >
            <FontAwesomeIcon
              className={clsx(
                "text-gray-12",
                sidebarCollapsed ? "size-4" : "size-3"
              )}
              icon={faPlus}
            />
          </Button>
        </Tooltip>
      </div>

      <Tooltip
        content="Browse spaces"
        disable={sidebarCollapsed === false}
        position="right"
      >
        <Link
          passHref
          onClick={() => toggleMobileNav?.()}
          prefetch={false}
          href="/dashboard/spaces/browse"
          className={clsx(
            "relative border border-transparent transition z-3",
            sidebarCollapsed
              ? "flex justify-center px-0 mb-2 items-center w-full size-10"
              : "py-2 w-full px-3 mb-2",
            pathname.includes("/dashboard/spaces/browse")
              ? "bg-gray-3 pointer-events-none"
              : "hover:bg-gray-2",
            navItemClass
          )}
        >
          <FontAwesomeIcon
            icon={faShareNodes}
            className={clsx(
              "flex-shrink-0 transition-colors",
              sidebarCollapsed
                ? "text-gray-12 size-[18px] mx-auto"
                : "text-gray-10 size-3.5"
            )}
            aria-hidden="true"
          />
          <p
            className={clsx(
              "text-sm text-gray-12 truncate",
              sidebarCollapsed ? "hidden" : "ml-2.5"
            )}
          >
            Browse spaces
          </p>
        </Link>
      </Tooltip>

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
              ? "max-h-[calc(100vh-450px)] overflow-y-auto"
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
                  "relative transition-colors overflow-visible duration-150 rounded-xl mb-1.5",
                  activeSpaceParams(space.id)
                    ? "hover:bg-gray-3 cursor-default"
                    : "cursor-pointer",
                  activeDropTarget === space.id && "ring-2 ring-blue-500"
                )}
                onDragOver={(e) => handleDragOver(e, space.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, space.id)}
              >
                {activeSpaceParams(space.id) && (
                  <motion.div
                    layoutId="navlinks"
                    className={clsx(
                      "absolute rounded-xl bg-gray-3",
                      sidebarCollapsed
                        ? "inset-0 right-0 left-0 mx-auto"
                        : "inset-0"
                    )}
                    style={{ willChange: "transform" }}
                    transition={{
                      layout: {
                        type: "tween",
                        duration: 0.1,
                      },
                    }}
                  />
                )}
                {activeDropTarget === space.id && (
                  <div className="absolute inset-0 z-10 rounded-xl pointer-events-none bg-blue-500/10" />
                )}
                <Link
                  href={`/dashboard/spaces/${space.id}`}
                  className={clsx(
                    "flex relative z-10 items-center px-2 py-2 truncate rounded-xl transition-colors group",
                    sidebarCollapsed ? "justify-center" : "",
                    activeSpaceParams(space.id)
                      ? "hover:bg-gray-3"
                      : "hover:bg-gray-2"
                  )}
                >
                  {space.iconUrl ? (
                    <Image
                      src={space.iconUrl}
                      alt={space.name}
                      className="relative flex-shrink-0 rounded-full"
                      width={sidebarCollapsed ? 24 : 20}
                      height={sidebarCollapsed ? 24 : 20}
                    />
                  ) : (
                    <Avatar
                      letterClass={clsx(
                        "text-gray-1",
                        sidebarCollapsed ? "text-sm" : "text-[11px]"
                      )}
                      className={clsx(
                        "relative flex-shrink-0",
                        sidebarCollapsed ? "size-6" : "size-5"
                      )}
                      name={space.name}
                    />
                  )}
                  {!sidebarCollapsed && (
                    <>
                      <span className="ml-2.5 text-sm truncate transition-colors text-gray-11 group-hover:text-gray-12">
                        {space.name}
                      </span>
                      <div
                        onClick={(e) => handleDeleteSpace(e, space.id)}
                        className="flex justify-center items-center ml-auto rounded-full opacity-0 transition-opacity group size-6 group-hover:opacity-100 hover:bg-gray-4"
                        aria-label={`Delete ${space.name} space`}
                      >
                        <FontAwesomeIcon
                          icon={faXmark}
                          className="size-3.5 text-gray-8 group:hover:text-gray-12"
                        />
                      </div>
                    </>
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
