import { useState } from "react";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { CapCardActions } from "@/app/dashboard/caps/components/CapCardActions";
import { CapCardAnalytics } from "@/app/dashboard/caps/components/CapCardAnalytics";
import { toast } from "react-hot-toast";
import moment from "moment";
import { Tooltip } from "react-tooltip";
import { ShareIcon, ChevronDown } from "lucide-react";
import { SharingDialog } from "@/app/dashboard/caps/components/SharingDialog";
import { useRouter } from "next/navigation"; // Add this import
import { serverEnv, clientEnv, NODE_ENV } from "@cap/env";

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
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(cap.name);
  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
  const [sharedSpaces, setSharedSpaces] = useState(cap.sharedSpaces);
  const router = useRouter(); // Add this line

  const handleTitleBlur = async () => {
    if (!title) {
      setIsEditing(false);
      return;
    }

    const response = await fetch(
      `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/video/title`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, videoId: cap.id }),
      }
    );
    if (!response.ok) {
      toast.error("Failed to update title - please try again.");
      return;
    }

    toast.success("Video title updated");
    setIsEditing(false);
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

  const renderSharedStatus = () => {
    const baseClassName =
      "text-gray-400 text-sm cursor-pointer flex items-center";
    if (isOwner) {
      if (cap.sharedSpaces.length === 0) {
        return (
          <span
            className={baseClassName}
            onClick={() => setIsSharingDialogOpen(true)}
          >
            Not shared <ChevronDown className="ml-1" size={16} />
          </span>
        );
      } else {
        return (
          <span
            className={baseClassName}
            onClick={() => setIsSharingDialogOpen(true)}
          >
            Shared <ChevronDown className="ml-1" size={16} />
          </span>
        );
      }
    } else {
      return <span className={baseClassName}>Shared with you</span>;
    }
  };

  const handleSharingUpdated = (updatedSharedSpaces: string[]) => {
    setSharedSpaces(
      userSpaces.filter((space) => updatedSharedSpaces.includes(space.id))
    );
    router.refresh(); // Add this line to refresh the page
  };

  return (
    <div
      className="rounded-xl border-[1px] border-gray-200 relative"
      style={{ boxShadow: "0px 8px 16px rgba(18, 22, 31, 0.04)" }}
    >
      <CapCardActions capId={cap.id} onDelete={onDelete} />
      <a
        className="group block"
        href={
          clientEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
            ? `https://cap.link/${cap.id}`
            : `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${cap.id}`
        }
      >
        <VideoThumbnail
          userId={cap.ownerId}
          videoId={cap.id}
          alt={`${cap.name} Thumbnail`}
        />
      </a>
      <div className="flex flex-col p-4">
        <div className="mb-2">
          <div>
            <span className="text-[0.875rem] leading-[1.25rem] text-gray-400">
              {isOwner ? cap.ownerName : cap.sharedSpaces[0]?.name}
            </span>
          </div>
          <div>
            <span>{renderSharedStatus()}</span>
          </div>
        </div>
        {isEditing ? (
          <textarea
            rows={1}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            autoFocus
            className="text-[0.875rem] leading-[1.25rem] text-gray-500 font-medium box-border"
          />
        ) : (
          <p
            className="text-[0.875rem] leading-[1.25rem] text-gray-500 font-medium"
            onClick={() => {
              if (userId === cap.ownerId) {
                setIsEditing(true);
              }
            }}
          >
            {title}
          </p>
        )}
        <p>
          <span
            className="text-[0.875rem] leading-[1.25rem] text-gray-400"
            data-tooltip-id={cap.id + "_createdAt"}
            data-tooltip-content={`Cap created at ${cap.createdAt}`}
          >
            {moment(cap.createdAt).fromNow()}
          </span>
          <Tooltip id={cap.id + "_createdAt"} />
        </p>
        <CapCardAnalytics
          capId={cap.id}
          displayCount={displayCount}
          totalComments={cap.totalComments}
          totalReactions={cap.totalReactions}
        />
      </div>
      <SharingDialog
        isOpen={isSharingDialogOpen}
        onClose={() => setIsSharingDialogOpen(false)}
        capId={cap.id}
        capName={cap.name}
        sharedSpaces={sharedSpaces}
        userSpaces={userSpaces}
        onSharingUpdated={handleSharingUpdated}
      />
    </div>
  );
};
