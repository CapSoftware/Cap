import { downloadVideo } from "@/actions/videos/download";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { Tooltip } from "@/components/Tooltip";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { VideoMetadata } from "@cap/database/types";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@cap/ui";
import {
  faCheck,
  faEllipsis,
  faLock,
  faTrash,
  faUnlock,
  faVideo
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PropsWithChildren, useState } from "react";
import { toast } from "sonner";
import { PasswordDialog } from "../PasswordDialog";
import { SharingDialog } from "../SharingDialog";
import { CapCardAnalytics } from "./CapCardAnalytics";
import { CapCardButtons } from "./CapCardButtons";
import { CapCardContent } from "./CapCardContent";



export interface CapCardProps extends PropsWithChildren {
  cap: {
    id: string;
    ownerId: string;
    name: string;
    createdAt: Date;
    totalComments: number;
    totalReactions: number;
    sharedOrganizations?: {
      id: string;
      name: string;
      iconUrl?: string | null;
    }[];
    sharedSpaces?: {
      id: string;
      name: string;
      iconUrl?: string | null;
      organizationId: string;
    }[];
    ownerName: string | null;
    metadata?: VideoMetadata;
    hasPassword?: boolean;
  };
  analytics: number;
  onDelete?: (videoId: string) => Promise<void>;
  userId?: string;
  sharedCapCard?: boolean;
  isSelected?: boolean;
  onSelectToggle?: () => void;
  hideSharedStatus?: boolean;
  anyCapSelected?: boolean;
}

