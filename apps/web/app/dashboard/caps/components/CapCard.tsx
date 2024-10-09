import { useState } from "react";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { CapCardActions } from "@/app/dashboard/caps/components/CapCardActions";
import { CapCardAnalytics } from "@/app/dashboard/caps/components/CapCardAnalytics";
import { toast } from "react-hot-toast";
import moment from "moment";
import { Tooltip } from "react-tooltip";
import { ShareIcon } from "lucide-react";

interface CapCardProps {
  cap: {
    id: string;
    ownerId: string;
    name: string;
    createdAt: Date;
    totalComments: number;
    totalReactions: number;
    sharedSpaces: { id: string; name: string }[];
  };
  analytics: number;
  onDelete: (videoId: string) => Promise<void>;
  userId: string;
}

export const CapCard: React.FC<CapCardProps> = ({
  cap,
  analytics,
  onDelete,
  userId,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(cap.name);

  const handleTitleBlur = async () => {
    if (!title) {
      setIsEditing(false);
      return;
    }

    const response = await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/video/title`,
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

  return (
    <div
      className="rounded-xl border-[1px] border-gray-200 relative"
      style={{ boxShadow: "0px 8px 16px rgba(18, 22, 31, 0.04)" }}
    >
      <CapCardActions capId={cap.id} onDelete={onDelete} />
      <a
        className="group block"
        href={
          process.env.NEXT_PUBLIC_IS_CAP &&
          process.env.NEXT_ENV === "production"
            ? `https://cap.link/${cap.id}`
            : `${process.env.NEXT_PUBLIC_URL}/s/${cap.id}`
        }
      >
        <VideoThumbnail
          userId={cap.ownerId}
          videoId={cap.id}
          alt={`${cap.name} Thumbnail`}
        />
      </a>
      <div className="flex flex-col p-4">
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
        {cap.sharedSpaces.length > 0 && (
          <div className="mt-2 flex items-center">
            <ShareIcon className="w-4 h-4 mr-2 text-gray-400" />
            <span className="text-[0.875rem] leading-[1.25rem] text-gray-400">
              Shared to:{" "}
              {cap.sharedSpaces.map((space) => space.name).join(", ")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
