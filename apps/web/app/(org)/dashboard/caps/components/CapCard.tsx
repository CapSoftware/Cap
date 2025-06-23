import { editDate } from "@/actions/videos/edit-date";
import { editTitle } from "@/actions/videos/edit-title";
import { Tooltip } from "@/components/Tooltip";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { VideoMetadata } from "@cap/database/types";
import { buildEnv, NODE_ENV } from "@cap/env";
import { Button } from "@cap/ui";
import {
  faCheck,
  faChevronDown,
  faLink,
  faTrash,
  faLock,
  faUnlock,
  faVideo,
  faDownload
} from "@fortawesome/free-solid-svg-icons";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import moment from "moment";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PropsWithChildren, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { downloadVideo } from "@/actions/videos/download";
import { CapCardAnalytics } from "./CapCardAnalytics";
import { SharingDialog } from "./SharingDialog";
import { PasswordDialog } from "./PasswordDialog";

interface Props extends PropsWithChildren {
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
}: Props) => {
  const effectiveDate = cap.metadata?.customCreatedAt
    ? new Date(cap.metadata.customCreatedAt)
    : cap.createdAt;

  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(cap.name);
  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [passwordProtected, setPasswordProtected] = useState(
    cap.hasPassword || false
  );
  const [isDateEditing, setIsDateEditing] = useState(false);
  const [copyPressed, setCopyPressed] = useState(false);
  const [dateValue, setDateValue] = useState(
    moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss")
  );
  const [showFullDate, setShowFullDate] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const router = useRouter();
  const { isSubscribed, setUpgradeModalOpen } = useDashboardContext();

  const handleTitleBlur = async (capName: string) => {
    if (!title || capName === title) {
      setIsEditing(false);
      return;
    }

    try {
      await editTitle(cap.id, title);
      toast.success("Video title updated");
      setIsEditing(false);
      router.refresh();
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("Failed to update title - please try again.");
      }
    }
  };

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

  const handleSharingUpdated = (updatedSharedSpaces: string[]) => {
    router.refresh();
  };

  const handlePasswordUpdated = (protectedStatus: boolean) => {
    setPasswordProtected(protectedStatus);
    router.refresh();
  };

  const isOwner = userId === cap.ownerId;

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (anyCapSelected || !isOwner) return;

    e.dataTransfer.setData(
      "application/cap",
      JSON.stringify({
        id: cap.id,
        name: cap.name,
      })
    );

    setIsDragging(true);

    // Create a smaller drag image
    const dragImage = new Image();
    dragImage.src = `https://cap-api-thumbnails.s3.us-west-2.amazonaws.com/${cap.id}/thumbnail.png`;
    dragImage.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 60;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(dragImage, 0, 0, 100, 60);
        const dataURL = canvas.toDataURL();
        const img = new Image();
        img.src = dataURL;
        e.dataTransfer.setDragImage(img, 50, 30);
      }
    };
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  const renderSharedStatus = () => {
    const baseClassName = clsx(
      "text-sm text-gray-10 transition-colors duration-200 flex items-center mb-1",
      "hover:text-gray-12",
      hideSharedStatus ? "pointer-events-none" : "cursor-pointer"
    );
    if (isOwner && !hideSharedStatus) {
      if (
        (cap.sharedOrganizations?.length === 0 || !cap.sharedOrganizations) &&
        (cap.sharedSpaces?.length === 0 || !cap.sharedSpaces)
      ) {
        return (
          <p
            className={baseClassName}
            onClick={() => setIsSharingDialogOpen(true)}
          >
            Not shared{" "}
            <FontAwesomeIcon className="ml-2 size-2.5" icon={faChevronDown} />
          </p>
        );
      } else {
        return (
          <p
            className={baseClassName}
            onClick={() => setIsSharingDialogOpen(true)}
          >
            Shared{" "}
            <FontAwesomeIcon className="ml-1 size-2.5" icon={faChevronDown} />
          </p>
        );
      }
    } else {
      return <p className={baseClassName}>Shared with you</p>;
    }
  };

  const handleDateClick = () => {
    if (userId === cap.ownerId) {
      if (!isDateEditing) {
        setIsDateEditing(true);
      }
    } else {
      setShowFullDate(!showFullDate);
    }
  };

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDateValue(e.target.value);
  };

  const handleDateBlur = async () => {
    const isValidDate = moment(dateValue).isValid();

    if (!isValidDate) {
      toast.error("Invalid date format. Please use YYYY-MM-DD HH:mm:ss");
      setDateValue(moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss"));
      setIsDateEditing(false);
      return;
    }

    const selectedDate = moment(dateValue);
    const currentDate = moment();

    if (selectedDate.isAfter(currentDate)) {
      toast.error("Cannot set a date in the future");
      setDateValue(moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss"));
      setIsDateEditing(false);
      return;
    }

    if (selectedDate.isSame(effectiveDate)) {
      setIsDateEditing(false);
      return;
    }

    try {
      await editDate(cap.id, selectedDate.toISOString());
      toast.success("Video date updated");
      setIsDateEditing(false);
      router.refresh();
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("Failed to update date - please try again.");
      }
    }
  };

  const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleDateBlur();
    } else if (e.key === "Escape") {
      setDateValue(moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss"));
      setIsDateEditing(false);
    }
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

  const handleTitleKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    capName: string
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTitleBlur(capName);
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
          "flex relative flex-col gap-4 w-full h-full rounded-xl cursor-default bg-gray-1 border-gray-3 group border-[1px]",
          isSelected
            ? "!border-blue-10 border-[1px]"
            : anyCapSelected
              ? "border-blue-10 border-[1px] hover:border-blue-10"
              : "hover:border-blue-10",
          isDragging && "opacity-50",
          isOwner && !anyCapSelected && "cursor-grab active:cursor-grabbing"
        )}
      >
        {anyCapSelected && !sharedCapCard && (
          <div
            className="absolute inset-0 z-10"
            onClick={handleCardClick}
          ></div>
        )}
        {!sharedCapCard && (
          <div
            className={clsx(
              "flex absolute duration-200",
              anyCapSelected
                ? "opacity-0"
                : "opacity-0 group-hover:opacity-100",
              "top-2 right-2 flex-col gap-1 z-[20]"
            )}
          >
            <Tooltip content="Copy link">
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopy(
                    buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
                      ? `https://cap.link/${cap.id}`
                      : `${location.origin}/s/${cap.id}`
                  );
                }}
                className="!size-8 delay-0 hover:opacity-80 rounded-full min-w-fit !p-0"
                variant="white"
                size="sm"
              >
                {!copyPressed ? (
                  <FontAwesomeIcon
                    className="text-gray-12 size-4"
                    icon={faLink}
                  />
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-gray-12 size-5 svgpathanimation"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </Button>
            </Tooltip>
            <Tooltip content="Download Cap">
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                disabled={isDownloading}
                className="!size-8 delay-25 hover:opacity-80 rounded-full min-w-fit !p-0"
                variant="white"
                size="sm"
              >
                {isDownloading ? (
                  <div className="animate-spin size-3">
                    <svg
                      className="size-3"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="m2 12c0-5.523 4.477-10 10-10v3c-3.866 0-7 3.134-7 7s3.134 7 7 7 7-3.134 7-7c0-1.457-.447-2.808-1.208-3.926l2.4-1.6c1.131 1.671 1.808 3.677 1.808 5.526 0 5.523-4.477 10-10 10s-10-4.477-10-10z"
                      ></path>
                    </svg>
                  </div>
                ) : (
                  <FontAwesomeIcon
                    className="text-gray-12 size-3"
                    icon={faDownload}
                  />
                )}
              </Button>
            </Tooltip>
            <Tooltip
              content={
                passwordProtected ? "Edit password" : "Add password to access"
              }
            >
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isSubscribed) {
                    setUpgradeModalOpen(true);
                  } else {
                    setIsPasswordDialogOpen(true);
                  }
                }}
                className="!size-8 delay-50 hover:opacity-80 rounded-full min-w-fit !p-0"
                variant="white"
                size="sm"
              >
                <FontAwesomeIcon
                  className={`size-3 ${passwordProtected ? "text-amber-600" : "text-gray-12"
                    }`}
                  icon={passwordProtected ? faLock : faUnlock}
                />
              </Button>
            </Tooltip>
            <Tooltip content="Delete Cap">
              <Button
                onClick={handleDeleteClick}
                className="!size-8 delay-75 hover:opacity-80 rounded-full min-w-fit !p-0"
                variant="white"
                size="sm"
              >
                <FontAwesomeIcon
                  className="text-gray-12 size-2.5"
                  icon={faTrash}
                />
              </Button>
            </Tooltip>
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
            className={`absolute top-2 left-2 z-[20] duration-200 ${isSelected || anyCapSelected
              ? "opacity-100"
              : "group-hover:opacity-100 opacity-0"
              }`}
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
            imageClass={`${anyCapSelected ? "opacity-50" : "group-hover:opacity-50"
              } transition-opacity duration-200`}
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
          <div>
            <div className="h-[1.25rem] mb-1">
              {" "}
              {/* Fixed height container */}
              {isEditing && !sharedCapCard ? (
                <textarea
                  rows={1}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => handleTitleBlur(cap.name)}
                  onKeyDown={(e) => handleTitleKeyDown(e, cap.name)}
                  autoFocus
                  className="text-md resize-none bg-transparent truncate w-full border-0 outline-0 text-gray-12 font-medium p-0 m-0 h-[1.25rem] overflow-hidden leading-[1.25rem] tracking-normal font-[inherit]"
                />
              ) : (
                <p
                  className="text-md truncate leading-[1.25rem] text-gray-12 font-medium p-0 m-0 h-[1.25rem] tracking-normal"
                  onClick={() => {
                    if (!sharedCapCard) {
                      if (userId === cap.ownerId) {
                        setIsEditing(true);
                      }
                    }
                  }}
                >
                  {title}
                </p>
              )}
            </div>

            {renderSharedStatus()}
            <div className="mb-1 h-[1.5rem]">
              {" "}
              {isDateEditing && !sharedCapCard ? (
                <div className="flex items-center h-full">
                  <input
                    type="text"
                    value={dateValue}
                    onChange={handleDateChange}
                    onBlur={handleDateBlur}
                    onKeyDown={handleDateKeyDown}
                    autoFocus
                    className="text-sm w-full truncate text-gray-10 bg-transparent focus:outline-none h-full leading-[1.5rem]"
                    placeholder="YYYY-MM-DD HH:mm:ss"
                  />
                </div>
              ) : (
                <Tooltip content={`Cap created at ${effectiveDate}`}>
                  <p
                    className="text-sm truncate text-gray-10 cursor-pointer flex items-center h-full leading-[1.5rem]"
                    onClick={handleDateClick}
                  >
                    {showFullDate
                      ? moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss")
                      : moment(effectiveDate).fromNow()}
                  </p>
                </Tooltip>
              )}
            </div>
          </div>
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
