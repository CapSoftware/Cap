import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { CapCardAnalytics } from "@/app/dashboard/caps/components/CapCardAnalytics";
import { Tooltip } from "@/components/Tooltip";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { usePublicEnv } from "@/utils/public-env";
import { VideoMetadata } from "@cap/database/types";
import { buildEnv, NODE_ENV } from "@cap/env";
import { faBuilding, faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import moment from "moment";

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

  const { activeSpace } = useSharedContext();
  const publicEnv = usePublicEnv();

  const displayCount =
    analytics === 0
      ? Math.max(cap.totalComments, cap.totalReactions)
      : analytics;

  return (
    <div className="relative rounded-2xl flex flex-col gap-4 w-full h-full border-gray-200 bg-gray-50 border-[1px]">
      <a
        className="block group"
        href={
          activeSpace?.space.customDomain && activeSpace.space.domainVerified
            ? `https://${activeSpace.space.customDomain}/s/${cap.id}`
            : buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
            ? `https://cap.link/${cap.id}`
            : `${publicEnv.webUrl}/s/${cap.id}`
        }
      >
        <VideoThumbnail
          userId={cap.ownerId}
          videoId={cap.id}
          alt={`${cap.name} Thumbnail`}
        />
      </a>
      <div className="flex flex-col flex-grow gap-3 px-4 pb-4 w-full">
        <div className="flex flex-col gap-1">
          <p className="text-md truncate leading-[1.25rem] text-gray-500 font-medium">
            {cap.name}
          </p>
          <Tooltip content={`Cap created at ${effectiveDate}`}>
            <span className="text-sm truncate leading-[1.25rem] text-gray-400 cursor-pointer flex items-center">
              {moment(effectiveDate).fromNow()}
            </span>
          </Tooltip>
        </div>
        <div className="mb-2 space-y-1">
          {cap.ownerName && (
            <div className="flex gap-2 items-center">
              <FontAwesomeIcon icon={faUser} className="text-gray-400 size-3" />
              <span className="text-sm text-gray-400">{cap.ownerName}</span>
            </div>
          )}
          <div className="flex gap-2 items-center">
            <FontAwesomeIcon
              icon={faBuilding}
              className="text-gray-400 size-2.5"
            />
            <p className="text-sm text-gray-400">
              Shared with{" "}
              <span className="text-sm font-medium text-gray-500">
                {spaceName}
              </span>
            </p>
          </div>
        </div>
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
