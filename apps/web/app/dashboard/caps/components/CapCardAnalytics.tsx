import { Tooltip } from "@/components/Tooltip";
import { faComment, faEye, faSmile } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface CapCardAnalyticsProps {
  capId: string;
  displayCount: number;
  totalComments: number;
  totalReactions: number;
}

export const CapCardAnalytics: React.FC<CapCardAnalyticsProps> = ({
  capId,
  displayCount,
  totalComments,
  totalReactions,
}) => {
  return (
    <div className="flex flex-wrap gap-4 items-center text-sm text-gray-60">
      <Tooltip content={`${displayCount} unique views`}>
        <div className="flex gap-1 items-center">
          <FontAwesomeIcon className="text-gray-400 size-4" icon={faEye} />
          <span className="text-sm text-gray-500">{displayCount ?? "-"}</span>
        </div>
      </Tooltip>
      <Tooltip content={`${totalComments} comments`}>
        <div className="flex gap-1 items-center">
          <FontAwesomeIcon className="text-gray-400 size-4" icon={faComment} />
          <span className="text-sm text-gray-500">{totalComments}</span>
        </div>
      </Tooltip>
      <Tooltip content={`${totalReactions} reactions`}>
        <div className="flex gap-1 items-center">
          <FontAwesomeIcon className="text-gray-400 size-4" icon={faSmile} />
          <span className="text-sm text-gray-500">{totalReactions}</span>
        </div>
      </Tooltip>
    </div>
  );
};
