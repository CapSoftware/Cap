import { VideoMetadata } from "@cap/database/types";
import { faBuilding, faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { CapCard } from "../../../caps/components/CapCard";

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
  organizationName: string;
  userId?: string;
}

export const SharedCapCard: React.FC<SharedCapCardProps> = ({
  cap,
  analytics,
  organizationName,
  userId,
}) => {
  const displayCount =
    analytics === 0
      ? Math.max(cap.totalComments, cap.totalReactions)
      : analytics;

  return (
    <CapCard cap={cap} analytics={displayCount} sharedCapCard userId={userId}>
      <div className="mb-2 space-y-1">
        {cap.ownerName && (
          <div className="flex gap-2 items-center">
            <FontAwesomeIcon icon={faUser} className="text-gray-10 size-3" />
            <span className="text-sm text-gray-10">{cap.ownerName}</span>
          </div>
        )}
        <div className="flex gap-2 items-center">
          <FontAwesomeIcon
            icon={faBuilding}
            className="text-gray-10 size-2.5"
          />
          <p className="text-sm pointer-events-none text-gray-10">
            Shared with{" "}
            <span className="text-sm font-medium text-gray-12">
              {organizationName}
            </span>
          </p>
        </div>
      </div>
    </CapCard>
  );
};
