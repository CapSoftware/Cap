import { editDate } from "@/actions/videos/edit-date";
import { editTitle } from "@/actions/videos/edit-title";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { CapCardAnalytics } from "@/app/dashboard/caps/components/CapCardAnalytics";
import { SharingDialog } from "@/app/dashboard/caps/components/SharingDialog";
import { Tooltip } from "@/components/Tooltip";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { VideoMetadata } from "@cap/database/types";
import { clientEnv, NODE_ENV } from "@cap/env";
import { Button } from "@cap/ui";
import {
  faChevronDown,
  faLink,
  faTrash,
  faCheck,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import moment from "moment";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "react-hot-toast";

export interface CapCardProps {
  cap: {
    id: string;
    ownerId: string;
    name: string;
    createdAt: Date;
    totalComments: number;
    totalReactions: number;
    sharedSpaces?: { id: string; name: string }[];
    ownerName: string | null;
    metadata?: VideoMetadata;
  };
  children?: React.ReactNode;
  analytics: number;
  onDelete?: (videoId: string) => Promise<void>;
  userId?: string;
  userSpaces?: { id: string; name: string }[];
  sharedCapCard?: boolean;
  isSelected?: boolean;
  onSelectToggle?: () => void;
  anyCapSelected?: boolean;
}

export const CapCard: React.FC<CapCardProps> = ({
  cap,
  analytics,
  children,
  onDelete,
  userId,
  userSpaces,
  sharedCapCard = false,
  isSelected = false,
  onSelectToggle,
  anyCapSelected = false,
}) => {
  const effectiveDate = cap.metadata?.customCreatedAt
    ? new Date(cap.metadata.customCreatedAt)
    : cap.createdAt;

  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(cap.name);
  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
  const [sharedSpaces, setSharedSpaces] = useState(cap.sharedSpaces);
  const [isDateEditing, setIsDateEditing] = useState(false);
  const [copyPressed, setCopyPressed] = useState(false);
  const [dateValue, setDateValue] = useState(
    moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss")
  );
  const [showFullDate, setShowFullDate] = useState(false);
  const router = useRouter();
  const { activeSpace } = useSharedContext();

  const handleTitleBlur = async (capName: string) => {
    if (capName === title) return;
    if (!title) {
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

  const handleSharingUpdated = (updatedSharedSpaces: string[]) => {
    setSharedSpaces(
      userSpaces?.filter((space) => updatedSharedSpaces.includes(space.id))
    );
    router.refresh(); // Add this line to refresh the page
  };

  const isOwner = userId === cap.ownerId;

  const renderSharedStatus = () => {
    const baseClassName = clsx(
      "text-sm text-gray-10 transition-colors duration-200 flex items-center mb-1",
      sharedCapCard ? "cursor-default" : "hover:text-gray-12 cursor-pointer"
    );
    if (isOwner) {
      if (cap.sharedSpaces?.length === 0) {
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

  const handleTitleKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    capName: string
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTitleBlur(capName);
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
        sharedSpaces={sharedSpaces || []}
        userSpaces={userSpaces}
        onSharingUpdated={handleSharingUpdated}
      />
      <div className={`flex relative cursor-default flex-col gap-4 w-full h-full bg-gray-2 rounded-xl border-gray-3 group border-[1px] ${
        isSelected
          ? "border-blue-8 border-[1px]"
          : anyCapSelected
          ? "border-blue-5 border-[1px]"
          : "hover:border-blue-8"
      }`}>
        {!sharedCapCard && (
          <div className={`flex absolute duration-200 ${
            anyCapSelected ? "opacity-100" : "group-hover:opacity-100 opacity-0"
          } top-2 right-2 z-[20] flex-col gap-2`}>
            <Tooltip content="Copy link">
              <Button
                onClick={() =>
                  handleCopy(
                    activeSpace?.space.customDomain
                      ? `https://${activeSpace.space.customDomain}/s/${cap.id}`
                      : clientEnv.NEXT_PUBLIC_IS_CAP &&
                        NODE_ENV === "production"
                      ? `https://cap.link/${cap.id}`
                      : `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${cap.id}`
                  )
                }
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
            <Tooltip content="Delete Cap">
              <Button
                onClick={() => onDelete?.(cap.id)}
                className="!size-8 delay-100 hover:opacity-80 rounded-full min-w-fit !p-0"
                variant="white"
                size="sm"
              >
                <FontAwesomeIcon
                  className="text-gray-12 size-2.5"
                  icon={faTrash}
                />
              </Button>
            </Tooltip>
          </div>
        )}

        {/* Selection checkbox */}
        {!sharedCapCard && onSelectToggle && (
          <div
            className={`absolute top-2 left-2 z-[20] duration-200 ${
              isSelected || anyCapSelected
                ? "opacity-100"
                : "group-hover:opacity-100 opacity-0"
            }`}
            onClick={handleSelectClick}
          >
            <div
              className={`flex items-center justify-center w-6 h-6 rounded-md border cursor-pointer hover:bg-gray-3/60 transition-colors ${
                isSelected
                  ? "bg-blue-8 border-blue-8"
                  : "border-gray-8 bg-gray-1/80"
              }`}
            >
              {isSelected && (
                <FontAwesomeIcon icon={faCheck} className="text-white size-3" />
              )}
            </div>
          </div>
        )}
        <Link
          className="block group"
          href={
            activeSpace?.space.customDomain
              ? `https://${activeSpace.space.customDomain}/s/${cap.id}`
              : clientEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
              ? `https://cap.link/${cap.id}`
              : `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${cap.id}`
          }
        >
          <VideoThumbnail
            imageClass={`${
              anyCapSelected ? "opacity-50" : "group-hover:opacity-50"
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
            {isEditing && !sharedCapCard ? (
              <textarea
                rows={1}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => handleTitleBlur(cap.name)}
                onKeyDown={(e) => handleTitleKeyDown(e, cap.name)}
                autoFocus
                className="text-md resize-none bg-transparent truncate w-full border-0 outline-0 leading-[1.25rem] text-gray-12 font-medium mb-1"
              />
            ) : (
              <p
                className="text-md truncate leading-[1.25rem] text-gray-12 font-medium mb-1"
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
            {renderSharedStatus()}
            <div className="mb-1">
              {isDateEditing && !sharedCapCard ? (
                <div className="flex items-center">
                  <input
                    type="text"
                    value={dateValue}
                    onChange={handleDateChange}
                    onBlur={handleDateBlur}
                    onKeyDown={handleDateKeyDown}
                    autoFocus
                    className="text-sm truncate mt-2 leading-[1.25rem] text-gray-10 bg-transparent focus:outline-none"
                    placeholder="YYYY-MM-DD HH:mm:ss"
                  />
                </div>
              ) : (
                <Tooltip content={`Cap created at ${effectiveDate}`}>
                  <p
                    className="text-sm truncate mt-2 leading-[1.25rem] text-gray-10 cursor-pointer flex items-center"
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
