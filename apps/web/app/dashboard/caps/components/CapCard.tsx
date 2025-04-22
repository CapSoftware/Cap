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
import { faLink, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import moment from "moment";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "react-hot-toast";

interface CapCardProps {
  cap: {
    id: string;
    ownerId: string;
    name: string;
    createdAt: Date;
    totalComments: number;
    totalReactions: number;
    sharedSpaces: { id: string; name: string }[];
    ownerName: string;
    metadata?: VideoMetadata;
  };
  analytics: number;
  onDelete: (videoId: string) => Promise<void>;
  userId: string;
  userSpaces: { id: string; name: string }[];
}

export const CapCard: React.FC<CapCardProps> = ({
  cap,
  analytics,
  onDelete,
  userId,
  userSpaces,
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

  const handleTitleBlur = async () => {
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

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTitleBlur();
    }
  };

  const displayCount =
    analytics === 0
      ? Math.max(cap.totalComments, cap.totalReactions)
      : analytics;

  const isOwner = userId === cap.ownerId;

  const handleSharingUpdated = (updatedSharedSpaces: string[]) => {
    setSharedSpaces(
      userSpaces.filter((space) => updatedSharedSpaces.includes(space.id))
    );
    router.refresh(); // Add this line to refresh the page
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

  return (
    <>
      <SharingDialog
        isOpen={isSharingDialogOpen}
        onClose={() => setIsSharingDialogOpen(false)}
        capId={cap.id}
        capName={cap.name}
        sharedSpaces={sharedSpaces}
        userSpaces={userSpaces}
        onSharingUpdated={handleSharingUpdated}
      />
      <div className="relative rounded-2xl flex flex-col gap-4 w-full h-full p-4 border-gray-200 bg-gray-50 border-[1px]">
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
            userId={cap.ownerId}
            videoId={cap.id}
            alt={`${cap.name} Thumbnail`}
          />
        </Link>
        <div className="flex flex-col flex-grow gap-3 w-full">
          <div>
            {isEditing ? (
              <textarea
                rows={1}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={handleTitleBlur}
                onKeyDown={handleTitleKeyDown}
                autoFocus
                className="text-md truncate leading-[1.25rem] text-gray-500 font-medium box-border mb-1"
              />
            ) : (
              <p
                className="text-md truncate leading-[1.25rem] text-gray-500 font-medium mb-1"
                onClick={() => {
                  if (userId === cap.ownerId) {
                    setIsEditing(true);
                  }
                }}
              >
                {title}
              </p>
            )}
            <p className="mb-1">
              {isDateEditing ? (
                <div className="flex items-center">
                  <input
                    type="text"
                    value={dateValue}
                    onChange={handleDateChange}
                    onBlur={handleDateBlur}
                    onKeyDown={handleDateKeyDown}
                    autoFocus
                    className="text-sm truncate leading-[1.25rem] text-gray-400 bg-transparent focus:outline-none"
                    placeholder="YYYY-MM-DD HH:mm:ss"
                  />
                </div>
              ) : (
                <Tooltip content={`Cap created at ${effectiveDate}`}>
                  <span
                    className="text-sm truncate leading-[1.25rem] text-gray-400 cursor-pointer flex items-center"
                    onClick={handleDateClick}
                  >
                    {showFullDate
                      ? moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss")
                      : moment(effectiveDate).fromNow()}
                  </span>
                </Tooltip>
              )}
            </p>
          </div>
          <CapCardAnalytics
            capId={cap.id}
            displayCount={displayCount}
            totalComments={cap.totalComments}
            totalReactions={cap.totalReactions}
          />
        </div>
        <div className="flex flex-wrap gap-5 justify-between items-center mt-auto w-full">
          <Button
            onClick={() => setIsSharingDialogOpen(true)}
            className="flex-1 h-10 rounded-xl"
            variant="dark"
            size="sm"
          >
            <FontAwesomeIcon
              className="mr-1 text-gray-300 size-4"
              icon={faLink}
            />
            {isOwner
              ? cap.sharedSpaces.length === 0
                ? "Not shared"
                : "Shared"
              : "Shared with you"}
          </Button>
          <div className="flex flex-1 gap-3 justify-end">
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
                className="h-10 rounded-xl min-w-fit"
                variant="white"
                size="sm"
              >
                {!copyPressed ? (
                  <FontAwesomeIcon
                    className="mr-1 text-gray-400 size-4"
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
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    className="text-gray-400 size-5 svgpathanimation"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </Button>
            </Tooltip>
            <Tooltip content="Delete Cap">
              <Button
                onClick={() => onDelete?.(cap.id)}
                className="h-10 rounded-xl min-w-fit"
                variant="white"
                size="sm"
              >
                <FontAwesomeIcon
                  className="mr-1 text-gray-400 size-4"
                  icon={faTrash}
                />
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
    </>
  );
};