export const CapCard = ({
  cap,
  analytics,
  children,
  onDelete,
  userId,
  sharedCapCard = false,
  hideSharedStatus = false,
  isSelected = false,
  onSelectToggle,
  anyCapSelected = false,
}: CapCardProps) => {
  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [passwordProtected, setPasswordProtected] = useState(
    cap.hasPassword || false
  );
  const [copyPressed, setCopyPressed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const router = useRouter();
  const { isSubscribed, setUpgradeModalOpen } = useDashboardContext();

  const displayCount =
    analytics === 0
      ? Math.max(cap.totalComments, cap.totalReactions)
      : analytics;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
  };

  const confirmRemoveCap = async () => {
    if (!onDelete) return;
    setRemoving(true);
    await onDelete(cap.id);
    setRemoving(false);
    setConfirmOpen(false);
  };

  const handleSharingUpdated = () => {
    router.refresh();
  };

  const handlePasswordUpdated = (protectedStatus: boolean) => {
    setPasswordProtected(protectedStatus);
    router.refresh();
  };

  const isOwner = userId === cap.ownerId;

  // Helper function to create a drag preview element
  const createDragPreview = (text: string): HTMLElement => {
    // Create the element
    const element = document.createElement('div');

    // Add text content
    element.textContent = text;

    // Apply Tailwind-like styles directly
    element.className = 'px-2 py-1.5 text-sm font-medium rounded-lg shadow-md text-gray-1 bg-gray-12';

    // Position off-screen
    element.style.position = 'absolute';
    element.style.top = '-9999px';
    element.style.left = '-9999px';

    return element;
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (anyCapSelected || !isOwner) return;

    // Set the data transfer
    e.dataTransfer.setData(
      "application/cap",
      JSON.stringify({
        id: cap.id,
        name: cap.name,
      })
    );

    // Set drag effect to 'move' to avoid showing the + icon
    e.dataTransfer.effectAllowed = 'move';

    // Set the drag image using the helper function
    try {
      const dragPreview = createDragPreview(cap.name);
      document.body.appendChild(dragPreview);
      e.dataTransfer.setDragImage(dragPreview, 10, 10);

      // Clean up after a short delay
      setTimeout(() => document.body.removeChild(dragPreview), 100);
    } catch (error) {
      console.error('Error setting drag image:', error);
    }

    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopyPressed(true);
    setTimeout(() => {
      setCopyPressed(false);
    }, 2000);
  };

  const handleDownload = async () => {
    if (isDownloading) return;

    setIsDownloading(true);

    try {
      toast.promise(
        downloadVideo(cap.id).then(async (response) => {
          if (response.success && response.downloadUrl) {
            const fetchResponse = await fetch(response.downloadUrl);
            const blob = await fetchResponse.blob();

            const blobUrl = window.URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = blobUrl;
            link.download = response.filename;
            link.style.display = "none";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            window.URL.revokeObjectURL(blobUrl);
          }
        }),
        {
          loading: "Preparing download...",
          success: "Download started successfully",
          error: (error) => {
            if (error instanceof Error) {
              return error.message;
            }
            return "Failed to download video - please try again.";
          },
        }
      );
    } catch (error) {
      console.error("Download error:", error);
    } finally {
      setIsDownloading(false);
    }
  };


  const handleCardClick = (e: React.MouseEvent) => {
    if (anyCapSelected) {
      e.preventDefault();
      e.stopPropagation();
      if (onSelectToggle) {
        onSelectToggle();
      }
    }
  };

  const handleSelectClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onSelectToggle) {
      onSelectToggle();
    }
  };

  return (
    <>
      <SharingDialog
        isOpen={isSharingDialogOpen}
        onClose={() => setIsSharingDialogOpen(false)}
        capId={cap.id}
        capName={cap.name}
        sharedSpaces={cap.sharedSpaces || []}
        onSharingUpdated={handleSharingUpdated}
      />
      <PasswordDialog
        isOpen={isPasswordDialogOpen}
        onClose={() => setIsPasswordDialogOpen(false)}
        videoId={cap.id}
        hasPassword={passwordProtected}
        onPasswordUpdated={handlePasswordUpdated}
      />
      <div
        onClick={handleCardClick}
        draggable={isOwner && !anyCapSelected}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        className={clsx(
          "flex relative flex-col gap-4 w-full h-full rounded-xl cursor-default bg-gray-1 border-gray-3 group border-px",
          isSelected
            ? "!border-blue-10 border-px"
            : anyCapSelected
              ? "border-blue-10 border-px hover:border-blue-10"
              : "hover:border-blue-10",
          isDragging && "opacity-50",
          isOwner && !anyCapSelected && "cursor-grab active:cursor-grabbing"
        )}
      >
        {anyCapSelected && !sharedCapCard && (
          <div
            className="absolute inset-0 z-10"
            onClick={handleCardClick}
          />
        )}
        {!sharedCapCard && (
          <div
            className={clsx(
              "flex absolute duration-200",
              anyCapSelected
                ? "opacity-0"
                : isDropdownOpen
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100",
              "top-2 right-2 flex-col gap-2 z-[20]"
            )}
          >
            <CapCardButtons
              capId={cap.id}
              copyPressed={copyPressed}
              isDownloading={isDownloading}
              handleCopy={handleCopy}
              handleDownload={handleDownload}
            />

            <DropdownMenu modal={false} onOpenChange={setIsDropdownOpen}>
              <Tooltip content="More options">
                <DropdownMenuTrigger asChild>
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    className={clsx("!size-8 hover:bg-gray-5 hover:border-gray-7 rounded-full min-w-fit !p-0 delay-75",
                      isDropdownOpen ? "bg-gray-5 border-gray-7" : ""
                    )}
                    variant="white"
                    size="sm"
                    aria-label="More options"
                  >
                    <FontAwesomeIcon className="text-gray-12 size-4" icon={faEllipsis} />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>

              <DropdownMenuContent
                align="end"
                sideOffset={5}
              >
                <DropdownMenuItem
                  onClick={(e) => {
                    if (!isSubscribed) {
                      setUpgradeModalOpen(true);
                    } else {
                      setIsPasswordDialogOpen(true);
                    }
                  }}
                  className="flex gap-2 items-center rounded-lg"
                >
                  <FontAwesomeIcon
                    className="size-3"
                    icon={passwordProtected ? faLock : faUnlock}
                  />
                  <p className="text-sm text-gray-12">{passwordProtected ? "Edit password" : "Add password"}</p>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    handleDeleteClick(e);
                  }}
                  className="flex gap-2 items-center rounded-lg"
                >
                  <FontAwesomeIcon className="size-3" icon={faTrash} />
                  <p className="text-sm text-gray-12">Delete Cap</p>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmationDialog
              open={confirmOpen}
              icon={<FontAwesomeIcon icon={faVideo} />}
              title="Delete Cap"
              description={`Are you sure you want to delete the cap "${cap.name}"? This action cannot be undone.`}
              confirmLabel="Delete"
              cancelLabel="Cancel"
              loading={removing}
              onConfirm={confirmRemoveCap}
              onCancel={() => setConfirmOpen(false)}
            />
          </div>
        )}
        {!sharedCapCard && onSelectToggle && (
          <div
            className={clsx(
              "absolute top-2 left-2 z-[20] duration-200",
              isSelected || anyCapSelected || isDropdownOpen
                ? "opacity-100"
                : "group-hover:opacity-100 opacity-0"
            )}
            onClick={(e) => {
              e.stopPropagation();
              handleSelectClick(e);
            }}
          >
            <div
              className={clsx(
                "flex justify-center items-center w-6 h-6 rounded-md border transition-colors cursor-pointer hover:bg-gray-3/60",
                isSelected
                  ? "bg-blue-10 border-blue-10"
                  : "border-white-95 bg-gray-1/80"
              )}
            >
              {isSelected && (
                <FontAwesomeIcon icon={faCheck} className="text-white size-3" />
              )}
            </div>
          </div>
        )}
        <Link
          className={clsx(
            "block group",
            anyCapSelected && "cursor-pointer pointer-events-none"
          )}
          href={`/s/${cap.id}`}
        >
          <VideoThumbnail
            imageClass={clsx(
              anyCapSelected ? "opacity-50" : isDropdownOpen ? "opacity-30" : "group-hover:opacity-30",
              "transition-opacity duration-200"
            )}
            userId={cap.ownerId}
            videoId={cap.id}
            alt={`${cap.name} Thumbnail`}
          />
        </Link>
        <div
          className={clsx(
            "flex flex-col flex-grow gap-3 px-4 pb-4 w-full",
            !sharedCapCard ? "cursor-pointer" : "cursor-default"
          )}
        >
          <CapCardContent
            cap={cap}
            userId={userId}
            sharedCapCard={sharedCapCard}
            hideSharedStatus={hideSharedStatus}
            isOwner={isOwner}
            setIsSharingDialogOpen={setIsSharingDialogOpen}
          />
          {children}
          <CapCardAnalytics
            capId={cap.id}
            displayCount={displayCount}
            totalComments={cap.totalComments}
            totalReactions={cap.totalReactions}
          />
        </div>
      </div>
    </>
  );
};
