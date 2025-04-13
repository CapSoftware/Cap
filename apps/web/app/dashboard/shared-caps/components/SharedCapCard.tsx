import { useState } from "react";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { CapCardAnalytics } from "@/app/dashboard/caps/components/CapCardAnalytics";
import moment from "moment";
import { Tooltip } from "react-tooltip";
import { serverEnv, clientEnv, NODE_ENV } from "@cap/env";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { VideoMetadata } from "@cap/database/types";

interface SharedCapCardProps {
  cap: {
    id: string;
    ownerId: string;
    name: string;
    createdAt: Date;
    totalComments: number;
    totalReactions: number;
    ownerName: string | null;
    metadata?: VideoMetadata;
  };
  analytics: number;
  spaceName: string;
}

export const SharedCapCard: React.FC<SharedCapCardProps> = ({
  cap,
  analytics,
  spaceName,
}) => {
  // Get the effective date (custom or original)
  const effectiveDate = cap.metadata?.customCreatedAt
    ? new Date(cap.metadata.customCreatedAt)
    : cap.createdAt;

  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(cap.name);
  const { activeSpace } = useSharedContext();

  const displayCount =
    analytics === 0
      ? Math.max(cap.totalComments, cap.totalReactions)
      : analytics;

  return (
    <div
      className="rounded-xl border-[1px] border-gray-200 relative"
      style={{ boxShadow: "0px 8px 16px rgba(18, 22, 31, 0.04)" }}
    >
      <a
        className="group block"
        href={
          activeSpace?.space.customDomain && activeSpace.space.domainVerified
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
      </a>
      <div className="flex flex-col p-4">
        <div className="mb-2">
          {cap.ownerName && (
            <div>
              <span className="text-[0.875rem] leading-[1.25rem] text-gray-400">
                {cap.ownerName}
              </span>
            </div>
          )}
          <div>
            <span className="text-[0.875rem] leading-[1.25rem] text-gray-400">
              Shared with {spaceName}
            </span>
          </div>
        </div>
        <p className="text-[0.875rem] leading-[1.25rem] text-gray-500 font-medium">
          {title}
        </p>
        <p>
          <span
            className="text-[0.875rem] leading-[1.25rem] text-gray-400"
            data-tooltip-id={cap.id + "_createdAt"}
            data-tooltip-content={`Cap created at ${effectiveDate}`}
          >
            {moment(effectiveDate).fromNow()}
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
    </div>
  );
};
